import { Router } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { recordAuditEvent } from "../services/audit.js";

const VALID_REVIEW_MODES = ["human_only", "ai_only", "ai_then_human"] as const;
type ReviewMode = (typeof VALID_REVIEW_MODES)[number];

const SINGLETON_ID = "00000000-0000-0000-0000-000000000001";

export function createReviewConfigRouter(prisma: PrismaClient): Router {
  const router = Router();

  // GET /api/v1/review-config — return current config
  router.get("/", async (_req, res) => {
    let config = await prisma.reviewConfig.findUnique({ where: { id: SINGLETON_ID } });

    if (!config) {
      // Create default if missing (defensive — seed should have created it)
      config = await prisma.reviewConfig.create({
        data: {
          id: SINGLETON_ID,
          defaultReviewMode: "human_only",
          aiConfidenceThreshold: 0.8,
          aiReviewerTimeoutMs: 10000,
          guardrailPipelineEnabled: false,
        },
      });
    }

    res.json(formatConfig(config));
  });

  // PUT /api/v1/review-config — update config
  router.put("/", async (req, res) => {
    const body = req.body as Record<string, unknown>;

    const error = validateUpdate(body);
    if (error) {
      res.status(400).json({ error: "bad_request", message: error });
      return;
    }

    // If setting ai_only or ai_then_human, ai_reviewer_endpoint must be provided or already set
    const mode = body.default_review_mode as ReviewMode | undefined;
    if (mode === "ai_only" || mode === "ai_then_human") {
      const endpoint = body.ai_reviewer_endpoint as string | undefined;
      if (!endpoint) {
        // Check if one is already stored
        const existing = await prisma.reviewConfig.findUnique({
          where: { id: SINGLETON_ID },
          select: { aiReviewerEndpoint: true },
        });
        if (!existing?.aiReviewerEndpoint) {
          res.status(400).json({
            error: "bad_request",
            message: "ai_reviewer_endpoint is required when review mode uses AI",
          });
          return;
        }
      }
    }

    // Build update data
    const data: Record<string, unknown> = {};
    if (body.default_review_mode !== undefined) {
      data.defaultReviewMode = body.default_review_mode;
    }
    if (body.ai_confidence_threshold !== undefined) {
      data.aiConfidenceThreshold = body.ai_confidence_threshold;
    }
    if (body.ai_reviewer_endpoint !== undefined) {
      data.aiReviewerEndpoint = body.ai_reviewer_endpoint;
    }
    if (body.ai_reviewer_timeout_ms !== undefined) {
      data.aiReviewerTimeoutMs = body.ai_reviewer_timeout_ms;
    }
    if (body.ai_reviewer_model !== undefined) {
      data.aiReviewerModel = body.ai_reviewer_model;
    }
    if (body.guardrail_pipeline_enabled !== undefined) {
      data.guardrailPipelineEnabled = body.guardrail_pipeline_enabled;
    }
    if (body.tiers_enabled !== undefined) {
      const tiers = body.tiers_enabled as Record<string, boolean>;
      // Store with keys the pipeline reads: rules, guardrails, ai, human
      data.tierConfig = {
        rules: tiers.rules !== false,
        guardrails: tiers.guardrails === true,
        ai: tiers.ai_review === true,
        human: tiers.human_review !== false,
      };
    }

    // Upsert to handle missing singleton gracefully
    const config = await prisma.reviewConfig.upsert({
      where: { id: SINGLETON_ID },
      update: data,
      create: {
        id: SINGLETON_ID,
        defaultReviewMode: "human_only",
        aiConfidenceThreshold: 0.8,
        aiReviewerTimeoutMs: 10000,
        guardrailPipelineEnabled: false,
        ...data,
      },
    });

    // Audit the persisted config change (not raw request body)
    try {
      await recordAuditEvent(prisma, {
        eventType: "review_config.updated",
        actorType: "human",
        actor: req.apiKey?.name ?? "unknown",
        payload: data,
      });
    } catch {
      // Best-effort
    }

    res.json(formatConfig(config));
  });

  return router;
}

function validateUpdate(body: Record<string, unknown>): string | null {
  if (
    body.default_review_mode !== undefined &&
    !VALID_REVIEW_MODES.includes(body.default_review_mode as ReviewMode)
  ) {
    return `default_review_mode must be one of: ${VALID_REVIEW_MODES.join(", ")}`;
  }

  if (body.ai_confidence_threshold !== undefined) {
    const val = body.ai_confidence_threshold;
    if (typeof val !== "number" || val < 0 || val > 1) {
      return "ai_confidence_threshold must be a number between 0 and 1";
    }
  }

  if (body.ai_reviewer_timeout_ms !== undefined) {
    const val = body.ai_reviewer_timeout_ms;
    if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
      return "ai_reviewer_timeout_ms must be a positive integer";
    }
  }

  if (body.ai_reviewer_endpoint !== undefined && body.ai_reviewer_endpoint !== null) {
    if (typeof body.ai_reviewer_endpoint !== "string" || body.ai_reviewer_endpoint.length === 0) {
      return "ai_reviewer_endpoint must be a non-empty string or null";
    }
  }

  if (body.ai_reviewer_model !== undefined && body.ai_reviewer_model !== null) {
    if (typeof body.ai_reviewer_model !== "string" || body.ai_reviewer_model.length === 0) {
      return "ai_reviewer_model must be a non-empty string or null";
    }
  }

  if (body.guardrail_pipeline_enabled !== undefined) {
    if (typeof body.guardrail_pipeline_enabled !== "boolean") {
      return "guardrail_pipeline_enabled must be a boolean";
    }
  }

  if (body.tiers_enabled !== undefined) {
    if (typeof body.tiers_enabled !== "object" || body.tiers_enabled === null || Array.isArray(body.tiers_enabled)) {
      return "tiers_enabled must be an object";
    }
  }

  return null;
}

function formatConfig(config: {
  id: string;
  defaultReviewMode: string;
  aiConfidenceThreshold: number;
  aiReviewerEndpoint: string | null;
  aiReviewerTimeoutMs: number;
  aiReviewerModel: string | null;
  guardrailPipelineEnabled: boolean;
  tierConfig: unknown;
  updatedAt: Date;
}) {
  const tiers = config.tierConfig as Record<string, boolean> | null;
  return {
    default_review_mode: config.defaultReviewMode,
    ai_confidence_threshold: config.aiConfidenceThreshold,
    ai_reviewer_endpoint: config.aiReviewerEndpoint,
    ai_reviewer_timeout_ms: config.aiReviewerTimeoutMs,
    ai_reviewer_model: config.aiReviewerModel,
    guardrail_pipeline_enabled: config.guardrailPipelineEnabled,
    tiers_enabled: {
      rules: tiers?.rules !== false,
      guardrails: tiers?.guardrails === true,
      ai_review: tiers?.ai === true,
      human_review: tiers?.human !== false,
    },
    updated_at: config.updatedAt.toISOString(),
  };
}
