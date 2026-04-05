import { Queue, Worker } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client.js";
import { recordAuditEvent } from "../services/audit.js";
import { enqueueWebhook } from "./webhook.js";
import type { WebhookJobData } from "./webhook.js";

export const AI_REVIEW_QUEUE_NAME = "ai-review";

export interface AIReviewJobData {
  submissionId: string;
  content: string;
  metadata: Record<string, unknown>;
  channel: string;
  contentType: string;
  reviewMode: "ai_only" | "ai_then_human";
  callbackUrl: string | null;
}

interface AIAdapterResponse {
  decision: "approved" | "rejected" | "escalated";
  confidence: number;
  reasoning: string;
  categories?: string[];
  model_id?: string;
}

export function createAIReviewQueue(redisUrl: string): Queue<AIReviewJobData> {
  const url = new URL(redisUrl);
  return new Queue(AI_REVIEW_QUEUE_NAME, {
    connection: {
      host: url.hostname,
      port: parseInt(url.port || "6379", 10),
    },
  });
}

export async function enqueueAIReview(
  queue: Queue<AIReviewJobData>,
  data: AIReviewJobData,
): Promise<void> {
  await queue.add("ai-review", data, {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  });
}

export function createAIReviewWorker(
  prisma: PrismaClient,
  redisUrl: string,
  webhookQueue?: Queue<WebhookJobData>,
): Worker<AIReviewJobData> {
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: parseInt(url.port || "6379", 10),
  };

  const worker = new Worker<AIReviewJobData>(
    AI_REVIEW_QUEUE_NAME,
    async (job) => {
      const { submissionId, content, metadata, channel, contentType, reviewMode, callbackUrl } =
        job.data;

      // Load review config
      const config = await prisma.reviewConfig.findFirst();
      if (!config?.aiReviewerEndpoint) {
        // No AI endpoint configured — escalate to human
        await escalateToHuman(prisma, submissionId, "No AI reviewer endpoint configured");
        return;
      }

      const timeoutMs = config.aiReviewerTimeoutMs || 15000;
      const threshold = config.aiConfidenceThreshold ?? 0.8;
      const start = Date.now();

      let aiResponse: AIAdapterResponse;

      try {
        const resp = await fetch(config.aiReviewerEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            submission_id: submissionId,
            content,
            metadata,
            channel,
            content_type: contentType,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!resp.ok) {
          throw new Error(`AI reviewer returned status ${resp.status}`);
        }

        aiResponse = (await resp.json()) as AIAdapterResponse;
      } catch (err) {
        const latencyMs = Date.now() - start;
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Fail open: escalate to human review
        await escalateToHuman(prisma, submissionId, `AI review failed: ${errorMsg}`);

        // Audit the failure
        try {
          await recordAuditEvent(prisma, {
            eventType: "review.escalated",
            submissionId,
            actor: "ai-reviewer",
            actorType: "ai",
            payload: { error: errorMsg, latency_ms: latencyMs, reason: "ai_failure" },
          });
        } catch {
          // Best-effort
        }

        return;
      }

      const latencyMs = Date.now() - start;
      const modelId = aiResponse.model_id ?? config.aiReviewerModel ?? "unknown";

      // Determine final decision based on review mode
      let finalDecision: "approved" | "rejected" | "escalated";

      if (reviewMode === "ai_only") {
        // AI verdict is final (approve or reject only)
        finalDecision =
          aiResponse.decision === "approved" || aiResponse.decision === "rejected"
            ? aiResponse.decision
            : "rejected"; // treat escalated as rejected in ai_only mode
      } else {
        // ai_then_human mode
        if (aiResponse.confidence >= threshold) {
          finalDecision =
            aiResponse.decision === "approved" || aiResponse.decision === "rejected"
              ? aiResponse.decision
              : "escalated";
        } else {
          // Low confidence — escalate to human
          finalDecision = "escalated";
        }
      }

      // Store AI review record
      await prisma.review.create({
        data: {
          submissionId,
          reviewerType: "ai",
          reviewerIdentity: modelId,
          decision: finalDecision,
          confidence: aiResponse.confidence,
          reasoning: aiResponse.reasoning,
          aiMetadata: {
            model_id: modelId,
            categories: aiResponse.categories ?? [],
            latency_ms: latencyMs,
          } as object,
        },
      });

      // Update submission status
      if (finalDecision === "approved" || finalDecision === "rejected") {
        await prisma.submission.update({
          where: { id: submissionId },
          data: {
            status: finalDecision,
            decidedAt: new Date(),
          },
        });

        // Trigger webhook if callback_url exists
        if (webhookQueue && callbackUrl) {
          try {
            const now = new Date();
            await enqueueWebhook(webhookQueue, {
              submissionId,
              callbackUrl,
              payload: {
                submission_id: submissionId,
                decision: finalDecision,
                reviewer_type: "ai",
                reviewer_identity: modelId,
                decided_at: now.toISOString(),
                timestamp: now.toISOString(),
              },
            });
          } catch {
            // Best-effort webhook
          }
        }
      } else {
        // Escalated — leave as pending for human review
        // Submission status stays "pending"
      }

      // Audit event
      try {
        await recordAuditEvent(prisma, {
          eventType: finalDecision === "escalated" ? "review.escalated" : "review.created",
          submissionId,
          actor: modelId,
          actorType: "ai",
          payload: {
            decision: finalDecision,
            confidence: aiResponse.confidence,
            reasoning: aiResponse.reasoning,
            latency_ms: latencyMs,
            review_mode: reviewMode,
          },
        });
      } catch {
        // Best-effort
      }
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    if (job) {
      console.error(
        `AI review job failed for submission ${job.data.submissionId} (attempt ${job.attemptsMade}): ${err.message}`,
      );
    }
  });

  return worker;
}

async function escalateToHuman(
  prisma: PrismaClient,
  submissionId: string,
  reason: string,
): Promise<void> {
  // Create an escalated AI review record
  await prisma.review.create({
    data: {
      submissionId,
      reviewerType: "ai",
      reviewerIdentity: "ai-reviewer",
      decision: "escalated",
      reasoning: reason,
    },
  });
  // Submission status stays pending — human review needed
}
