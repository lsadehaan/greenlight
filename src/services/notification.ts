import { randomBytes } from "node:crypto";
import type { Queue } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { PolicyResult } from "../engine/policy.js";
import type { GuardrailResult } from "../engine/guardrail.js";
import type { NotificationJobData } from "../workers/notification.js";
import { enqueueNotification } from "../workers/notification.js";

// Re-export the in-memory token store from reviews for token generation
// The review-actions router consumes these tokens
import { actionTokens } from "../routes/reviews.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function notifyReviewers(
  prisma: PrismaClient,
  notificationQueue: Queue<NotificationJobData>,
  submission: {
    id: string;
    content: unknown;
    channel: string;
    contentType: string;
  },
  policyResults: PolicyResult[],
  guardrailResults: GuardrailResult[],
): Promise<void> {
  // Check if any active notification channels exist
  const channelCount = await prisma.notificationChannel.count({ where: { active: true } });
  if (channelCount === 0) {
    return;
  }

  // Generate single-use action tokens
  const approveToken = randomBytes(32).toString("hex");
  const rejectToken = randomBytes(32).toString("hex");
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

  // Build content preview
  const contentPreview =
    typeof submission.content === "string"
      ? submission.content
      : JSON.stringify(submission.content);

  // Extract policy flags (only matched policies with flag/block actions)
  const policyFlags = policyResults
    .filter((r) => r.result === "match")
    .map((r) => ({
      policy_name: r.policyName,
      action: r.action,
      detail: r.detail,
    }));

  // Extract guardrail flags (non-pass verdicts)
  const guardrailFlags = guardrailResults
    .filter((r) => r.verdict !== "pass")
    .map((r) => ({
      guardrail_name: r.guardrailName,
      verdict: r.verdict,
      reasoning: r.reasoning,
    }));

  await enqueueNotification(notificationQueue, {
    submissionId: submission.id,
    contentPreview,
    channel: submission.channel,
    contentType: submission.contentType,
    policyFlags,
    guardrailFlags,
    approveToken,
    rejectToken,
    tokenExpiresAt: new Date(expiresAt).toISOString(),
  });
}
