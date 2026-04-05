import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createSubmissionRouter } from "./submissions.js";

const UUID = "00000000-0000-0000-0000-000000000001";

function buildApp(mockPrisma: Record<string, unknown>) {
  const prisma = mockPrisma as unknown as Parameters<typeof createSubmissionRouter>[0];
  const app = express();
  app.use(express.json());
  // Simulate auth middleware populating req.apiKey
  app.use((_req, _res, next) => {
    _req.apiKey = { id: "api-key-1", name: "test-key" };
    next();
  });
  app.use("/api/v1/submissions", createSubmissionRouter(prisma));
  return app;
}

const baseMocks = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mocks: any = {
    policy: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    policyEvaluation: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    submission: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: UUID,
        ...data,
        createdAt: new Date("2026-01-01"),
      })),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    reviewConfig: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    guardrail: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks)),
  };
  return mocks;
};

describe("POST /api/v1/submissions", () => {
  it("auto-approves when no policies match", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app)
      .post("/api/v1/submissions")
      .send({
        channel: "email",
        content_type: "text/plain",
        content: { body: "Hello world" },
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(UUID);
    expect(res.body.status).toBe("approved");
    expect(res.body.decided_by).toBe("rules");
    expect(res.body.decided_at).toBeDefined();
    expect(res.body.policy_results).toEqual([]);
  });

  it("rejects when a block policy matches", async () => {
    const mocks = baseMocks();
    mocks.policy.findMany = vi.fn().mockResolvedValue([
      {
        id: "pol-1",
        name: "no-spam",
        type: "keyword_blocklist",
        config: { keywords: ["spam"] },
        action: "block",
        priority: 0,
        active: true,
        scopeChannel: null,
        scopeContentType: null,
      },
    ]);
    const app = buildApp(mocks);
    const res = await request(app)
      .post("/api/v1/submissions")
      .send({
        channel: "email",
        content_type: "text/plain",
        content: { body: "This is spam content" },
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("rejected");
    expect(res.body.decided_by).toBe("rules");
    expect(res.body.policy_results).toHaveLength(1);
    expect(res.body.policy_results[0].result).toBe("match");
    expect(res.body.policy_results[0].action).toBe("block");
  });

  it("returns pending when a flag policy matches", async () => {
    const mocks = baseMocks();
    mocks.policy.findMany = vi.fn().mockResolvedValue([
      {
        id: "pol-2",
        name: "review-urls",
        type: "regex",
        config: { pattern: "https?://" },
        action: "flag",
        priority: 0,
        active: true,
        scopeChannel: null,
        scopeContentType: null,
      },
    ]);
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/submissions").send({
      channel: "blog",
      content_type: "text/html",
      content: "Visit https://example.com",
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.decided_by).toBeNull();
    expect(res.body.review_url).toBeDefined();
  });

  it("block takes precedence over flag", async () => {
    const mocks = baseMocks();
    mocks.policy.findMany = vi.fn().mockResolvedValue([
      {
        id: "pol-1",
        name: "flag-it",
        type: "regex",
        config: { pattern: "test" },
        action: "flag",
        priority: 0,
        active: true,
        scopeChannel: null,
        scopeContentType: null,
      },
      {
        id: "pol-2",
        name: "block-it",
        type: "regex",
        config: { pattern: "test" },
        action: "block",
        priority: 1,
        active: true,
        scopeChannel: null,
        scopeContentType: null,
      },
    ]);
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/submissions").send({
      channel: "email",
      content_type: "text/plain",
      content: "test content",
    });

    expect(res.body.status).toBe("rejected");
  });

  it("stores policy evaluations", async () => {
    const mocks = baseMocks();
    mocks.policy.findMany = vi.fn().mockResolvedValue([
      {
        id: "pol-1",
        name: "length-check",
        type: "content_length",
        config: { min: 100 },
        action: "flag",
        priority: 0,
        active: true,
        scopeChannel: null,
        scopeContentType: null,
      },
    ]);
    const app = buildApp(mocks);
    await request(app).post("/api/v1/submissions").send({
      channel: "email",
      content_type: "text/plain",
      content: "short",
    });

    expect(mocks.policyEvaluation.createMany).toHaveBeenCalledOnce();
    const callData = mocks.policyEvaluation.createMany.mock.calls[0][0].data;
    expect(callData).toHaveLength(1);
    expect(callData[0].policyId).toBe("pol-1");
    expect(callData[0].submissionId).toBe(UUID);
  });

  it("returns 400 when channel is missing", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/submissions").send({
      content_type: "text/plain",
      content: "hello",
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("channel");
  });

  it("returns 400 when content_type is missing", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/submissions").send({
      channel: "email",
      content: "hello",
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("content_type");
  });

  it("returns 400 when content is missing", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/submissions").send({
      channel: "email",
      content_type: "text/plain",
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("content");
  });

  it("returns 422 for empty content", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/submissions").send({
      channel: "email",
      content_type: "text/plain",
      content: {},
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain("empty");
  });

  it("returns 422 for empty string content", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/submissions").send({
      channel: "email",
      content_type: "text/plain",
      content: "",
    });
    expect(res.status).toBe(422);
  });

  it("returns 400 for non-object metadata", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/submissions").send({
      channel: "email",
      content_type: "text/plain",
      content: "hello",
      metadata: "not-an-object",
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("metadata");
  });

  it("passes metadata to policy engine", async () => {
    const mocks = baseMocks();
    mocks.policy.findMany = vi.fn().mockResolvedValue([
      {
        id: "pol-1",
        name: "req-fields",
        type: "required_fields",
        config: { fields: ["author"] },
        action: "flag",
        priority: 0,
        active: true,
        scopeChannel: null,
        scopeContentType: null,
      },
    ]);
    const app = buildApp(mocks);
    const res = await request(app)
      .post("/api/v1/submissions")
      .send({
        channel: "blog",
        content_type: "text/plain",
        content: "My post",
        metadata: { author: "Jane" },
      });

    expect(res.body.status).toBe("approved");
  });

  it("accepts optional callback_url", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/submissions").send({
      channel: "email",
      content_type: "text/plain",
      content: "Hello",
      callback_url: "https://example.com/webhook",
    });

    expect(res.status).toBe(201);
    const createCall = mocks.submission.create.mock.calls[0][0].data;
    expect(createCall.callbackUrl).toBe("https://example.com/webhook");
  });
});

