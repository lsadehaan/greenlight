import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createAnalyticsRouter } from "./analytics.js";

const now = new Date("2026-04-05T12:00:00Z");
const oneHourAgo = new Date(now.getTime() - 3600 * 1000);

// ── Mock factory ─────────────────────────────────────────────────────────────

// $queryRaw is called 5 times in order:
// 1. reviewTimeStats  2. rejectionReasons  3. guardrailFunnel  4. aiStats  5. guardrailByName
function summaryQueryRawMock() {
  return vi.fn()
    // 1. Review time stats
    .mockResolvedValueOnce([{
      decided_count: 3,
      avg_review_seconds: 550,
      median_review_seconds: 450,
      sla_compliant_count: 2,
    }])
    // 2. Rejection reasons
    .mockResolvedValueOnce([
      { name: "profanity", count: 2 },
    ])
    // 3. Guardrail funnel (distinct submissions)
    .mockResolvedValueOnce([{
      cleared_submissions: 1,
      rejected_submissions: 1,
    }])
    // 4. AI review stats
    .mockResolvedValueOnce([{
      total_ai_reviews: 2,
      avg_confidence: 0.75,
      approved_count: 0,
      rejected_count: 1,
      escalated_count: 1,
    }])
    // 5. Guardrail stats by name
    .mockResolvedValueOnce([
      { name: "toxicity", verdict: "pass", count: 1 },
      { name: "toxicity", verdict: "fail", count: 1 },
      { name: "pii-detector", verdict: "pass", count: 1 },
    ]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseMocks(): any {
  return {
    submission: {
      // groupBy called 3 times: statusCounts, channelCounts, rulesCounts
      groupBy: vi.fn()
        .mockResolvedValueOnce([
          { status: "approved", _count: { _all: 2 } },
          { status: "rejected", _count: { _all: 1 } },
          { status: "pending", _count: { _all: 1 } },
        ])
        .mockResolvedValueOnce([
          { channel: "email", status: "approved", _count: { _all: 2 } },
          { channel: "email", status: "pending", _count: { _all: 1 } },
          { channel: "slack", status: "rejected", _count: { _all: 1 } },
        ])
        .mockResolvedValueOnce([
          { status: "approved", _count: { _all: 1 } },
        ]),
      // findMany + count used by /submissions endpoint
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(4),
    },
    review: {
      count: vi.fn().mockResolvedValue(1),
    },
    feedback: {
      groupBy: vi.fn().mockResolvedValueOnce([
        { outcome: "positive", _count: { _all: 2 } },
        { outcome: "negative", _count: { _all: 1 } },
      ]),
    },
    $queryRaw: summaryQueryRawMock(),
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

// ── Summary endpoint ─────────────────────────────────────────────────────────

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
    expect(res.body.avg_review_time_seconds).toBe(550);
    expect(res.body.median_review_time_seconds).toBe(450);
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

  it("returns review tier funnel with distinct submission counts", async () => {
    const app = buildApp(baseMocks());
    const res = await request(app).get("/api/v1/analytics/summary");

    const funnel = res.body.review_tier_funnel;
    expect(funnel.auto_approved_by_rules).toBe(1);
    expect(funnel.auto_rejected_by_rules).toBe(0);
    // MAJOR 2 fix: counts distinct submissions, not individual evaluations
    expect(funnel.cleared_by_guardrails).toBe(1);
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

  it("applies date range filter to groupBy", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    await request(app).get("/api/v1/analytics/summary?from=2026-04-01&to=2026-04-30");

    // First groupBy call is statusCounts
    const call = mocks.submission.groupBy.mock.calls[0][0];
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
  });

  it("applies channel filter to groupBy", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    await request(app).get("/api/v1/analytics/summary?channel=email");

    const call = mocks.submission.groupBy.mock.calls[0][0];
    expect(call.where.channel).toBe("email");
  });

  it("rejects invalid date", async () => {
    const app = buildApp(baseMocks());
    const res = await request(app).get("/api/v1/analytics/summary?from=not-a-date");
    expect(res.status).toBe(400);
  });

  it("handles empty data", async () => {
    const mocks = baseMocks();
    // Override all mocks with empty results
    mocks.submission.groupBy = vi.fn().mockResolvedValue([]);
    mocks.feedback.groupBy = vi.fn().mockResolvedValue([]);
    mocks.review.count = vi.fn().mockResolvedValue(0);
    mocks.$queryRaw = vi.fn()
      .mockResolvedValueOnce([{ decided_count: 0, avg_review_seconds: 0, median_review_seconds: 0, sla_compliant_count: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cleared_submissions: 0, rejected_submissions: 0 }])
      .mockResolvedValueOnce([{ total_ai_reviews: 0, avg_confidence: 0, approved_count: 0, rejected_count: 0, escalated_count: 0 }])
      .mockResolvedValueOnce([]);
    const app = buildApp(mocks);
    const res = await request(app).get("/api/v1/analytics/summary");

    expect(res.status).toBe(200);
    expect(res.body.total_submissions).toBe(0);
    expect(res.body.approval_rate).toBe(0);
    expect(res.body.avg_review_time_seconds).toBe(0);
  });
});

// ── Submissions endpoint (paginated, unchanged) ─────────────────────────────

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
