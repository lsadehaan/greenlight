import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluatePipeline, resolveTierConfig } from "./pipeline.js";
import type { PipelineInput } from "./pipeline.js";

// Mock dependencies
vi.mock("./policy.js", () => ({
  evaluatePolicies: vi.fn(),
}));
vi.mock("./guardrail.js", () => ({
  evaluateGuardrails: vi.fn(),
}));
vi.mock("../workers/ai-review.js", () => ({
  enqueueAIReview: vi.fn(),
}));

import { evaluatePolicies } from "./policy.js";
import { evaluateGuardrails } from "./guardrail.js";
import { enqueueAIReview } from "../workers/ai-review.js";

const mockedEvaluatePolicies = vi.mocked(evaluatePolicies);
const mockedEvaluateGuardrails = vi.mocked(evaluateGuardrails);
const mockedEnqueueAIReview = vi.mocked(enqueueAIReview);

function mockPrisma(reviewConfig: Record<string, unknown> | null = null) {
  return {
    reviewConfig: {
      findFirst: vi.fn().mockResolvedValue(reviewConfig),
    },
  } as unknown as Parameters<typeof evaluatePipeline>[0];
}

const baseInput: PipelineInput = {
  submissionId: "sub-1",
  content: "test content",
  metadata: {},
  channel: "email",
  contentType: "text/plain",
  callbackUrl: null,
};

const mockAIQueue = { add: vi.fn().mockResolvedValue({ id: "job-1" }) } as unknown as Parameters<
  typeof evaluatePipeline
>[2];

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------- resolveTierConfig ----------

describe("resolveTierConfig", () => {
  it("derives tiers from defaultReviewMode=human_only", () => {
    const tiers = resolveTierConfig({
      defaultReviewMode: "human_only",
      guardrailPipelineEnabled: false,
    });
    expect(tiers).toEqual({ rules: true, guardrails: false, ai: false, human: true });
  });

  it("derives tiers from defaultReviewMode=ai_only", () => {
    const tiers = resolveTierConfig({
      defaultReviewMode: "ai_only",
      guardrailPipelineEnabled: true,
    });
    expect(tiers).toEqual({ rules: true, guardrails: true, ai: true, human: false });
  });

  it("derives tiers from defaultReviewMode=ai_then_human", () => {
    const tiers = resolveTierConfig({
      defaultReviewMode: "ai_then_human",
      guardrailPipelineEnabled: false,
    });
    expect(tiers).toEqual({ rules: true, guardrails: false, ai: true, human: true });
  });

  it("uses explicit tierConfig when provided", () => {
    const tiers = resolveTierConfig({
      defaultReviewMode: "human_only",
      guardrailPipelineEnabled: false,
      tierConfig: { rules: true, guardrails: true, ai: false, human: true },
    });
    expect(tiers).toEqual({ rules: true, guardrails: true, ai: false, human: true });
  });

  it("defaults rules=true and human=true when not explicitly false in tierConfig", () => {
    const tiers = resolveTierConfig({
      defaultReviewMode: "human_only",
      guardrailPipelineEnabled: false,
      tierConfig: { ai: true, guardrails: true },
    });
    expect(tiers).toEqual({ rules: true, guardrails: true, ai: true, human: true });
  });
});

// ---------- evaluatePipeline ----------

