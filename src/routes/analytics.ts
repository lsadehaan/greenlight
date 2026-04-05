import { Router } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { Prisma } from "../generated/prisma/client.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface SummaryFilters {
  from?: Date;
  to?: Date;
  channel?: string;
}

interface ReviewTimeRow {
  decided_count: number;
  avg_review_seconds: number;
  median_review_seconds: number;
  sla_compliant_count: number;
}

interface GuardrailFunnelRow {
  cleared_submissions: number;
  rejected_submissions: number;
}

interface AIStatsRow {
  total_ai_reviews: number;
  avg_confidence: number;
  approved_count: number;
  rejected_count: number;
  escalated_count: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildPrismaWhere(filters: SummaryFilters): Record<string, unknown> {
  const dateFilter: Record<string, unknown> = {};
  if (filters.from) dateFilter.gte = filters.from;
  if (filters.to) dateFilter.lte = filters.to;
  const where: Record<string, unknown> = {};
  if (Object.keys(dateFilter).length > 0) where.createdAt = dateFilter;
  if (filters.channel) where.channel = filters.channel;
  return where;
}

function buildSqlFilter(filters: SummaryFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (filters.from) parts.push(Prisma.sql`s.created_at >= ${filters.from}`);
  if (filters.to) parts.push(Prisma.sql`s.created_at <= ${filters.to}`);
  if (filters.channel) parts.push(Prisma.sql`s.channel = ${filters.channel}`);
  return parts.length > 0
    ? Prisma.sql`AND ${Prisma.join(parts, " AND ")}`
    : Prisma.empty;
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// ── Summary computation (shared with dashboard) ─────────────────────────────

export async function computeSummary(prisma: PrismaClient, filters: SummaryFilters = {}) {
  const where = buildPrismaWhere(filters);
  const sf = buildSqlFilter(filters);

  const [
    statusCounts,
    channelCounts,
    reviewTimeStats,
    rejectionReasons,
    feedbackCounts,
    rulesCounts,
    guardrailFunnel,
    aiStats,
    humanReviewCount,
    guardrailByNameRows,
  ] = await Promise.all([
    // 1. Status breakdown
    prisma.submission.groupBy({
      by: ["status"],
      _count: { _all: true },
      where,
    }),

    // 2. Channel + status breakdown
    prisma.submission.groupBy({
      by: ["channel", "status"],
      _count: { _all: true },
      where,
    }),

    // 3. Avg/median review time + SLA compliance
    prisma.$queryRaw<ReviewTimeRow[]>`
      SELECT
        COUNT(*)::int AS decided_count,
        COALESCE(AVG(EXTRACT(EPOCH FROM (s.decided_at - s.created_at))), 0)::float8 AS avg_review_seconds,
        COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (s.decided_at - s.created_at))
        ), 0)::float8 AS median_review_seconds,
        COUNT(*) FILTER (
          WHERE EXTRACT(EPOCH FROM (s.decided_at - s.created_at)) / 60 <= 60
        )::int AS sla_compliant_count
      FROM submission s
      WHERE s.decided_at IS NOT NULL ${sf}
    `,

    // 4. Top rejection reasons (policy name via JOIN)
    prisma.$queryRaw<{ name: string; count: number }[]>`
      SELECT p.name, COUNT(*)::int AS count
      FROM policy_evaluation pe
      JOIN policy p ON pe.policy_id = p.id
      JOIN submission s ON pe.submission_id = s.id
      WHERE pe.result IN ('block', 'flag') ${sf}
      GROUP BY p.name
      ORDER BY count DESC
      LIMIT 10
    `,

    // 5. Feedback breakdown
    prisma.feedback.groupBy({
      by: ["outcome"],
      _count: { _all: true },
      where: { submission: where },
    }),

    // 6. Rules auto-decided funnel
    prisma.submission.groupBy({
      by: ["status"],
      _count: { _all: true },
      where: { ...where, decidedBy: "rules" },
    }),

    // 7. Guardrail funnel: count DISTINCT submissions (not evaluations)
    prisma.$queryRaw<GuardrailFunnelRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE NOT has_fail)::int AS cleared_submissions,
        COUNT(*) FILTER (WHERE has_fail)::int AS rejected_submissions
      FROM (
        SELECT ge.submission_id, BOOL_OR(ge.verdict = 'fail') AS has_fail
        FROM guardrail_evaluation ge
        JOIN submission s ON ge.submission_id = s.id
        WHERE TRUE ${sf}
        GROUP BY ge.submission_id
      ) sub_verdicts
    `,

    // 8. AI review aggregate
    prisma.$queryRaw<AIStatsRow[]>`
      SELECT
        COUNT(*)::int AS total_ai_reviews,
        COALESCE(AVG(r.confidence), 0)::float8 AS avg_confidence,
        COUNT(*) FILTER (WHERE r.decision = 'approved')::int AS approved_count,
        COUNT(*) FILTER (WHERE r.decision = 'rejected')::int AS rejected_count,
        COUNT(*) FILTER (WHERE r.decision = 'escalated')::int AS escalated_count
      FROM review r
      JOIN submission s ON r.submission_id = s.id
      WHERE r.reviewer_type = 'ai' ${sf}
    `,

    // 9. Human review count
    prisma.review.count({
      where: { reviewerType: "human", submission: where },
    }),

    // 10. Guardrail stats by name
    prisma.$queryRaw<{ name: string; verdict: string; count: number }[]>`
      SELECT g.name, ge.verdict::text AS verdict, COUNT(*)::int AS count
      FROM guardrail_evaluation ge
      JOIN guardrail g ON ge.guardrail_id = g.id
      JOIN submission s ON ge.submission_id = s.id
      WHERE TRUE ${sf}
      GROUP BY g.name, ge.verdict
    `,
  ]);

  // Process status counts
  const statusMap: Record<string, number> = {};
  for (const row of statusCounts) {
    statusMap[row.status] = row._count._all;
  }
  const approved = statusMap["approved"] || 0;
  const rejected = statusMap["rejected"] || 0;
  const pending = statusMap["pending"] || 0;
  const total = approved + rejected + pending;
  const approvalRate = total > 0 ? approved / total : 0;

  // Process channel breakdown
  const byChannel: Record<string, { total: number; approved: number; rejected: number; pending: number }> = {};
  for (const row of channelCounts) {
    if (!byChannel[row.channel]) {
      byChannel[row.channel] = { total: 0, approved: 0, rejected: 0, pending: 0 };
    }
    const count = row._count._all;
    byChannel[row.channel].total += count;
    if (row.status === "approved") byChannel[row.channel].approved = count;
    else if (row.status === "rejected") byChannel[row.channel].rejected = count;
    else if (row.status === "pending") byChannel[row.channel].pending = count;
  }

  // Review time stats
  const rts = reviewTimeStats[0];
  const decidedCount = rts?.decided_count ?? 0;
  const avgReviewTime = rts?.avg_review_seconds ?? 0;
  const medianReviewTime = rts?.median_review_seconds ?? 0;
  const slaComplianceRate = decidedCount > 0 ? (rts?.sla_compliant_count ?? 0) / decidedCount : 1;

  // Rejection reasons
  const topRejectionReasons = rejectionReasons.map((r) => ({
    reason: r.name,
    count: Number(r.count),
  }));

  // Feedback summary
  const feedbackMap: Record<string, number> = {};
  let feedbackTotal = 0;
  for (const row of feedbackCounts) {
    feedbackMap[row.outcome] = row._count._all;
    feedbackTotal += row._count._all;
  }

  // Rules funnel
  const rulesMap: Record<string, number> = {};
  for (const row of rulesCounts) {
    rulesMap[row.status] = row._count._all;
  }

  // Guardrail funnel (distinct submissions, not evaluations)
  const gf = guardrailFunnel[0];

  // AI stats
  const ai = aiStats[0];
  const totalAi = ai?.total_ai_reviews ?? 0;

  // Guardrail stats by name
  const guardrailByName: Record<string, { pass: number; fail: number; flag: number }> = {};
  let totalGuardrailEvals = 0;
  for (const row of guardrailByNameRows) {
    if (!guardrailByName[row.name]) {
      guardrailByName[row.name] = { pass: 0, fail: 0, flag: 0 };
    }
    const count = Number(row.count);
    if (row.verdict === "pass") guardrailByName[row.name].pass = count;
    else if (row.verdict === "fail") guardrailByName[row.name].fail = count;
    else if (row.verdict === "flag") guardrailByName[row.name].flag = count;
    totalGuardrailEvals += count;
  }

  return {
    total_submissions: total,
    approved,
    rejected,
    pending,
    approval_rate: round(approvalRate, 4),
    avg_review_time_seconds: round(avgReviewTime, 2),
    median_review_time_seconds: round(medianReviewTime, 2),
    top_rejection_reasons: topRejectionReasons,
    by_channel: byChannel,
    feedback_summary: {
      total: feedbackTotal,
      positive: feedbackMap["positive"] || 0,
      negative: feedbackMap["negative"] || 0,
      neutral: feedbackMap["neutral"] || 0,
    },
    sla_compliance_rate: round(slaComplianceRate, 4),
    review_tier_funnel: {
      auto_approved_by_rules: rulesMap["approved"] || 0,
      auto_rejected_by_rules: rulesMap["rejected"] || 0,
      cleared_by_guardrails: gf?.cleared_submissions ?? 0,
      rejected_by_guardrails: gf?.rejected_submissions ?? 0,
      cleared_by_ai_review: ai?.approved_count ?? 0,
      rejected_by_ai_review: ai?.rejected_count ?? 0,
      escalated_to_human: ai?.escalated_count ?? 0,
      decided_by_human: humanReviewCount,
    },
    ai_review_stats: {
      total_ai_reviews: totalAi,
      avg_ai_confidence: round(ai?.avg_confidence ?? 0, 4),
      ai_escalation_rate: round(totalAi > 0 ? (ai?.escalated_count ?? 0) / totalAi : 0, 4),
    },
    guardrail_stats: {
      total_evaluations: totalGuardrailEvals,
      by_guardrail: guardrailByName,
    },
  };
}

// ── Router ───────────────────────────────────────────────────────────────────

export function createAnalyticsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // GET /api/v1/analytics/summary
  router.get("/summary", async (req, res) => {
    const from = req.query.from ? new Date(req.query.from as string) : undefined;
    const to = req.query.to ? new Date(req.query.to as string) : undefined;
    const channel = (req.query.channel as string) || undefined;

    if (from && isNaN(from.getTime())) {
      res.status(400).json({ error: "bad_request", message: "Invalid 'from' date" });
      return;
    }
    if (to && isNaN(to.getTime())) {
      res.status(400).json({ error: "bad_request", message: "Invalid 'to' date" });
      return;
    }

    const summary = await computeSummary(prisma, { from, to, channel });
    res.json(summary);
  });

  // GET /api/v1/analytics/submissions — paginated history
  router.get("/submissions", async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string) || 20));
    const status = (req.query.status as string) || undefined;
    const channel = (req.query.channel as string) || undefined;
    const from = req.query.from ? new Date(req.query.from as string) : undefined;
    const to = req.query.to ? new Date(req.query.to as string) : undefined;
    const policyTriggered = (req.query.policy_triggered as string) || undefined;

    if (from && isNaN(from.getTime())) {
      res.status(400).json({ error: "bad_request", message: "Invalid 'from' date" });
      return;
    }
    if (to && isNaN(to.getTime())) {
      res.status(400).json({ error: "bad_request", message: "Invalid 'to' date" });
      return;
    }

    const dateFilter: Record<string, unknown> = {};
    if (from) dateFilter.gte = from;
    if (to) dateFilter.lte = to;

    const where: Record<string, unknown> = {};
    if (Object.keys(dateFilter).length > 0) where.createdAt = dateFilter;
    if (status) where.status = status;
    if (channel) where.channel = channel;
    if (policyTriggered) {
      where.policyEvaluations = {
        some: {
          policy: { name: policyTriggered },
          result: { in: ["flag", "block"] },
        },
      };
    }

    const [data, total] = await Promise.all([
      prisma.submission.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          id: true,
          channel: true,
          contentType: true,
          status: true,
          decidedBy: true,
          createdAt: true,
          decidedAt: true,
          policyEvaluations: {
            select: {
              result: true,
              actionTaken: true,
              policy: { select: { name: true } },
            },
          },
        },
      }),
      prisma.submission.count({ where }),
    ]);

    res.json({
      data: data.map((s) => ({
        id: s.id,
        channel: s.channel,
        content_type: s.contentType,
        status: s.status,
        decided_by: s.decidedBy,
        created_at: s.createdAt.toISOString(),
        decided_at: s.decidedAt?.toISOString() ?? null,
        policy_results: s.policyEvaluations.map((pe) => ({
          policy_name: (pe.policy as { name: string }).name,
          result: pe.result,
          action_taken: pe.actionTaken,
        })),
      })),
      total,
      page,
      per_page: perPage,
      total_pages: Math.ceil(total / perPage),
    });
  });

  return router;
}
