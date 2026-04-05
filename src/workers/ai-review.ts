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
      await processAIReviewJob(prisma, job.data, webhookQueue);
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

/** Core processing logic — exported for testing */
export async function processAIReviewJob(
  prisma: PrismaClient,
  data: AIReviewJobData,
  webhookQueue?: Queue<WebhookJobData>,
): Promise<void> {
  const { submissionId, content, metadata, channel, contentType, reviewMode, callbackUrl } = data;

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

    const rawBody = (await resp.json()) as Record<string, unknown>;
    aiResponse = validateAIResponse(rawBody);
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
    // AI verdict is final; escalated falls back to pending for human review (fail-open)
    finalDecision =
      aiResponse.decision === "approved" || aiResponse.decision === "rejected"
        ? aiResponse.decision
        : "escalated";
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

  // Atomic: check guards + create review + update submission in transaction
  const wrote = await prisma.$transaction(async (tx) => {
    // Check submission is still pending (guard against race with human review)
    const current = await tx.submission.findUnique({
      where: { id: submissionId },
      select: { status: true },
    });
    if (!current || current.status !== "pending") {
      return false;
    }

    // Idempotency guard for BullMQ retries
    const existing = await tx.review.findFirst({
      where: { submissionId, reviewerType: "ai" },
    });
    if (existing) {
      return false;
    }

    // Store AI review record
    await tx.review.create({
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

    // Update submission status for terminal decisions
    if (finalDecision === "approved" || finalDecision === "rejected") {
      await tx.submission.update({
        where: { id: submissionId },
        data: {
          status: finalDecision,
          decidedAt: new Date(),
          decidedBy: "ai",
        },
      });
    }

    return true;
  });

  if (!wrote) {
    return;
  }

  // Trigger webhook if callback_url exists and decision is terminal
  if (
    webhookQueue &&
    callbackUrl &&
    (finalDecision === "approved" || finalDecision === "rejected")
  ) {
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
}

export function validateAIResponse(raw: Record<string, unknown>): AIAdapterResponse {
  const { decision, confidence, reasoning, categories, model_id } = raw;

  if (decision !== "approved" && decision !== "rejected" && decision !== "escalated") {
    throw new Error(`Invalid AI decision: ${String(decision)}`);
  }
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    throw new Error(`Invalid AI confidence: ${String(confidence)}`);
  }
  if (typeof reasoning !== "string") {
    throw new Error(`Invalid AI reasoning: expected string`);
  }

  return {
    decision,
    confidence,
    reasoning,
    categories: Array.isArray(categories) ? (categories as string[]) : undefined,
    model_id: typeof model_id === "string" ? model_id : undefined,
  };
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