describe("evaluatePipeline", () => {
  const allTiersConfig = {
    defaultReviewMode: "ai_then_human",
    guardrailPipelineEnabled: true,
    tierConfig: null,
    aiConfidenceThreshold: 0.8,
    aiReviewerEndpoint: "https://ai.test/review",
    aiReviewerTimeoutMs: 10000,
    aiReviewerModel: "test-model",
  };

  // ── Rules tier ──

  it("rules: auto-approves when all policies pass", async () => {
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "test", result: "pass", action: "info", detail: "ok" },
    ]);

    const result = await evaluatePipeline(mockPrisma(allTiersConfig), baseInput, mockAIQueue);

    expect(result.status).toBe("approved");
    expect(result.decidedBy).toBe("rules");
    expect(result.decidedAt).toBeInstanceOf(Date);
    expect(mockedEvaluateGuardrails).not.toHaveBeenCalled();
    expect(mockedEnqueueAIReview).not.toHaveBeenCalled();
  });

  it("rules: auto-rejects when a policy blocks", async () => {
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "blocklist", result: "match", action: "block", detail: "bad" },
    ]);

    const result = await evaluatePipeline(mockPrisma(allTiersConfig), baseInput, mockAIQueue);

    expect(result.status).toBe("rejected");
    expect(result.decidedBy).toBe("rules");
    expect(mockedEvaluateGuardrails).not.toHaveBeenCalled();
    expect(mockedEnqueueAIReview).not.toHaveBeenCalled();
  });

  it("rules: escalates to guardrails when a policy flags", async () => {
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "regex", result: "match", action: "flag", detail: "flagged" },
    ]);
    mockedEvaluateGuardrails.mockResolvedValue([
      {
        guardrailId: "g1",
        guardrailName: "toxicity",
        verdict: "pass",
        confidence: 0.9,
        reasoning: "safe",
        categories: null,
        latencyMs: 50,
        failureMode: "fail_open",
      },
    ]);
    mockedEnqueueAIReview.mockResolvedValue();

    const result = await evaluatePipeline(mockPrisma(allTiersConfig), baseInput, mockAIQueue);

    expect(mockedEvaluateGuardrails).toHaveBeenCalled();
    expect(result.guardrailResults).toHaveLength(1);
  });

  // ── Guardrails tier ──

  it("guardrails: rejects when a guardrail fails", async () => {
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "regex", result: "match", action: "flag", detail: "flagged" },
    ]);
    mockedEvaluateGuardrails.mockResolvedValue([
      {
        guardrailId: "g1",
        guardrailName: "toxicity",
        verdict: "fail",
        confidence: 0.95,
        reasoning: "toxic",
        categories: ["toxicity"],
        latencyMs: 80,
        failureMode: "fail_closed",
      },
    ]);

    const result = await evaluatePipeline(mockPrisma(allTiersConfig), baseInput, mockAIQueue);

    expect(result.status).toBe("rejected");
    expect(result.decidedBy).toBe("guardrails");
    expect(mockedEnqueueAIReview).not.toHaveBeenCalled();
  });

  it("guardrails: passes to AI tier when all guardrails pass", async () => {
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "regex", result: "match", action: "flag", detail: "flagged" },
    ]);
    mockedEvaluateGuardrails.mockResolvedValue([
      {
        guardrailId: "g1",
        guardrailName: "toxicity",
        verdict: "pass",
        confidence: 0.9,
        reasoning: "safe",
        categories: null,
        latencyMs: 50,
        failureMode: "fail_open",
      },
    ]);
    mockedEnqueueAIReview.mockResolvedValue();

    const result = await evaluatePipeline(mockPrisma(allTiersConfig), baseInput, mockAIQueue);

    expect(result.status).toBe("pending");
    expect(result.aiEnqueued).toBe(true);
    expect(mockedEnqueueAIReview).toHaveBeenCalledOnce();
  });

  // ── AI tier ──

  it("ai: enqueues AI review job with correct data", async () => {
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "regex", result: "match", action: "flag", detail: "flagged" },
    ]);
    mockedEvaluateGuardrails.mockResolvedValue([]);
    mockedEnqueueAIReview.mockResolvedValue();

    await evaluatePipeline(mockPrisma(allTiersConfig), baseInput, mockAIQueue);

    expect(mockedEnqueueAIReview).toHaveBeenCalledWith(mockAIQueue, {
      submissionId: "sub-1",
      content: "test content",
      metadata: {},
      channel: "email",
      contentType: "text/plain",
      reviewMode: "ai_then_human",
      callbackUrl: null,
    });
  });

  it("ai: uses ai_only mode when review mode is ai_only", async () => {
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "regex", result: "match", action: "flag", detail: "flagged" },
    ]);
    mockedEvaluateGuardrails.mockResolvedValue([]);
    mockedEnqueueAIReview.mockResolvedValue();

    const config = {
      ...allTiersConfig,
      defaultReviewMode: "ai_only",
      guardrailPipelineEnabled: true,
    };
    await evaluatePipeline(mockPrisma(config), baseInput, mockAIQueue);

    expect(mockedEnqueueAIReview).toHaveBeenCalledWith(
      mockAIQueue,
      expect.objectContaining({ reviewMode: "ai_only" }),
    );
  });

  // ── Tier disablement ──

  it("skips guardrails when disabled, proceeds to AI", async () => {
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "regex", result: "match", action: "flag", detail: "flagged" },
    ]);
    mockedEnqueueAIReview.mockResolvedValue();

    const config = { ...allTiersConfig, guardrailPipelineEnabled: false, tierConfig: null };
    const result = await evaluatePipeline(mockPrisma(config), baseInput, mockAIQueue);

    expect(mockedEvaluateGuardrails).not.toHaveBeenCalled();
    expect(result.aiEnqueued).toBe(true);
  });

  it("skips AI tier when disabled, returns pending for human review", async () => {
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "regex", result: "match", action: "flag", detail: "flagged" },
    ]);
    mockedEvaluateGuardrails.mockResolvedValue([
      {
        guardrailId: "g1",
        guardrailName: "toxicity",
        verdict: "pass",
        confidence: 0.9,
        reasoning: "safe",
        categories: null,
        latencyMs: 50,
        failureMode: "fail_open",
      },
    ]);

    const config = {
      defaultReviewMode: "human_only",
      guardrailPipelineEnabled: true,
      tierConfig: null,
      aiConfidenceThreshold: 0.8,
      aiReviewerEndpoint: null,
      aiReviewerTimeoutMs: 10000,
      aiReviewerModel: null,
    };
    const result = await evaluatePipeline(mockPrisma(config), baseInput, mockAIQueue);

    expect(result.status).toBe("pending");
    expect(result.aiEnqueued).toBe(false);
    expect(result.decidedBy).toBeNull();
    expect(mockedEnqueueAIReview).not.toHaveBeenCalled();
  });

  it("skips both guardrails and AI when disabled", async () => {
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "regex", result: "match", action: "flag", detail: "flagged" },
    ]);

    const config = {
      defaultReviewMode: "human_only",
      guardrailPipelineEnabled: false,
      tierConfig: null,
      aiConfidenceThreshold: 0.8,
      aiReviewerEndpoint: null,
      aiReviewerTimeoutMs: 10000,
      aiReviewerModel: null,
    };
    const result = await evaluatePipeline(mockPrisma(config), baseInput, mockAIQueue);

    expect(result.status).toBe("pending");
    expect(result.aiEnqueued).toBe(false);
    expect(mockedEvaluateGuardrails).not.toHaveBeenCalled();
    expect(mockedEnqueueAIReview).not.toHaveBeenCalled();
  });

  // ── No config ──

  it("defaults to rules+human when no ReviewConfig exists", async () => {
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "regex", result: "match", action: "flag", detail: "flagged" },
    ]);

    const result = await evaluatePipeline(mockPrisma(null), baseInput, mockAIQueue);

    expect(result.status).toBe("pending");
    expect(result.tierConfig).toEqual({ rules: true, guardrails: false, ai: false, human: true });
    expect(mockedEvaluateGuardrails).not.toHaveBeenCalled();
    expect(mockedEnqueueAIReview).not.toHaveBeenCalled();
  });

  // ── Full pipeline flow ──

  it("full pipeline: rules flag → guardrails pass → AI enqueued", async () => {
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "regex", result: "match", action: "flag", detail: "flagged" },
    ]);
    mockedEvaluateGuardrails.mockResolvedValue([
      {
        guardrailId: "g1",
        guardrailName: "toxicity",
        verdict: "pass",
        confidence: 0.9,
        reasoning: "safe",
        categories: null,
        latencyMs: 50,
        failureMode: "fail_open",
      },
      {
        guardrailId: "g2",
        guardrailName: "pii",
        verdict: "flag",
        confidence: 0.7,
        reasoning: "possible pii",
        categories: ["pii"],
        latencyMs: 30,
        failureMode: "fail_open",
      },
    ]);
    mockedEnqueueAIReview.mockResolvedValue();

    const result = await evaluatePipeline(mockPrisma(allTiersConfig), baseInput, mockAIQueue);

    expect(result.policyResults).toHaveLength(1);
    expect(result.guardrailResults).toHaveLength(2);
    expect(result.aiEnqueued).toBe(true);
    expect(result.status).toBe("pending");
  });

  // ── decided_by tracking ──

  it("decided_by reflects the tier that made the decision", async () => {
    // Rules reject
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "blocklist", result: "match", action: "block", detail: "bad" },
    ]);
    let result = await evaluatePipeline(mockPrisma(allTiersConfig), baseInput);
    expect(result.decidedBy).toBe("rules");

    // Guardrails reject
    vi.clearAllMocks();
    mockedEvaluatePolicies.mockResolvedValue([
      { policyId: "p1", policyName: "regex", result: "match", action: "flag", detail: "flagged" },
    ]);
    mockedEvaluateGuardrails.mockResolvedValue([
      {
        guardrailId: "g1",
        guardrailName: "toxicity",
        verdict: "fail",
        confidence: 0.95,
        reasoning: "toxic",
        categories: null,
        latencyMs: 50,
        failureMode: "fail_closed",
      },
    ]);
    result = await evaluatePipeline(mockPrisma(allTiersConfig), baseInput);
    expect(result.decidedBy).toBe("guardrails");
  });
});
