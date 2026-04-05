import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createReviewRouter, actionTokens } from "./reviews.js";

const UUID = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";

function buildApp(mockPrisma: Record<string, Record<string, unknown>>) {
  const prisma = mockPrisma as unknown as Parameters<typeof createReviewRouter>[0];
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    _req.apiKey = { id: "api-key-1", name: "test-reviewer" };
    next();
  });
  app.use("/api/v1/submissions", createReviewRouter(prisma));
  return app;
}

const pendingSubmission = (reviews: Record<string, unknown>[] = []) => ({
  id: UUID,
  status: "pending",
  reviews,
});

beforeEach(() => {
  actionTokens.clear();
});

describe("POST /api/v1/submissions/:id/review", () => {
  it("approves a pending submission", async () => {
    const createFn = vi.fn().mockResolvedValue({
      id: UUID2,
      submissionId: UUID,
      reviewerType: "human",
      reviewerIdentity: "test-reviewer",
      decision: "approved",
      comment: "Looks good",
      createdAt: new Date("2026-01-01"),
    });
    const updateFn = vi.fn().mockResolvedValue({});
    const mocks = {
      submission: {
        findUnique: vi.fn().mockResolvedValue(pendingSubmission()),
        update: updateFn,
      },
      review: { create: createFn },
    };
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/review`)
      .send({ decision: "approved", comment: "Looks good" });

    expect(res.status).toBe(201);
    expect(res.body.decision).toBe("approved");
    expect(res.body.comment).toBe("Looks good");
    expect(res.body.reviewer_type).toBe("human");
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: UUID },
        data: expect.objectContaining({ status: "approved" }),
      }),
    );
  });

  it("rejects a pending submission", async () => {
    const createFn = vi.fn().mockResolvedValue({
      id: UUID2,
      submissionId: UUID,
      reviewerType: "human",
      reviewerIdentity: "test-reviewer",
      decision: "rejected",
      comment: "Not appropriate",
      createdAt: new Date("2026-01-01"),
    });
    const updateFn = vi.fn().mockResolvedValue({});
    const mocks = {
      submission: {
        findUnique: vi.fn().mockResolvedValue(pendingSubmission()),
        update: updateFn,
      },
      review: { create: createFn },
    };
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/review`)
      .send({ decision: "rejected", comment: "Not appropriate" });

    expect(res.status).toBe(201);
    expect(res.body.decision).toBe("rejected");
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "rejected" }),
      }),
    );
  });

  it("returns 409 when submission already has a human review", async () => {
    const mocks = {
      submission: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            pendingSubmission([{ id: "rev-1", reviewerType: "human", decision: "approved" }]),
          ),
      },
      review: {},
    };
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/review`)
      .send({ decision: "rejected" });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain("human review");
  });

  it("allows AI review after human review", async () => {
    const createFn = vi.fn().mockResolvedValue({
      id: UUID2,
      submissionId: UUID,
      reviewerType: "ai",
      reviewerIdentity: "test-reviewer",
      decision: "approved",
      comment: null,
      createdAt: new Date("2026-01-01"),
    });
    const mocks = {
      submission: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            pendingSubmission([{ id: "rev-1", reviewerType: "human", decision: "approved" }]),
          ),
        update: vi.fn().mockResolvedValue({}),
      },
      review: { create: createFn },
    };
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/review`)
      .send({ decision: "approved", reviewer_type: "ai", confidence: 0.95 });

    expect(res.status).toBe(201);
    expect(res.body.reviewer_type).toBe("ai");
  });

  it("returns 409 when AI review already exists for AI reviewer", async () => {
    const mocks = {
      submission: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            pendingSubmission([{ id: "rev-1", reviewerType: "ai", decision: "approved" }]),
          ),
      },
      review: {},
    };
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/review`)
      .send({ decision: "approved", reviewer_type: "ai" });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain("ai review");
  });

  it("returns 400 when escalate used with human reviewer", async () => {
    const mocks = {
      submission: {},
      review: {},
    };
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/review`)
      .send({ decision: "escalated", reviewer_type: "human" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("AI");
  });

  it("allows escalate for AI reviewer", async () => {
    const createFn = vi.fn().mockResolvedValue({
      id: UUID2,
      submissionId: UUID,
      reviewerType: "ai",
      reviewerIdentity: "test-reviewer",
      decision: "escalated",
      comment: null,
      createdAt: new Date("2026-01-01"),
    });
    const mocks = {
      submission: {
        findUnique: vi.fn().mockResolvedValue(pendingSubmission()),
        update: vi.fn().mockResolvedValue({}),
      },
      review: { create: createFn },
    };
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/review`)
      .send({ decision: "escalated", reviewer_type: "ai", reasoning: "Unsure about content" });

    expect(res.status).toBe(201);
    expect(res.body.decision).toBe("escalated");
    // Escalated should NOT update submission status
    expect(mocks.submission.update).not.toHaveBeenCalled();
  });

  it("returns 404 for non-existent submission", async () => {
    const mocks = {
      submission: { findUnique: vi.fn().mockResolvedValue(null) },
      review: {},
    };
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/review`)
      .send({ decision: "approved" });

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid UUID", async () => {
    const mocks = { submission: {}, review: {} };
    const app = buildApp(mocks);
    const res = await request(app)
      .post("/api/v1/submissions/bad-id/review")
      .send({ decision: "approved" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid decision", async () => {
    const mocks = { submission: {}, review: {} };
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/review`)
      .send({ decision: "maybe" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("decision");
  });

  it("returns 400 for invalid reviewer_type", async () => {
    const mocks = { submission: {}, review: {} };
    const app = buildApp(mocks);
    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/review`)
      .send({ decision: "approved", reviewer_type: "bot" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("reviewer_type");
  });
});

