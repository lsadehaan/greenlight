import { Queue, Worker } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client.js";
import { recordAuditEvent } from "../services/audit.js";

export const RETENTION_QUEUE_NAME = "data-retention";
const BATCH_SIZE = 1000;

export function createRetentionWorker(
  prisma: PrismaClient,
  redisUrl: string,
  retentionDays: number,
): Worker {
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: parseInt(url.port || "6379", 10),
  };

  // Schedule daily cleanup at midnight
  const queue = new Queue(RETENTION_QUEUE_NAME, { connection });
  queue.upsertJobScheduler(
    "daily-retention-cleanup",
    { pattern: "0 0 * * *" },
    { name: "cleanup" },
  );

  const worker = new Worker(
    RETENTION_QUEUE_NAME,
    async () => {
      await runCleanup(prisma, retentionDays);
    },
    { connection },
  );

  worker.on("failed", (_job, err) => {
    console.error(`Retention cleanup failed: ${err.message}`);
  });

  return worker;
}

export interface CleanupResult {
  submissions: number;
  auditEvents: number;
}

/** Core cleanup logic — exported for testing and manual trigger */
export async function runCleanup(
  prisma: PrismaClient,
  retentionDays: number,
): Promise<CleanupResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const result: CleanupResult = { submissions: 0, auditEvents: 0 };

  // Delete expired submissions in batches (excluding pending).
  // Uses interactive transaction so findMany + deleteMany are atomic,
  // preventing TOCTOU races if child records are inserted concurrently.
  let hasMore = true;
  while (hasMore) {
    const deleted = await prisma.$transaction(async (tx) => {
      const batch = await tx.submission.findMany({
        where: {
          createdAt: { lt: cutoff },
          status: { not: "pending" },
        },
        select: { id: true },
        take: BATCH_SIZE,
      });

      if (batch.length === 0) return 0;

      const ids = batch.map((s) => s.id);

      // Delete child records then submissions
      await tx.policyEvaluation.deleteMany({ where: { submissionId: { in: ids } } });
      await tx.guardrailEvaluation.deleteMany({ where: { submissionId: { in: ids } } });
      await tx.review.deleteMany({ where: { submissionId: { in: ids } } });
      await tx.feedback.deleteMany({ where: { submissionId: { in: ids } } });
      await tx.auditEvent.deleteMany({ where: { submissionId: { in: ids } } });
      const { count } = await tx.submission.deleteMany({ where: { id: { in: ids } } });
      return count;
    });

    result.submissions += deleted;

    if (deleted < BATCH_SIZE) {
      hasMore = false;
    }
  }

  // Delete orphaned audit events (not tied to a submission) older than retention
  hasMore = true;
  while (hasMore) {
    const batchCount = Number(await prisma.$executeRaw`
      DELETE FROM audit_event
      WHERE id IN (
        SELECT id FROM audit_event
        WHERE submission_id IS NULL
          AND created_at < ${cutoff}
        LIMIT ${BATCH_SIZE}
      )
    `);

    result.auditEvents += batchCount;
    if (batchCount < BATCH_SIZE) {
      hasMore = false;
    }
  }

  console.log(
    `Retention cleanup: removed ${result.submissions} submissions, ${result.auditEvents} orphaned audit events (cutoff: ${cutoff.toISOString()})`,
  );

  await recordAuditEvent(prisma, {
    eventType: "retention.cleanup",
    actorType: "system",
    actor: "retention-worker",
    payload: {
      retention_days: retentionDays,
      cutoff: cutoff.toISOString(),
      deleted_submissions: result.submissions,
      deleted_audit_events: result.auditEvents,
    },
  });

  return result;
}
