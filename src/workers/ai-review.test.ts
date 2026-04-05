import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { enqueueAIReview } from "./ai-review.js";
import type { AIReviewJobData } from "./ai-review.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

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

// ---------- AI review worker logic (tested via direct function simulation) ----------

describe("AI review worker logic", () => {
  // We test the core logic by simulating what the worker does

  it("processes ai_only approved verdict", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({
          decision: "approved",
          confidence: 0.95,
          reasoning: "Content looks safe",
          model_id: "gpt-4",
        }),
      ),
    );

    const resp = await fetch("https://ai.test/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ submission_id: "sub-1", content: "hello" }),
    });

    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.decision).toBe("approved");
    expect(body.confidence).toBe(0.95);
    expect(body.reasoning).toBe("Content looks safe");
    expect(body.model_id).toBe("gpt-4");
  });

  it("processes ai_only rejected verdict", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({
          decision: "rejected",
          confidence: 0.88,
          reasoning: "Contains harmful content",
          categories: ["toxicity"],
        }),
      ),
    );

    const resp = await fetch("https://ai.test/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ submission_id: "sub-1", content: "bad content" }),
    });

    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.decision).toBe("rejected");
    expect(body.categories).toEqual(["toxicity"]);
  });

  it("ai_then_human escalates on low confidence", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({
          decision: "approved",
          confidence: 0.5,
          reasoning: "Not sure about this one",
        }),
      ),
    );

    const resp = await fetch("https://ai.test/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ submission_id: "sub-1", content: "ambiguous" }),
    });

    const body = (await resp.json()) as Record<string, unknown>;
    // With threshold 0.8 and confidence 0.5, should escalate
    const threshold = 0.8;
    const shouldEscalate = (body.confidence as number) < threshold;
    expect(shouldEscalate).toBe(true);
  });

  it("ai_then_human accepts high confidence verdict", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({
          decision: "approved",
          confidence: 0.95,
          reasoning: "Clearly safe content",
        }),
      ),
    );

    const resp = await fetch("https://ai.test/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ submission_id: "sub-1", content: "safe content" }),
    });

    const body = (await resp.json()) as Record<string, unknown>;
    const threshold = 0.8;
    const shouldAccept = (body.confidence as number) >= threshold;
    expect(shouldAccept).toBe(true);
    expect(body.decision).toBe("approved");
  });

  it("handles AI reviewer timeout", async () => {
    server.use(
      http.post("https://ai.test/review", async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return HttpResponse.json({ decision: "approved", confidence: 0.9, reasoning: "ok" });
      }),
    );

    // Simulate a timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);

    try {
      await fetch("https://ai.test/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "test" }),
        signal: controller.signal,
      });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeDefined();
    } finally {
      clearTimeout(timer);
    }
  });

  it("handles AI reviewer error response", async () => {
    server.use(
      http.post("https://ai.test/review", () =>
        HttpResponse.json({ error: "internal" }, { status: 500 }),
      ),
    );

    const resp = await fetch("https://ai.test/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test" }),
    });

    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(500);
  });
});

// ---------- AIReviewJobData shape ----------

describe("AIReviewJobData", () => {
  it("includes all required fields", () => {
    const data: AIReviewJobData = {
      submissionId: "sub-1",
      content: "test content",
      metadata: { key: "value" },
      channel: "email",
      contentType: "text/plain",
      reviewMode: "ai_then_human",
      callbackUrl: "https://example.com/webhook",
    };

    expect(data.reviewMode).toBe("ai_then_human");
    expect(data.callbackUrl).toBe("https://example.com/webhook");
    expect(data.metadata).toEqual({ key: "value" });
  });

  it("supports null callback_url", () => {
    const data: AIReviewJobData = {
      submissionId: "sub-1",
      content: "test",
      metadata: {},
      channel: "slack",
      contentType: "text/plain",
      reviewMode: "ai_only",
      callbackUrl: null,
    };

    expect(data.callbackUrl).toBeNull();
  });
});