describe("POST /api/v1/submissions/:id/review-tokens", () => {
  it("generates approve and reject tokens for pending submission", async () => {
    const mocks = {
      submission: { findUnique: vi.fn().mockResolvedValue({ id: UUID, status: "pending" }) },
      review: {},
    };
    const app = buildApp(mocks);
    const res = await request(app).post(`/api/v1/submissions/${UUID}/review-tokens`);

    expect(res.status).toBe(201);
    expect(res.body.approve_token).toBeDefined();
    expect(res.body.reject_token).toBeDefined();
    expect(res.body.expires_at).toBeDefined();
    expect(typeof res.body.approve_token).toBe("string");
    expect(res.body.approve_token).toHaveLength(64);
  });

  it("returns 409 for non-pending submission", async () => {
    const mocks = {
      submission: { findUnique: vi.fn().mockResolvedValue({ id: UUID, status: "approved" }) },
      review: {},
    };
    const app = buildApp(mocks);
    const res = await request(app).post(`/api/v1/submissions/${UUID}/review-tokens`);

    expect(res.status).toBe(409);
  });

  it("returns 404 for non-existent submission", async () => {
    const mocks = {
      submission: { findUnique: vi.fn().mockResolvedValue(null) },
      review: {},
    };
    const app = buildApp(mocks);
    const res = await request(app).post(`/api/v1/submissions/${UUID}/review-tokens`);

    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/submissions/review-actions/:token", () => {
  it("uses a valid approve token", async () => {
    const token = "valid-approve-token-abc123";
    actionTokens.set(token, {
      submissionId: UUID,
      decision: "approved",
      expiresAt: Date.now() + 60000,
    });

    const createFn = vi.fn().mockResolvedValue({
      id: UUID2,
      submissionId: UUID,
      decision: "approved",
      createdAt: new Date("2026-01-01"),
    });
    const mocks = {
      submission: {
        findUnique: vi.fn().mockResolvedValue(pendingSubmission()),
        update: vi.fn().mockResolvedValue({}),
      },
      review: { create: createFn },
    };
    const app = buildApp(mocks);
    const res = await request(app).post(`/api/v1/submissions/review-actions/${token}`);

    expect(res.status).toBe(201);
    expect(res.body.decision).toBe("approved");
    // Token should be consumed
    expect(actionTokens.has(token)).toBe(false);
  });

  it("returns 404 for unknown token", async () => {
    const mocks = { submission: {}, review: {} };
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/submissions/review-actions/unknown-token");

    expect(res.status).toBe(404);
  });

  it("returns 410 for expired token", async () => {
    const token = "expired-token-xyz";
    actionTokens.set(token, {
      submissionId: UUID,
      decision: "approved",
      expiresAt: Date.now() - 1000, // already expired
    });

    const mocks = { submission: {}, review: {} };
    const app = buildApp(mocks);
    const res = await request(app).post(`/api/v1/submissions/review-actions/${token}`);

    expect(res.status).toBe(410);
    expect(actionTokens.has(token)).toBe(false);
  });

  it("returns 409 if submission already reviewed", async () => {
    const token = "conflict-token";
    actionTokens.set(token, {
      submissionId: UUID,
      decision: "approved",
      expiresAt: Date.now() + 60000,
    });

    const mocks = {
      submission: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            pendingSubmission([{ id: "rev-1", reviewerType: "human", decision: "approved" }]),
          ),
      },
      review: {},
    };
    const app = buildApp(mocks);
    const res = await request(app).post(`/api/v1/submissions/review-actions/${token}`);

    expect(res.status).toBe(409);
  });
});
