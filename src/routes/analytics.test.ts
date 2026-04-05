import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createAnalyticsRouter } from "./analytics.js";

const now = new Date("2026-04-05T12:00:00Z");
const oneHourAgo = new Date(now.getTime() - 3600 * 1000);
const twoHoursAgo = new Date(now.getTime() - 7200 * 1000);

const submissions = [
  { id: "s1", status: "approved", channel: "email", decidedBy: "rules", decidedAt: new Date(oneHourAgo.getTime() + 300000), createdAt: oneHourAgo },
  { id: "s2", status: "rejected", channel: "slack", decidedBy: "ai", decidedAt: new Date(twoHoursAgo.getTime() + 600000), createdAt: twoHoursAgo },
  { id: "s3", status: "pending", channel: "email", decidedBy: null, decidedAt: null, createdAt: now },
  { id: "s4", status: "approved", channel: "email", decidedBy: "human", decidedAt: new Date(oneHourAgo.getTime() + 1800000), createdAt: oneHourAgo },
];

const reviews = [
  { submissionId: "s2", reviewerType: "ai", decision: "rejected", confidence: 0.9, createdAt: twoHoursAgo },
  { submissionId: "s4", reviewerType: "human", decision: "approved", confidence: null, createdAt: oneHourAgo },
  { submissionId: "s2", reviewerType: "ai", decision: "escalated", confidence: 0.6, createdAt: twoHoursAgo },
];

const feedbacks = [
  { outcome: "positive" },
  { outcome: "negative" },
  { outcome: "positive" },
];

const policyEvals = [
  { result: "pass", actionTaken: "info", policy: { name: "length-check" } },
  { result: "block", actionTaken: "block", policy: { name: "profanity" } },
  { result: "flag", actionTaken: "flag", policy: { name: "profanity" } },
];

const guardrailEvals = [
  { verdict: "pass", confidence: 0.95, guardrail: { name: "toxicity" } },
  { verdict: "fail", confidence: 0.8, guardrail: { name: "toxicity" } },
  { verdict: "pass", confidence: 0.99, guardrail: { name: "pii-detector" } },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseMocks(): any {
  return {
    submission: {
      findMany: vi.fn().mockResolvedValue(submissions),
      count: vi.fn().mockResolvedValue(submissions.length),
    },
    review: {
      findMany: vi.fn().mockResolvedValue(reviews),
    },
    feedback: {
      findMany: vi.fn().mockResolvedValue(feedbacks),
    },
    policyEvaluation: {
      findMany: vi.fn().mockResolvedValue(policyEvals),
    },
    guardrailEvaluation: {
      findMany: vi.fn().mockResolvedValue(guardrailEvals),
    },
  };
}

function buildApp(mockPrisma: ReturnType<typeof baseMocks>) {
  const prisma = mockPrisma as unknown as Parameters<typeof createAnalyticsRouter>[0];
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    _req.apiKey = { id: "key-1", name: "test-key" };
    next();
  });
  app.use("/api/v1/analytics", createAnalyticsRouter(prisma));
  return app;
}

