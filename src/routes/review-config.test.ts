import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createReviewConfigRouter } from "./review-config.js";

vi.mock("../services/audit.js", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { recordAuditEvent } from "../services/audit.js";
const mockedRecordAudit = vi.mocked(recordAuditEvent);

const SINGLETON_ID = "00000000-0000-0000-0000-000000000001";

const defaultConfig = {
  id: SINGLETON_ID,
  defaultReviewMode: "human_only",
  aiConfidenceThreshold: 0.8,
  aiReviewerEndpoint: null,
  aiReviewerTimeoutMs: 10000,
  aiReviewerModel: null,
  guardrailPipelineEnabled: false,
  tierConfig: null,
  updatedAt: new Date("2026-04-05T00:00:00Z"),
};

function buildApp(mockPrisma: Record<string, unknown>) {
  const prisma = mockPrisma as unknown as Parameters<typeof createReviewConfigRouter>[0];
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    _req.apiKey = { id: "api-key-1", name: "test-key" };
    next();
  });
  app.use("/api/v1/review-config", createReviewConfigRouter(prisma));
  return app;
}

function baseMocks() {
  return {
    reviewConfig: {
      findUnique: vi.fn().mockResolvedValue(defaultConfig),
      create: vi.fn().mockResolvedValue(defaultConfig),
      update: vi.fn().mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          ...defaultConfig,
          ...data,
          updatedAt: new Date("2026-04-05T01:00:00Z"),
        }),
      ),
      upsert: vi.fn().mockImplementation(
        async ({ update: data }: { update: Record<string, unknown> }) => ({
          ...defaultConfig,
          ...data,
          updatedAt: new Date("2026-04-05T01:00:00Z"),
        }),
      ),
    },
    auditEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("GET /api/v1/review-config", () => {
  it("returns current config with all fields", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).get("/api/v1/review-config");

    expect(res.status).toBe(200);
    expect(res.body.default_review_mode).toBe("human_only");
    expect(res.body.ai_confidence_threshold).toBe(0.8);
    expect(res.body.ai_reviewer_endpoint).toBeNull();
    expect(res.body.ai_reviewer_timeout_ms).toBe(10000);
    expect(res.body.ai_reviewer_model).toBeNull();
    expect(res.body.guardrail_pipeline_enabled).toBe(false);
    expect(res.body.tiers_enabled).toEqual({
      rules: true,
      guardrails: false,
      ai_review: false,
      human_review: true,
    });
    expect(res.body.updated_at).toBe("2026-04-05T00:00:00.000Z");
  });

  it("creates default config if none exists", async () => {
    const mocks = baseMocks();
    mocks.reviewConfig.findUnique = vi.fn().mockResolvedValue(null);
    const app = buildApp(mocks);
    const res = await request(app).get("/api/v1/review-config");

    expect(res.status).toBe(200);
    expect(mocks.reviewConfig.create).toHaveBeenCalledOnce();
    expect(res.body.default_review_mode).toBe("human_only");
  });
});

describe("PUT /api/v1/review-config", () => {
  it("updates config and returns updated values", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).put("/api/v1/review-config").send({
      default_review_mode: "ai_then_human",
      ai_confidence_threshold: 0.7,
      ai_reviewer_endpoint: "http://localhost:9999/review",
      ai_reviewer_model: "gpt-4o",
      tiers_enabled: { rules: true, guardrails: true, ai_review: true, human_review: true },
    });

    expect(res.status).toBe(200);
    expect(mocks.reviewConfig.upsert).toHaveBeenCalledOnce();
    const updateData = mocks.reviewConfig.upsert.mock.calls[0][0].update;
    expect(updateData.defaultReviewMode).toBe("ai_then_human");
    expect(updateData.aiConfidenceThreshold).toBe(0.7);
    expect(updateData.aiReviewerEndpoint).toBe("http://localhost:9999/review");
    expect(updateData.aiReviewerModel).toBe("gpt-4o");
    // Stored keys match pipeline expectations: ai/human (not ai_review/human_review)
    expect(updateData.tierConfig).toEqual({
      rules: true,
      guardrails: true,
      ai: true,
      human: true,
    });
  });

  it("records audit event on update", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    await request(app).put("/api/v1/review-config").send({
      ai_confidence_threshold: 0.9,
    });

    expect(mockedRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "review_config.updated",
        actorType: "human",
        actor: "test-key",
      }),
    );
  });

  it("rejects invalid default_review_mode", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).put("/api/v1/review-config").send({
      default_review_mode: "invalid_mode",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("default_review_mode");
  });

  it("rejects ai_confidence_threshold out of range", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);

    const res1 = await request(app).put("/api/v1/review-config").send({
      ai_confidence_threshold: 1.5,
    });
    expect(res1.status).toBe(400);
    expect(res1.body.message).toContain("ai_confidence_threshold");

    const res2 = await request(app).put("/api/v1/review-config").send({
      ai_confidence_threshold: -0.1,
    });
    expect(res2.status).toBe(400);
  });

  it("rejects negative ai_reviewer_timeout_ms", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).put("/api/v1/review-config").send({
      ai_reviewer_timeout_ms: -100,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("ai_reviewer_timeout_ms");
  });

  it("rejects ai_only mode without endpoint", async () => {
    const mocks = baseMocks();
    // No existing endpoint
    mocks.reviewConfig.findUnique = vi.fn().mockResolvedValue({
      ...defaultConfig,
      aiReviewerEndpoint: null,
    });
    const app = buildApp(mocks);
    const res = await request(app).put("/api/v1/review-config").send({
      default_review_mode: "ai_only",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("ai_reviewer_endpoint");
  });

  it("allows ai_only when endpoint already set", async () => {
    const mocks = baseMocks();
    mocks.reviewConfig.findUnique = vi.fn().mockResolvedValue({
      ...defaultConfig,
      aiReviewerEndpoint: "http://existing.endpoint/review",
    });
    const app = buildApp(mocks);
    const res = await request(app).put("/api/v1/review-config").send({
      default_review_mode: "ai_only",
    });

    expect(res.status).toBe(200);
  });

  it("allows ai_then_human when endpoint provided in same request", async () => {
    const mocks = baseMocks();
    mocks.reviewConfig.findUnique = vi.fn().mockResolvedValue({
      ...defaultConfig,
      aiReviewerEndpoint: null,
    });
    const app = buildApp(mocks);
    const res = await request(app).put("/api/v1/review-config").send({
      default_review_mode: "ai_then_human",
      ai_reviewer_endpoint: "http://new.endpoint/review",
    });

    expect(res.status).toBe(200);
  });

  it("rejects non-boolean guardrail_pipeline_enabled", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).put("/api/v1/review-config").send({
      guardrail_pipeline_enabled: "yes",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("guardrail_pipeline_enabled");
  });

  it("only updates provided fields", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    await request(app).put("/api/v1/review-config").send({
      ai_confidence_threshold: 0.5,
    });

    const updateData = mocks.reviewConfig.upsert.mock.calls[0][0].update;
    expect(updateData).toEqual({ aiConfidenceThreshold: 0.5 });
    expect(updateData.defaultReviewMode).toBeUndefined();
  });
});