describe("GET /api/v1/submissions/:id", () => {
  it("returns full submission details", async () => {
    const mocks = baseMocks();
    mocks.submission.findUnique = vi.fn().mockResolvedValue({
      id: UUID,
      channel: "email",
      contentType: "text/plain",
      content: { body: "hello" },
      metadata: null,
      status: "approved",
      reviewMode: null,
      callbackUrl: null,
      createdAt: new Date("2026-01-01"),
      decidedAt: new Date("2026-01-01"),
      policyEvaluations: [
        {
          id: "eval-1",
          result: "pass",
          actionTaken: "info",
          details: null,
          evaluatedAt: new Date("2026-01-01"),
          policy: { name: "test-policy" },
        },
      ],
      reviews: [],
      feedbacks: [],
    });
    const app = buildApp(mocks);
    const res = await request(app).get(`/api/v1/submissions/${UUID}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(UUID);
    expect(res.body.status).toBe("approved");
    expect(res.body.policy_results).toHaveLength(1);
    expect(res.body.policy_results[0].policy_name).toBe("test-policy");
  });

  it("returns 404 for non-existent submission", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).get(`/api/v1/submissions/${UUID}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid UUID", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).get("/api/v1/submissions/bad-id");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/submissions", () => {
  it("returns paginated results", async () => {
    const mocks = baseMocks();
    mocks.submission.findMany = vi.fn().mockResolvedValue([
      {
        id: UUID,
        channel: "email",
        contentType: "text/plain",
        status: "approved",
        createdAt: new Date("2026-01-01"),
        decidedAt: new Date("2026-01-01"),
        policyEvaluations: [],
      },
    ]);
    mocks.submission.count = vi.fn().mockResolvedValue(1);
    const app = buildApp(mocks);
    const res = await request(app).get("/api/v1/submissions?limit=10&offset=0");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  it("filters by status", async () => {
    const mocks = baseMocks();
    mocks.submission.findMany = vi.fn().mockResolvedValue([]);
    mocks.submission.count = vi.fn().mockResolvedValue(0);
    const app = buildApp(mocks);
    await request(app).get("/api/v1/submissions?status=pending");

    const findManyCall = mocks.submission.findMany.mock.calls[0][0];
    expect(findManyCall.where.status).toBe("pending");
  });

  it("filters by channel", async () => {
    const mocks = baseMocks();
    mocks.submission.findMany = vi.fn().mockResolvedValue([]);
    mocks.submission.count = vi.fn().mockResolvedValue(0);
    const app = buildApp(mocks);
    await request(app).get("/api/v1/submissions?channel=email");

    const findManyCall = mocks.submission.findMany.mock.calls[0][0];
    expect(findManyCall.where.channel).toBe("email");
  });

  it("caps limit at 100", async () => {
    const mocks = baseMocks();
    mocks.submission.findMany = vi.fn().mockResolvedValue([]);
    mocks.submission.count = vi.fn().mockResolvedValue(0);
    const app = buildApp(mocks);
    const res = await request(app).get("/api/v1/submissions?limit=500");

    expect(res.body.limit).toBe(100);
  });
});
