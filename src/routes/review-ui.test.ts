import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createReviewUIRouter } from "./review-ui.js";

vi.mock("../services/audit.js", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../workers/webhook.js", () => ({
  enqueueWebhook: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../middleware/auth.js", () => ({
  hashApiKey: vi.fn().mockReturnValue("hashed-key"),
}));

import { recordAuditEvent } from "../services/audit.js";
import { enqueueWebhook } from "../workers/webhook.js";
const mockedRecordAudit = vi.mocked(recordAuditEvent);
const mockedEnqueueWebhook = vi.mocked(enqueueWebhook);

const API_KEY = "test-api-key";
const SUB_ID = "00000000-0000-0000-0000-000000000001";

const pendingSubmission = {
  id: SUB_ID,
  apiKeyId: "key-1",
  channel: "email",
  contentType: "text/plain",
  content: "Test content for review",
  metadata: { priority: "normal" },
  status: "pending",
  reviewMode: "human_only",
  callbackUrl: null,
  callbackStatus: null,
  createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
  decidedAt: null,
  decidedBy: null,
  policyEvaluations: [
    {
      id: "pe-1",
      result: "flag",
      actionTaken: "flag",
      details: null,
      policy: { name: "profanity-check" },
    },
  ],
  guardrailEvaluations: [],
  reviews: [],
};

const urgentSubmission = {
  ...pendingSubmission,
  id: "00000000-0000-0000-0000-000000000002",
  metadata: { priority: "urgent" },
  policyEvaluations: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseMocks(): any {
  return {
    apiKey: {
      findUnique: vi.fn().mockResolvedValue({ id: "key-1", name: "test-key", active: true, keyHash: "hashed-key" }),
    },
    submission: {
      findMany: vi.fn().mockResolvedValue([pendingSubmission]),
      findUnique: vi.fn().mockResolvedValue(pendingSubmission),
      count: vi.fn().mockResolvedValue(1),
      update: vi.fn().mockResolvedValue({}),
    },
    review: {
      create: vi.fn().mockResolvedValue({}),
    },
    auditEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (fn: (tx: any) => Promise<unknown>) => {
        const txProxy = {
          submission: {
            findUnique: vi.fn().mockResolvedValue({ status: "pending", callbackUrl: null }),
            update: vi.fn().mockResolvedValue({}),
          },
          review: {
            create: vi.fn().mockResolvedValue({}),
          },
        };
        return fn(txProxy);
      },
    ),
  };
}

function buildApp(mockPrisma: ReturnType<typeof baseMocks>) {
  const prisma = mockPrisma as unknown as Parameters<typeof createReviewUIRouter>[0];
  const webhookQueue = { add: vi.fn().mockResolvedValue({}) } as unknown as Parameters<typeof createReviewUIRouter>[1];
  const app = express();
  app.use("/review", createReviewUIRouter(prisma, webhookQueue));
  return app;
}

describe("GET /review (queue page)", () => {
  it("returns 401 without token", async () => {
    const app = buildApp(baseMocks());
    const res = await request(app).get("/review");
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const mocks = baseMocks();
    mocks.apiKey.findUnique = vi.fn().mockResolvedValue(null);
    const app = buildApp(mocks);
    const res = await request(app).get("/review?token=bad-key");
    expect(res.status).toBe(401);
  });

  it("renders queue page with pending submissions", async () => {
    const app = buildApp(baseMocks());
    const res = await request(app).get(`/review?token=${API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.type).toBe("text/html");
    expect(res.text).toContain("Greenlight");
    expect(res.text).toContain("1 pending");
    expect(res.text).toContain(SUB_ID.slice(0, 8));
    expect(res.text).toContain("Test content for review");
    expect(res.text).toContain("profanity-check");
  });

  it("renders empty state when no submissions", async () => {
    const mocks = baseMocks();
    mocks.submission.findMany = vi.fn().mockResolvedValue([]);
    mocks.submission.count = vi.fn().mockResolvedValue(0);
    const app = buildApp(mocks);
    const res = await request(app).get(`/review?token=${API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("No pending submissions");
  });

  it("passes channel filter to query", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    await request(app).get(`/review?token=${API_KEY}&channel=slack`);
    const call = mocks.submission.findMany.mock.calls[0][0];
    expect(call.where.channel).toBe("slack");
  });

  it("supports sort order", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    await request(app).get(`/review?token=${API_KEY}&sort=oldest`);
    const call = mocks.submission.findMany.mock.calls[0][0];
    expect(call.orderBy.createdAt).toBe("asc");
  });

  it("highlights urgent submissions", async () => {
    const mocks = baseMocks();
    mocks.submission.findMany = vi.fn().mockResolvedValue([urgentSubmission]);
    const app = buildApp(mocks);
    const res = await request(app).get(`/review?token=${API_KEY}`);
    expect(res.text).toContain("urgent");
  });
});

