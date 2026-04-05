import { Queue, Worker } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client.js";
import { recordAuditEvent } from "../services/audit.js";
import type { NotificationJobData } from "./notification.js";
import { enqueueNotification } from "./notification.js";
import type { WebhookJobData } from "./webhook.js";
import { enqueueWebhook } from "./webhook.js";

export const ESCALATION_QUEUE_NAME = "escalation";

export function createEscalationWorker(
  prisma: PrismaClient,
  redisUrl: string,
  notificationQueue: Queue<NotificationJobData>,
  webhookQueue: Queue<WebhookJobData>,
): Worker {
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: parseInt(url.port || "6379", 10),
  };

  // Create the queue with repeatable job (every 60 seconds)
  const queue = new Queue(ESCALATION_QUEUE_NAME, { connection });
  queue.upsertJobScheduler(
    "escalation-check",
    { every: 60000 },
    {
      name: "check-sla",
    },
  );

  const worker = new Worker(
    ESCALATION_QUEUE_NAME,
    async () => {
      await checkEscalations(prisma, notificationQueue, webhookQueue);
    },
    { connection },
  );

  worker.on("failed", (_job, err) => {
    console.error(`Escalation check failed: ${err.message}`);
  });

  return worker;
}

/** Core escalation logic — exported for testing */
export async function checkEscalations(
  prisma: PrismaClient,
  notificationQueue: Queue<NotificationJobData>,
  webhookQueue: Queue<WebhookJobData>,
): Promise<void> {
  const configs = await prisma.escalationConfig.findMany({
    where: { active: true },
  });

  if (configs.length === 0) {
    return;
  }

  const now = new Date();

  for (const config of configs) {
    // Find pending submissions past SLA
    const slaCutoff = new Date(now.getTime() - config.slaMinutes * 60 * 1000);
    const timeoutCutoff = new Date(
      now.getTime() - (config.slaMinutes + config.timeoutMinutes) * 60 * 1000,
    );

    const overdueSubmissions = await prisma.submission.findMany({
      where: {
        status: "pending",
        createdAt: { lt: slaCutoff },
      },
      select: {
        id: true,
        content: true,
        channel: true,
        contentType: true,
        callbackUrl: true,
        createdAt: true,
      },
    });

    for (const submission of overdueSubmissions) {
      const isPastTimeout = submission.createdAt < timeoutCutoff;

      if (isPastTimeout) {
        // Auto-decide: timeout action
        await applyTimeoutAction(prisma, submission, config, webhookQueue);
      } else {
        // Escalation: send notification if not already escalated
        await escalateSubmission(prisma, submission, config, notificationQueue);
      }
    }
  }
}

async function escalateSubmission(
  prisma: PrismaClient,
  submission: {
    id: string;
    content: unknown;
    channel: string;
    contentType: string;
    createdAt: Date;
  },
  config: {
    id: string;
    slaMinutes: number;
    escalationChannel: string;
    escalationTarget: string;
  },
  notificationQueue: Queue<NotificationJobData>,
): Promise<void> {
  // Check if already escalated (idempotency)
  const existingEscalation = await prisma.auditEvent.findFirst({
    where: {
      submissionId: submission.id,
      eventType: "escalation.triggered",
    },
  });
  if (existingEscalation) {
    return;
  }

  // Build content preview
  const contentPreview =
    typeof submission.content === "string"
      ? submission.content
      : JSON.stringify(submission.content);

  // Generate action tokens for the escalation notification
  const { randomBytes } = await import("node:crypto");
  const { actionTokens } = await import("../routes/reviews.js");
  const approveToken = randomBytes(32).toString("hex");
  const rejectToken = randomBytes(32).toString("hex");
  const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
  const expiresAt = Date.now() + TOKEN_TTL_MS;

  actionTokens.set(approveToken, {
    submissionId: submission.id,
    decision: "approved",
    expiresAt,
  });
  actionTokens.set(rejectToken, {
    submissionId: submission.id,
    decision: "rejected",
    expiresAt,
  });

  const now = new Date();
  const slaBreach = Math.round((now.getTime() - submission.createdAt.getTime()) / 60000);

  try {
    await enqueueNotification(notificationQueue, {
      submissionId: submission.id,
      contentPreview,
      channel: submission.channel,
      contentType: submission.contentType,
      policyFlags: [],
      guardrailFlags: [],
      approveToken,
      rejectToken,
      tokenExpiresAt: new Date(expiresAt).toISOString(),
    });
  } catch (err) {
    console.error(`Failed to enqueue escalation notification for ${submission.id}:`, err);
  }

  // Record escalation event
  try {
    await recordAuditEvent(prisma, {
      eventType: "escalation.triggered",
      submissionId: submission.id,
      actor: "escalation-service",
      actorType: "system",
      payload: {
        escalation_config_id: config.id,
        sla_minutes: config.slaMinutes,
        sla_breach_minutes: slaBreach,
        escalation_channel: config.escalationChannel,
        escalation_target: config.escalationTarget,
      },
    });
  } catch {
    // Best-effort
  }
}

async function applyTimeoutAction(
  prisma: PrismaClient,
  submission: {
    id: string;
    callbackUrl: string | null;
  },
  config: {
    id: string;
    slaMinutes: number;
    timeoutAction: string;
    timeoutMinutes: number;
  },
  webhookQueue: Queue<WebhookJobData>,
): Promise<void> {
  const decision = config.timeoutAction === "auto_approve" ? "approved" : "rejected";
  const now = new Date();

  // Atomic check-and-update to prevent race with concurrent human review
  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.submission.findUnique({
      where: { id: submission.id },
      select: { status: true },
    });
    if (!current || current.status !== "pending") {
      return null;
    }

    return tx.submission.update({
      where: { id: submission.id },
      data: {
        status: decision,
        decidedAt: now,
        decidedBy: "system",
      },
    });
  });

  if (!updated) {
    return;
  }

  // Record audit event
  try {
    await recordAuditEvent(prisma, {
      eventType: decision === "approved" ? "submission.auto_approved" : "submission.auto_rejected",
      submissionId: submission.id,
      actor: "escalation-service",
      actorType: "system",
      payload: {
        escalation_config_id: config.id,
        timeout_action: config.timeoutAction,
        sla_minutes: config.slaMinutes,
        timeout_minutes: config.timeoutMinutes,
        reason: "escalation_timeout",
      },
    });
  } catch {
    // Best-effort
  }

  // Trigger webhook if callback_url exists
  if (webhookQueue && submission.callbackUrl) {
    try {
      await enqueueWebhook(webhookQueue, {
        submissionId: submission.id,
        callbackUrl: submission.callbackUrl,
        payload: {
          submission_id: submission.id,
          decision,
          decided_by: "system",
          decided_at: now.toISOString(),
          timestamp: now.toISOString(),
        },
      });
    } catch {
      // Best-effort
    }
  }
}
