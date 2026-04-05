import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createFeedbackRouter } from "./feedback.js";

const UUID = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";

function buildApp(mockPrisma: Record<string, unknown>) {
  const prisma = mockPrisma as unknown as Parameters<typeof createFeedbackRouter>[0];
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    _req.apiKey = { id: "api-key-1", name: "test-key" };
    next();
  });
  app.use("/api/v1/submissions", createFeedbackRouter(prisma));
  return app;
}

describe("POST /api/v1/submissions/:id/feedback", () => {
  it("creates positive feedback", async () => {
    const createFn = vi.fn().mockResolvedValue({
      id: UUID2,
      submissionId: UUID,
      outcome: "positive",
      reason: null,
      data: null,
      createdAt: new Date("2026-01-01"),
    });
    const app = buildApp({
      submission: { findUnique: vi.fn().mockResolvedValue({ id: UUID }) },
      feedback: { create: createFn },
    });

    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/feedback`)
      .send({ outcome: "positive" });

    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe("positive");
    expect(res.body.submission_id).toBe(UUID);
    expect(createFn).toHaveBeenCalledOnce();
  });

  it("creates negative feedback with reason and data", async () => {
    const createFn = vi.fn().mockResolvedValue({
      id: UUID2,
      submissionId: UUID,
      outcome: "negative",
      reason: "Customer complained",
      data: { complaint_id: "C-123" },
      createdAt: new Date("2026-01-01"),
    });
    const app = buildApp({
      submission: { findUnique: vi.fn().mockResolvedValue({ id: UUID }) },
      feedback: { create: createFn },
    });

    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/feedback`)
      .send({
        outcome: "negative",
        reason: "Customer complained",
        data: { complaint_id: "C-123" },
      });

    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe("negative");
    expect(res.body.reason).toBe("Customer complained");
    expect(res.body.data).toEqual({ complaint_id: "C-123" });
  });

  it("creates neutral feedback", async () => {
    const createFn = vi.fn().mockResolvedValue({
      id: UUID2,
      submissionId: UUID,
      outcome: "neutral",
      reason: "No impact observed",
      data: null,
      createdAt: new Date("2026-01-01"),
    });
    const app = buildApp({
      submission: { findUnique: vi.fn().mockResolvedValue({ id: UUID }) },
      feedback: { create: createFn },
    });

    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/feedback`)
      .send({ outcome: "neutral", reason: "No impact observed" });

    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe("neutral");
  });

  it("returns 400 for invalid outcome", async () => {
    const app = buildApp({
      submission: { findUnique: vi.fn() },
      feedback: { create: vi.fn() },
    });

    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/feedback`)
      .send({ outcome: "bad" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("outcome");
  });

  it("returns 400 for missing outcome", async () => {
    const app = buildApp({
      submission: { findUnique: vi.fn() },
      feedback: { create: vi.fn() },
    });

    const res = await request(app).post(`/api/v1/submissions/${UUID}/feedback`).send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("outcome");
  });

  it("returns 400 for invalid submission ID format", async () => {
    const app = buildApp({
      submission: { findUnique: vi.fn() },
      feedback: { create: vi.fn() },
    });

    const res = await request(app)
      .post("/api/v1/submissions/not-a-uuid/feedback")
      .send({ outcome: "positive" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Invalid submission ID");
  });

  it("returns 404 for non-existent submission", async () => {
    const app = buildApp({
      submission: { findUnique: vi.fn().mockResolvedValue(null) },
      feedback: { create: vi.fn() },
    });

    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/feedback`)
      .send({ outcome: "positive" });

    expect(res.status).toBe(404);
    expect(res.body.message).toContain("Submission not found");
  });

  it("returns 400 for non-object data", async () => {
    const app = buildApp({
      submission: { findUnique: vi.fn().mockResolvedValue({ id: UUID }) },
      feedback: { create: vi.fn() },
    });

    const res = await request(app)
      .post(`/api/v1/submissions/${UUID}/feedback`)
      .send({ outcome: "positive", data: [1, 2, 3] });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("data must be a JSON object");
  });

  it("allows multiple feedback on the same submission", async () => {
    let callCount = 0;
    const createFn = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        id: `00000000-0000-0000-0000-00000000000${callCount}`,
        submissionId: UUID,
        outcome: callCount === 1 ? "positive" : "negative",
        reason: null,
        data: null,
        createdAt: new Date("2026-01-01"),
      });
    });
    const app = buildApp({
      submission: { findUnique: vi.fn().mockResolvedValue({ id: UUID }) },
      feedback: { create: createFn },
    });

    const res1 = await request(app)
      .post(`/api/v1/submissions/${UUID}/feedback`)
      .send({ outcome: "positive" });
    const res2 = await request(app)
      .post(`/api/v1/submissions/${UUID}/feedback`)
      .send({ outcome: "negative" });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(createFn).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/v1/submissions/:id/feedback", () => {
  it("lists feedback with counts", async () => {
    const feedbacks = [
      {
        id: UUID2,
        submissionId: UUID,
        outcome: "positive",
        reason: null,
        data: null,
        createdAt: new Date("2026-01-01"),
      },
      {
        id: "00000000-0000-0000-0000-000000000003",
        submissionId: UUID,
        outcome: "negative",
        reason: "Bad tone",
        data: null,
        createdAt: new Date("2026-01-02"),
      },
    ];
    const app = buildApp({
      submission: { findUnique: vi.fn().mockResolvedValue({ id: UUID }) },
      feedback: { findMany: vi.fn().mockResolvedValue(feedbacks) },
    });

    const res = await request(app).get(`/api/v1/submissions/${UUID}/feedback`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.counts).toEqual({ positive: 1, negative: 1, neutral: 0 });
  });

  it("returns empty list for submission with no feedback", async () => {
    const app = buildApp({
      submission: { findUnique: vi.fn().mockResolvedValue({ id: UUID }) },
      feedback: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const res = await request(app).get(`/api/v1/submissions/${UUID}/feedback`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(0);
    expect(res.body.counts).toEqual({ positive: 0, negative: 0, neutral: 0 });
  });

  it("returns 404 for non-existent submission", async () => {
    const app = buildApp({
      submission: { findUnique: vi.fn().mockResolvedValue(null) },
      feedback: { findMany: vi.fn() },
    });

    const res = await request(app).get(`/api/v1/submissions/${UUID}/feedback`);

    expect(res.status).toBe(404);
    expect(res.body.message).toContain("Submission not found");
  });

  it("returns 400 for invalid submission ID", async () => {
    const app = buildApp({
      submission: { findUnique: vi.fn() },
      feedback: { findMany: vi.fn() },
    });

    const res = await request(app).get("/api/v1/submissions/not-a-uuid/feedback");

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Invalid submission ID");
  });
});
