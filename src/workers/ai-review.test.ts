import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { enqueueAIReview, processAIReviewJob, validateAIResponse } from "./ai-review.js";
import type { AIReviewJobData } from "./ai-review.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------- validateAIResponse ----------

describe("validateAIResponse", () => {
  it("validates a correct response", () => {
    const result = validateAIResponse({
      decision: "approved",
      confidence: 0.95,
      reasoning: "Safe content",
      model_id: "gpt-4",
      categories: ["safe"],
    });
    expect(result.decision).toBe("approved");
    expect(result.confidence).toBe(0.95);
    expect(result.reasoning).toBe("Safe content");
    expect(result.model_id).toBe("gpt-4");
    expect(result.categories).toEqual(["safe"]);
  });

  it("rejects invalid decision", () => {
    expect(() => validateAIResponse({ decision: "bad", confidence: 0.5, reasoning: "ok" })).toThrow(
      "Invalid AI decision",
    );
  });

  it("rejects missing confidence", () => {
    expect(() => validateAIResponse({ decision: "approved", reasoning: "ok" })).toThrow(
      "Invalid AI confidence",
    );
  });

  it("rejects confidence out of range", () => {
    expect(() =>
      validateAIResponse({ decision: "approved", confidence: 1.5, reasoning: "ok" }),
    ).toThrow("Invalid AI confidence");
  });

  it("rejects non-string reasoning", () => {
    expect(() =>
      validateAIResponse({ decision: "approved", confidence: 0.5, reasoning: 123 }),
    ).toThrow("Invalid AI reasoning");
  });

  it("handles missing optional fields", () => {
    const result = validateAIResponse({
      decision: "rejected",
      confidence: 0.8,
      reasoning: "Harmful",
    });
    expect(result.categories).toBeUndefined();
    expect(result.model_id).toBeUndefined();
  });
});

// ---------- enqueueAIReview ----------

describe("enqueueAIReview", () => {
  it("adds a job to the queue with retry config", async () => {
    const addFn = vi.fn().mockResolvedValue({ id: "job-1" });
    const mockQueue = { add: addFn } as unknown as Parameters<typeof enqueueAIReview>[0];

    const data: AIReviewJobData = {
      submissionId: "sub-1",
      content: "test content",
      metadata: {},
      channel: "email",
      contentType: "text/plain",
      reviewMode: "ai_only",
      callbackUrl: null,
    };

    await enqueueAIReview(mockQueue, data);

    expect(addFn).toHaveBeenCalledOnce();
    expect(addFn).toHaveBeenCalledWith("ai-review", data, {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
    });
  });
});

// ---------- processAIReviewJob ----------

function mockPrisma(overrides: Record<string, unknown> = {}) {
  const txMocks = {
    submission: {
      findUnique: vi.fn().mockResolvedValue({ status: "pending" }),
      update: vi.fn().mockResolvedValue({}),
    },
    review: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
  return {
    reviewConfig: {
      findFirst: vi.fn().mockResolvedValue({
        aiReviewerEndpoint: "https://ai.test/review",
        aiReviewerTimeoutMs: 10000,
        aiConfidenceThreshold: 0.8,
        aiReviewerModel: "default-model",
      }),
    },
    review: { create: vi.fn().mockResolvedValue({}) },
    submission: {
      findUnique: vi.fn().mockResolvedValue({ status: "pending" }),
      update: vi.fn().mockResolvedValue({}),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMocks)),
    _tx: txMocks,
    ...overrides,
  };
}

const baseJobData: AIReviewJobData = {
  submissionId: "sub-1",
  content: "test content",
  metadata: {},
  channel: "email",
  contentType: "text/plain",
  reviewMode: "ai_only",
  callbackUrl: null,
};

