import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { evaluateGuardrails } from "./guardrail.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const UUID1 = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";
const UUID3 = "00000000-0000-0000-0000-000000000003";

const baseInput = {
  submissionId: "sub-1",
  content: "test content",
  metadata: {},
  channel: "email",
  contentType: "text/plain",
};

function mockPrisma(guardrails: Record<string, unknown>[]) {
  return {
    guardrail: {
      findMany: vi.fn().mockResolvedValue(guardrails),
    },
    guardrailEvaluation: {
      create: vi.fn().mockResolvedValue({}),
    },
    auditEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
  } as unknown as Parameters<typeof evaluateGuardrails>[0];
}

function makeGuardrail(overrides: Record<string, unknown> = {}) {
  return {
    id: UUID1,
    name: "test-guardrail",
    endpointUrl: "https://guardrail.test/evaluate",
    timeoutMs: 10000,
    failureMode: "fail_closed",
    pipelineOrder: 1,
    scopeChannel: null,
    scopeContentType: null,
    active: true,
    ...overrides,
  };
}

describe("evaluateGuardrails", () => {
  it("returns empty array when no guardrails are registered", async () => {
    const prisma = mockPrisma([]);
    const results = await evaluateGuardrails(prisma, baseInput);
    expect(results).toEqual([]);
  });

  it("evaluates a passing guardrail", async () => {
    server.use(
      http.post("https://guardrail.test/evaluate", () =>
        HttpResponse.json({ verdict: "pass", confidence: 0.99, reasoning: "Content is safe" }),
      ),
    );

    const prisma = mockPrisma([makeGuardrail()]);
    const results = await evaluateGuardrails(prisma, baseInput);

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("pass");
    expect(results[0].confidence).toBe(0.99);
    expect(results[0].reasoning).toBe("Content is safe");
    expect(results[0].guardrailName).toBe("test-guardrail");
    expect(results[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("evaluates a failing guardrail", async () => {
    server.use(
      http.post("https://guardrail.test/evaluate", () =>
        HttpResponse.json({
          verdict: "fail",
          confidence: 0.95,
          reasoning: "Contains harmful content",
          categories: ["toxicity"],
        }),
      ),
    );

    const prisma = mockPrisma([makeGuardrail()]);
    const results = await evaluateGuardrails(prisma, baseInput);

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("fail");
    expect(results[0].categories).toEqual(["toxicity"]);
  });

  it("evaluates a flagging guardrail", async () => {
    server.use(
      http.post("https://guardrail.test/evaluate", () =>
        HttpResponse.json({ verdict: "flag", confidence: 0.6, reasoning: "Uncertain" }),
      ),
    );

    const prisma = mockPrisma([makeGuardrail()]);
    const results = await evaluateGuardrails(prisma, baseInput);

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("flag");
  });

  it("evaluates multiple guardrails in pipeline order", async () => {
    let callOrder: string[] = [];

    server.use(
      http.post("https://guardrail.test/first", () => {
        callOrder.push("first");
        return HttpResponse.json({ verdict: "pass" });
      }),
      http.post("https://guardrail.test/second", () => {
        callOrder.push("second");
        return HttpResponse.json({ verdict: "pass" });
      }),
    );

    const prisma = mockPrisma([
      makeGuardrail({
        id: UUID1,
        name: "first",
        endpointUrl: "https://guardrail.test/first",
        pipelineOrder: 1,
      }),
      makeGuardrail({
        id: UUID2,
        name: "second",
        endpointUrl: "https://guardrail.test/second",
        pipelineOrder: 2,
      }),
    ]);

    const results = await evaluateGuardrails(prisma, baseInput);

    expect(results).toHaveLength(2);
    expect(callOrder).toEqual(["first", "second"]);
  });

  it("short-circuits on fail_closed failure", async () => {
    let secondCalled = false;

    server.use(
      http.post("https://guardrail.test/first", () => HttpResponse.json({ verdict: "fail" })),
      http.post("https://guardrail.test/second", () => {
        secondCalled = true;
        return HttpResponse.json({ verdict: "pass" });
      }),
    );

    const prisma = mockPrisma([
      makeGuardrail({
        id: UUID1,
        name: "blocker",
        endpointUrl: "https://guardrail.test/first",
        failureMode: "fail_closed",
        pipelineOrder: 1,
      }),
      makeGuardrail({
        id: UUID2,
        name: "second",
        endpointUrl: "https://guardrail.test/second",
        failureMode: "fail_closed",
        pipelineOrder: 2,
      }),
    ]);

    const results = await evaluateGuardrails(prisma, baseInput);

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("fail");
    expect(secondCalled).toBe(false);
  });

  it("continues pipeline on fail_open failure", async () => {
    server.use(
      http.post("https://guardrail.test/first", () => HttpResponse.json({ verdict: "fail" })),
      http.post("https://guardrail.test/second", () => HttpResponse.json({ verdict: "pass" })),
    );

    const prisma = mockPrisma([
      makeGuardrail({
        id: UUID1,
        name: "lenient",
        endpointUrl: "https://guardrail.test/first",
        failureMode: "fail_open",
        pipelineOrder: 1,
      }),
      makeGuardrail({
        id: UUID2,
        name: "second",
        endpointUrl: "https://guardrail.test/second",
        failureMode: "fail_open",
        pipelineOrder: 2,
      }),
    ]);

    const results = await evaluateGuardrails(prisma, baseInput);

    expect(results).toHaveLength(2);
    expect(results[0].verdict).toBe("fail");
    expect(results[1].verdict).toBe("pass");
  });

  it("applies fail_closed on adapter error", async () => {
    server.use(
      http.post("https://guardrail.test/evaluate", () =>
        HttpResponse.json({ error: "internal" }, { status: 500 }),
      ),
    );

    const prisma = mockPrisma([makeGuardrail({ failureMode: "fail_closed" })]);
    const results = await evaluateGuardrails(prisma, baseInput);

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("fail");
    expect(results[0].error).toContain("status 500");
  });

  it("applies fail_open on adapter error", async () => {
    server.use(
      http.post("https://guardrail.test/evaluate", () =>
        HttpResponse.json({ error: "internal" }, { status: 500 }),
      ),
    );

    const prisma = mockPrisma([makeGuardrail({ failureMode: "fail_open" })]);
    const results = await evaluateGuardrails(prisma, baseInput);

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("pass");
    expect(results[0].error).toContain("status 500");
  });

  it("applies failure mode on timeout", async () => {
    server.use(
      http.post("https://guardrail.test/evaluate", async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return HttpResponse.json({ verdict: "pass" });
      }),
    );

    const prisma = mockPrisma([makeGuardrail({ timeoutMs: 50, failureMode: "fail_closed" })]);
    const results = await evaluateGuardrails(prisma, baseInput);

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("fail");
    expect(results[0].error).toBeDefined();
  });

  it("records audit events for each evaluation", async () => {
    server.use(
      http.post("https://guardrail.test/evaluate", () => HttpResponse.json({ verdict: "pass" })),
    );

    const prisma = mockPrisma([makeGuardrail()]);
    await evaluateGuardrails(prisma, baseInput);

    expect(prisma.auditEvent.create).toHaveBeenCalledOnce();
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "guardrail.evaluated",
        actorType: "guardrail",
      }),
    });
  });

  it("sends correct payload to adapter endpoint", async () => {
    let receivedBody: Record<string, unknown> = {};

    server.use(
      http.post("https://guardrail.test/evaluate", async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ verdict: "pass" });
      }),
    );

    const prisma = mockPrisma([makeGuardrail()]);
    await evaluateGuardrails(prisma, {
      ...baseInput,
      content: "hello world",
      metadata: { key: "value" },
    });

    expect(receivedBody.submission_id).toBe("sub-1");
    expect(receivedBody.content).toBe("hello world");
    expect(receivedBody.metadata).toEqual({ key: "value" });
    expect(receivedBody.channel).toBe("email");
    expect(receivedBody.content_type).toBe("text/plain");
  });
});
