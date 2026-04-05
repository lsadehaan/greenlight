import { createHmac } from "node:crypto";
import { Queue, Worker } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client.js";
import { config } from "../config.js";

export const WEBHOOK_QUEUE_NAME = "webhook-delivery";

export interface WebhookJobData {
  submissionId: string;
  callbackUrl: string;
  payload: {
    submission_id: string;
    decision: string;
    reviewer_type?: string;
    reviewer_identity?: string;
    policy_results?: Array<{
      policy_name: string;
      result: string;
      action: string;
    }>;
    decided_by?: string;
    decided_at: string;
    timestamp: string;
  };
}

export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function createWebhookQueue(redisUrl: string): Queue<WebhookJobData> {
  const url = new URL(redisUrl);
  return new Queue(WEBHOOK_QUEUE_NAME, {
    connection: {
      host: url.hostname,
      port: parseInt(url.port || "6379", 10),
    },
  });
}

export async function enqueueWebhook(
  queue: Queue<WebhookJobData>,
  data: WebhookJobData,
): Promise<void> {
  await queue.add("deliver", data, {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  });
}

async function deliverWebhook(
  callbackUrl: string,
  payload: string,
  secret: string,
): Promise<{ ok: boolean; status: number }> {
  const signature = signPayload(payload, secret);

  const resp = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Greenlight-Signature": `sha256=${signature}`,
    },
    body: payload,
    signal: AbortSignal.timeout(10000),
  });

  return { ok: resp.ok, status: resp.status };
}

export function createWebhookWorker(
  prisma: PrismaClient,
  redisUrl: string,
): Worker<WebhookJobData> {
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: parseInt(url.port || "6379", 10),
  };

  const worker = new Worker<WebhookJobData>(
    WEBHOOK_QUEUE_NAME,
    async (job) => {
      const { submissionId, callbackUrl, payload } = job.data;
      const payloadStr = JSON.stringify(payload);

      const result = await deliverWebhook(callbackUrl, payloadStr, config.webhookSecret);

      if (!result.ok) {
        throw new Error(`Webhook delivery failed with status ${result.status}`);
      }

      // Mark as delivered
      await prisma.submission.update({
        where: { id: submissionId },
        data: { callbackStatus: "delivered" },
      });
    },
    { connection },
  );

  worker.on("failed", async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
      // All retries exhausted
      try {
        await prisma.submission.update({
          where: { id: job.data.submissionId },
          data: { callbackStatus: "failed" },
        });
      } catch {
        // Best-effort status update
      }
      console.error(
        `Webhook delivery permanently failed for submission ${job.data.submissionId}: ${err.message}`,
      );
    } else if (job) {
      console.warn(
        `Webhook delivery attempt ${job.attemptsMade} failed for submission ${job.data.submissionId}: ${err.message}. Retrying...`,
      );
    }
  });

  return worker;
}