describe("processAIReviewJob", () => {
  it("ai_only: approves on approved verdict", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({
          decision: "approved",
          confidence: 0.95,
          reasoning: "Safe",
          model_id: "gpt-4",
        }),
      ),
    );

    const prisma = mockPrisma();
    await processAIReviewJob(
      prisma as unknown as Parameters<typeof processAIReviewJob>[0],
      baseJobData,
    );

    const txMocks = (prisma as unknown as Record<string, unknown>)._tx as Record<
      string,
      Record<string, { mock: { calls: unknown[][] } }>
    >;
    expect(txMocks.review.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: "approved",
          reviewerType: "ai",
        }),
      }),
    );
    expect(txMocks.submission.update.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ status: "approved" }),
      }),
    );
  });

  it("ai_only: rejects on rejected verdict", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({
          decision: "rejected",
          confidence: 0.9,
          reasoning: "Harmful",
        }),
      ),
    );

    const prisma = mockPrisma();
    await processAIReviewJob(
      prisma as unknown as Parameters<typeof processAIReviewJob>[0],
      baseJobData,
    );

    const txMocks = (prisma as unknown as Record<string, unknown>)._tx as Record<
      string,
      Record<string, { mock: { calls: unknown[][] } }>
    >;
    expect(txMocks.review.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ decision: "rejected" }),
      }),
    );
    expect(txMocks.submission.update.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ status: "rejected" }),
      }),
    );
  });

  it("ai_only: escalates on escalated verdict (fail-open)", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({
          decision: "escalated",
          confidence: 0.6,
          reasoning: "Unsure",
        }),
      ),
    );

    const prisma = mockPrisma();
    await processAIReviewJob(
      prisma as unknown as Parameters<typeof processAIReviewJob>[0],
      baseJobData,
    );

    const txMocks = (prisma as unknown as Record<string, unknown>)._tx as Record<
      string,
      Record<string, { mock: { calls: unknown[][] } }>
    >;
    expect(txMocks.review.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ decision: "escalated" }),
      }),
    );
    // Should NOT update submission status for escalated
    expect(txMocks.submission.update).not.toHaveBeenCalled();
  });

  it("ai_then_human: accepts high-confidence verdict", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({
          decision: "approved",
          confidence: 0.95,
          reasoning: "Clearly safe",
        }),
      ),
    );

    const prisma = mockPrisma();
    await processAIReviewJob(prisma as unknown as Parameters<typeof processAIReviewJob>[0], {
      ...baseJobData,
      reviewMode: "ai_then_human",
    });

    const txMocks = (prisma as unknown as Record<string, unknown>)._tx as Record<
      string,
      Record<string, { mock: { calls: unknown[][] } }>
    >;
    expect(txMocks.review.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: "approved",
          reviewerType: "ai",
        }),
      }),
    );
    expect(txMocks.submission.update).toHaveBeenCalled();
  });

  it("ai_then_human: escalates on low confidence", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({
          decision: "approved",
          confidence: 0.5,
          reasoning: "Not sure",
        }),
      ),
    );

    const prisma = mockPrisma();
    await processAIReviewJob(prisma as unknown as Parameters<typeof processAIReviewJob>[0], {
      ...baseJobData,
      reviewMode: "ai_then_human",
    });

    const txMocks = (prisma as unknown as Record<string, unknown>)._tx as Record<
      string,
      Record<string, { mock: { calls: unknown[][] } }>
    >;
    expect(txMocks.review.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ decision: "escalated" }),
      }),
    );
    expect(txMocks.submission.update).not.toHaveBeenCalled();
  });

  it("fail-open: escalates on AI endpoint error", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    const prisma = mockPrisma();
    await processAIReviewJob(
      prisma as unknown as Parameters<typeof processAIReviewJob>[0],
      baseJobData,
    );

    // Should create an escalated review via escalateToHuman (uses prisma.review.create directly)
    const reviewCreate = (
      prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
    ).review.create;
    expect(reviewCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: "escalated",
          reviewerType: "ai",
        }),
      }),
    );
  });

  it("fail-open: escalates when no AI endpoint configured", async () => {
    const prisma = mockPrisma({
      reviewConfig: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await processAIReviewJob(
      prisma as unknown as Parameters<typeof processAIReviewJob>[0],
      baseJobData,
    );

    const reviewCreate = (
      prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
    ).review.create;
    expect(reviewCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: "escalated",
          reasoning: expect.stringContaining("No AI reviewer endpoint"),
        }),
      }),
    );
  });

  it("skips when submission is no longer pending", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({
          decision: "approved",
          confidence: 0.95,
          reasoning: "Safe",
        }),
      ),
    );

    const txMocks = {
      submission: {
        findUnique: vi.fn().mockResolvedValue({ status: "approved" }),
        update: vi.fn(),
      },
      review: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    const prisma = mockPrisma();
    (prisma as unknown as Record<string, unknown>).$transaction = vi
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMocks));

    await processAIReviewJob(
      prisma as unknown as Parameters<typeof processAIReviewJob>[0],
      baseJobData,
    );

    // Transaction returned false, no review created
    expect(txMocks.review.create).not.toHaveBeenCalled();
  });

  it("skips when AI review already exists (idempotency)", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({
          decision: "approved",
          confidence: 0.95,
          reasoning: "Safe",
        }),
      ),
    );

    const txMocks = {
      submission: {
        findUnique: vi.fn().mockResolvedValue({ status: "pending" }),
        update: vi.fn(),
      },
      review: {
        findFirst: vi.fn().mockResolvedValue({ id: "existing-review" }),
        create: vi.fn(),
      },
    };
    const prisma = mockPrisma();
    (prisma as unknown as Record<string, unknown>).$transaction = vi
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMocks));

    await processAIReviewJob(
      prisma as unknown as Parameters<typeof processAIReviewJob>[0],
      baseJobData,
    );

    expect(txMocks.review.create).not.toHaveBeenCalled();
  });

  it("fail-open: escalates on invalid AI response", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({ decision: "maybe", confidence: "high", reasoning: 42 }),
      ),
    );

    const prisma = mockPrisma();
    await processAIReviewJob(
      prisma as unknown as Parameters<typeof processAIReviewJob>[0],
      baseJobData,
    );

    const reviewCreate = (
      prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
    ).review.create;
    expect(reviewCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: "escalated",
          reviewerType: "ai",
        }),
      }),
    );
  });
});
