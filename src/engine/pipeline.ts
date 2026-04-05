import type { Queue } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client.js";
import { evaluatePolicies } from "./policy.js";
import type { PolicyResult } from "./policy.js";
import { evaluateGuardrails } from "./guardrail.js";
import type { GuardrailResult } from "./guardrail.js";
import { enqueueAIReview } from "../workers/ai-review.js";
import type { AIReviewJobData } from "../workers/ai-review.js";

export interface TierConfig {
  rules: boolean;
  guardrails: boolean;
  ai: boolean;
  human: boolean;
}

export interface PipelineInput {
  submissionId: string;
  content: string;
  metadata: Record<string, unknown>;
  channel: string;
  contentType: string;
  callbackUrl: string | null;
}

export interface PipelineResult {
  status: "approved" | "rejected" | "pending";
  decidedBy: string | null;
  decidedAt: Date | null;
  policyResults: PolicyResult[];
  guardrailResults: GuardrailResult[];
  aiEnqueued: boolean;
  reviewMode: "human_only" | "ai_only" | "ai_then_human" | null;
  tierConfig: TierConfig;
}

export function resolveTierConfig(config: {
  defaultReviewMode: string;
  guardrailPipelineEnabled: boolean;
  tierConfig?: unknown;
}): TierConfig {
  // Explicit tierConfig overrides defaults
  if (
    config.tierConfig &&
    typeof config.tierConfig === "object" &&
    !Array.isArray(config.tierConfig)
  ) {
    const tc = config.tierConfig as Record<string, unknown>;
    return {
      rules: tc.rules !== false,
      guardrails: tc.guardrails === true,
      ai: tc.ai === true,
      human: tc.human !== false,
    };
  }

  // Derive from existing config fields
  const mode = config.defaultReviewMode;
  return {
    rules: true,
    guardrails: config.guardrailPipelineEnabled,
    ai: mode === "ai_only" || mode === "ai_then_human",
    human: mode === "human_only" || mode === "ai_then_human",
  };
}

export async function evaluatePipeline(
  prisma: PrismaClient,
  input: PipelineInput,
  aiReviewQueue?: Queue<AIReviewJobData>,
): Promise<PipelineResult> {
  // Load review config
  const config = await prisma.reviewConfig.findFirst();
  const reviewMode = (config?.defaultReviewMode ?? "human_only") as
    | "human_only"
    | "ai_only"
    | "ai_then_human";
  const tiers = config
    ? resolveTierConfig(config)
    : { rules: true, guardrails: false, ai: false, human: true };

  const result: PipelineResult = {
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    policyResults: [],
    guardrailResults: [],
    aiEnqueued: false,
    reviewMode,
    tierConfig: tiers,
  };

  // ── Tier 1: Rules (Policy Engine) ──────────────────────────────────────
  if (tiers.rules) {
    result.policyResults = await evaluatePolicies(prisma, {
      content: input.content,
      metadata: input.metadata,
      channel: input.channel,
      contentType: input.contentType,
    });

    const hasBlock = result.policyResults.some((r) => r.result === "match" && r.action === "block");
    if (hasBlock) {
      result.status = "rejected";
      result.decidedBy = "rules";
      result.decidedAt = new Date();
      return result;
    }

    const hasFlag = result.policyResults.some((r) => r.result === "match" && r.action === "flag");
    if (!hasFlag) {
      // All policies passed — auto-approve
      result.status = "approved";
      result.decidedBy = "rules";
      result.decidedAt = new Date();
      return result;
    }
    // Flagged → escalate to next tier
  }

  // ── Tier 2: Guardrails ─────────────────────────────────────────────────
  if (tiers.guardrails) {
    result.guardrailResults = await evaluateGuardrails(prisma, {
      submissionId: input.submissionId,
      content: input.content,
      metadata: input.metadata,
      channel: input.channel,
      contentType: input.contentType,
    });

    const hasFail = result.guardrailResults.some((r) => r.verdict === "fail");
    if (hasFail) {
      result.status = "rejected";
      result.decidedBy = "guardrails";
      result.decidedAt = new Date();
      return result;
    }
    // All pass/flag → escalate to next tier
  }

  // ── Tier 3: AI Review (async) ──────────────────────────────────────────
  if (tiers.ai && aiReviewQueue) {
    const aiMode = reviewMode === "ai_only" ? "ai_only" : "ai_then_human";
    await enqueueAIReview(aiReviewQueue, {
      submissionId: input.submissionId,
      content: input.content,
      metadata: input.metadata,
      channel: input.channel,
      contentType: input.contentType,
      reviewMode: aiMode,
      callbackUrl: input.callbackUrl,
    });
    result.aiEnqueued = true;
    // Status stays pending — AI worker will update asynchronously
    return result;
  }

  // ── Tier 4: Human Review ───────────────────────────────────────────────
  // Status stays pending — human reviewer acts later
  return result;
}