describe("GET /review/:id (detail page)", () => {
  it("renders submission detail with all sections", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).get(`/review/${SUB_ID}?token=${API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(SUB_ID);
    expect(res.text).toContain("Test content for review");
    expect(res.text).toContain("Approve");
    expect(res.text).toContain("Reject");
  });

  it("returns 404 for missing submission", async () => {
    const mocks = baseMocks();
    mocks.submission.findUnique = vi.fn().mockResolvedValue(null);
    const app = buildApp(mocks);
    const res = await request(app).get(`/review/nonexistent?token=${API_KEY}`);
    expect(res.status).toBe(404);
  });

  it("shows AI review when present", async () => {
    const mocks = baseMocks();
    const subWithAI = {
      ...pendingSubmission,
      reviews: [{
        id: "rev-1",
        reviewerType: "ai",
        reviewerIdentity: "gpt-4o",
        decision: "approved",
        confidence: 0.95,
        reasoning: "Content appears safe",
        comment: null,
        aiMetadata: null,
        createdAt: new Date(),
      }],
    };
    mocks.submission.findUnique = vi.fn().mockResolvedValue(subWithAI);
    const app = buildApp(mocks);
    const res = await request(app).get(`/review/${SUB_ID}?token=${API_KEY}`);
    expect(res.text).toContain("AI Review");
    expect(res.text).toContain("Content appears safe");
    expect(res.text).toContain("95%");
  });
});

describe("POST /review/:id/approve", () => {
  it("approves submission and redirects", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/review/${SUB_ID}/approve?token=${API_KEY}`)
      .send("");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/review?token=");
    expect(mockedRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "review.created",
        payload: expect.objectContaining({ decision: "approved" }),
      }),
    );
  });

  it("skips if submission no longer pending", async () => {
    const mocks = baseMocks();
    mocks.$transaction = vi.fn().mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (fn: (tx: any) => Promise<unknown>) => {
        const txProxy = {
          submission: {
            findUnique: vi.fn().mockResolvedValue({ status: "approved", callbackUrl: null }),
            update: vi.fn(),
          },
          review: { create: vi.fn() },
        };
        return fn(txProxy);
      },
    );
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/review/${SUB_ID}/approve?token=${API_KEY}`)
      .send("");
    expect(res.status).toBe(302);
    // Should not record audit since no update happened
    expect(mockedRecordAudit).not.toHaveBeenCalled();
  });
});

describe("POST /review/:id/reject", () => {
  it("rejects submission and redirects", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/review/${SUB_ID}/reject?token=${API_KEY}`)
      .send("");
    expect(res.status).toBe(302);
    expect(mockedRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "review.created",
        payload: expect.objectContaining({ decision: "rejected" }),
      }),
    );
  });

  it("triggers webhook when callbackUrl exists", async () => {
    const mocks = baseMocks();
    mocks.$transaction = vi.fn().mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (fn: (tx: any) => Promise<unknown>) => {
        const txProxy = {
          submission: {
            findUnique: vi.fn().mockResolvedValue({ status: "pending", callbackUrl: "https://example.com/hook" }),
            update: vi.fn().mockResolvedValue({}),
          },
          review: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(txProxy);
      },
    );
    const app = buildApp(mocks);
    await request(app)
      .post(`/review/${SUB_ID}/reject?token=${API_KEY}`)
      .send("");
    expect(mockedEnqueueWebhook).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        submissionId: SUB_ID,
        callbackUrl: "https://example.com/hook",
      }),
    );
  });
});