describe("GET /api/v1/analytics/summary", () => {
  it("returns all summary fields", async () => {
    const app = buildApp(baseMocks());
    const res = await request(app).get("/api/v1/analytics/summary");

    expect(res.status).toBe(200);
    expect(res.body.total_submissions).toBe(4);
    expect(res.body.approved).toBe(2);
    expect(res.body.rejected).toBe(1);
    expect(res.body.pending).toBe(1);
    expect(res.body.approval_rate).toBe(0.5);
    expect(res.body.avg_review_time_seconds).toBeGreaterThan(0);
    expect(res.body.median_review_time_seconds).toBeGreaterThan(0);
    expect(res.body.sla_compliance_rate).toBeGreaterThanOrEqual(0);
  });

  it("returns top rejection reasons", async () => {
    const app = buildApp(baseMocks());
    const res = await request(app).get("/api/v1/analytics/summary");

    expect(res.body.top_rejection_reasons).toHaveLength(1);
    expect(res.body.top_rejection_reasons[0].reason).toBe("profanity");
    expect(res.body.top_rejection_reasons[0].count).toBe(2);
  });

  it("returns channel breakdown", async () => {
    const app = buildApp(baseMocks());
    const res = await request(app).get("/api/v1/analytics/summary");

    expect(res.body.by_channel.email.total).toBe(3);
    expect(res.body.by_channel.slack.total).toBe(1);
  });

  it("returns feedback summary", async () => {
    const app = buildApp(baseMocks());
    const res = await request(app).get("/api/v1/analytics/summary");

    expect(res.body.feedback_summary.total).toBe(3);
    expect(res.body.feedback_summary.positive).toBe(2);
    expect(res.body.feedback_summary.negative).toBe(1);
  });

  it("returns review tier funnel", async () => {
    const app = buildApp(baseMocks());
    const res = await request(app).get("/api/v1/analytics/summary");

    const funnel = res.body.review_tier_funnel;
    expect(funnel.auto_approved_by_rules).toBe(1);
    expect(funnel.auto_rejected_by_rules).toBe(0);
    expect(funnel.cleared_by_guardrails).toBe(2);
    expect(funnel.rejected_by_guardrails).toBe(1);
    expect(funnel.decided_by_human).toBe(1);
    expect(funnel.escalated_to_human).toBe(1);
  });

  it("returns AI review stats", async () => {
    const app = buildApp(baseMocks());
    const res = await request(app).get("/api/v1/analytics/summary");

    expect(res.body.ai_review_stats.total_ai_reviews).toBe(2);
    expect(res.body.ai_review_stats.avg_ai_confidence).toBe(0.75);
    expect(res.body.ai_review_stats.ai_escalation_rate).toBe(0.5);
  });

  it("returns guardrail stats", async () => {
    const app = buildApp(baseMocks());
    const res = await request(app).get("/api/v1/analytics/summary");

    expect(res.body.guardrail_stats.total_evaluations).toBe(3);
    expect(res.body.guardrail_stats.by_guardrail.toxicity.pass).toBe(1);
    expect(res.body.guardrail_stats.by_guardrail.toxicity.fail).toBe(1);
    expect(res.body.guardrail_stats.by_guardrail["pii-detector"].pass).toBe(1);
  });

  it("applies date range filter", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    await request(app).get("/api/v1/analytics/summary?from=2026-04-01&to=2026-04-30");

    const call = mocks.submission.findMany.mock.calls[0][0];
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
  });

  it("applies channel filter", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    await request(app).get("/api/v1/analytics/summary?channel=email");

    const call = mocks.submission.findMany.mock.calls[0][0];
    expect(call.where.channel).toBe("email");
  });

  it("rejects invalid date", async () => {
    const app = buildApp(baseMocks());
    const res = await request(app).get("/api/v1/analytics/summary?from=not-a-date");
    expect(res.status).toBe(400);
  });

  it("handles empty data", async () => {
    const mocks = baseMocks();
    mocks.submission.findMany = vi.fn().mockResolvedValue([]);
    mocks.review.findMany = vi.fn().mockResolvedValue([]);
    mocks.feedback.findMany = vi.fn().mockResolvedValue([]);
    mocks.policyEvaluation.findMany = vi.fn().mockResolvedValue([]);
    mocks.guardrailEvaluation.findMany = vi.fn().mockResolvedValue([]);
    const app = buildApp(mocks);
    const res = await request(app).get("/api/v1/analytics/summary");

    expect(res.status).toBe(200);
    expect(res.body.total_submissions).toBe(0);
    expect(res.body.approval_rate).toBe(0);
    expect(res.body.avg_review_time_seconds).toBe(0);
  });
});

describe("GET /api/v1/analytics/submissions", () => {
  it("returns paginated submissions", async () => {
    const mocks = baseMocks();
    mocks.submission.findMany = vi.fn().mockResolvedValue([
      {
        id: "s1",
        channel: "email",
        contentType: "text/plain",
        status: "approved",
        decidedBy: "rules",
        createdAt: oneHourAgo,
        decidedAt: new Date(oneHourAgo.getTime() + 300000),
        policyEvaluations: [{ result: "pass", actionTaken: "info", policy: { name: "check" } }],
      },
    ]);
    const app = buildApp(mocks);
    const res = await request(app).get("/api/v1/analytics/submissions?page=1&per_page=10");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("s1");
    expect(res.body.page).toBe(1);
    expect(res.body.per_page).toBe(10);
    expect(res.body.total).toBe(4);
    expect(res.body.total_pages).toBe(1);
  });

  it("applies status filter", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    await request(app).get("/api/v1/analytics/submissions?status=pending");

    const call = mocks.submission.findMany.mock.calls[0][0];
    expect(call.where.status).toBe("pending");
  });

  it("applies policy_triggered filter", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    await request(app).get("/api/v1/analytics/submissions?policy_triggered=profanity");

    const call = mocks.submission.findMany.mock.calls[0][0];
    expect(call.where.policyEvaluations.some.policy.name).toBe("profanity");
  });

  it("clamps per_page to valid range", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    await request(app).get("/api/v1/analytics/submissions?per_page=500");

    const call = mocks.submission.findMany.mock.calls[0][0];
    expect(call.take).toBe(100);
  });
});
