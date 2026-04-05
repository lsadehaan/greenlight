import { Router } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";

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

    const dateFilter: Record<string, unknown> = {};
    if (from) dateFilter.gte = from;
    if (to) dateFilter.lte = to;

    const where: Record<string, unknown> = {};
    if (Object.keys(dateFilter).length > 0) where.createdAt = dateFilter;
    if (channel) where.channel = channel;

    const [submissions, reviews, feedbacks, policyEvals, guardrailEvals] = await Promise.all([
      prisma.submission.findMany({
        where,
        select: {
          id: true,
          status: true,
          channel: true,
          decidedBy: true,
          decidedAt: true,
          createdAt: true,
        },
      }),
      prisma.review.findMany({
        where: {
          submission: where,
        },
        select: {
          submissionId: true,
          reviewerType: true,
          decision: true,
          confidence: true,
          createdAt: true,
        },
      }),
      prisma.feedback.findMany({
        where: { submission: where },
        select: { outcome: true },
      }),
      prisma.policyEvaluation.findMany({
        where: { submission: where },
        select: {
          result: true,
          actionTaken: true,
          policy: { select: { name: true } },
        },
      }),
      prisma.guardrailEvaluation.findMany({
        where: { submission: where },
        select: {
          verdict: true,
          confidence: true,
          guardrail: { select: { name: true } },
        },
      }),
    ]);

    const total = submissions.length;
    const approved = submissions.filter((s) => s.status === "approved").length;
    const rejected = submissions.filter((s) => s.status === "rejected").length;
    const pending = submissions.filter((s) => s.status === "pending").length;
    const approvalRate = total > 0 ? approved / total : 0;

    // Review times (seconds)
    const reviewTimes = submissions
      .filter((s) => s.decidedAt)
      .map((s) => (s.decidedAt!.getTime() - s.createdAt.getTime()) / 1000);
    const avgReviewTime = reviewTimes.length > 0
      ? reviewTimes.reduce((a, b) => a + b, 0) / reviewTimes.length
      : 0;
    const medianReviewTime = median(reviewTimes);

    // Top rejection reasons from policy evaluations
    const rejectionReasons: Record<string, number> = {};
    for (const pe of policyEvals) {
      if (pe.result === "block" || pe.result === "flag") {
        const name = (pe.policy as { name: string }).name;
        rejectionReasons[name] = (rejectionReasons[name] || 0) + 1;
      }
    }
    const topRejectionReasons = Object.entries(rejectionReasons)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count }));

    // By channel
    const byChannel: Record<string, { total: number; approved: number; rejected: number; pending: number }> = {};
    for (const sub of submissions) {
      if (!byChannel[sub.channel]) {
        byChannel[sub.channel] = { total: 0, approved: 0, rejected: 0, pending: 0 };
      }
      byChannel[sub.channel].total++;
      if (sub.status === "approved") byChannel[sub.channel].approved++;
      else if (sub.status === "rejected") byChannel[sub.channel].rejected++;
      else byChannel[sub.channel].pending++;
    }

    // Feedback summary
    const feedbackSummary = {
      total: feedbacks.length,
      positive: feedbacks.filter((f) => f.outcome === "positive").length,
      negative: feedbacks.filter((f) => f.outcome === "negative").length,
      neutral: feedbacks.filter((f) => f.outcome === "neutral").length,
    };

    // Review tier funnel
    const funnel = buildTierFunnel(submissions, policyEvals, guardrailEvals, reviews);

    // AI review stats
    const aiReviews = reviews.filter((r) => r.reviewerType === "ai");
    const aiConfidences = aiReviews
      .filter((r) => r.confidence != null)
      .map((r) => r.confidence as number);
    const aiEscalated = aiReviews.filter((r) => r.decision === "escalated").length;
    const aiStats = {
      total_ai_reviews: aiReviews.length,
      avg_ai_confidence: aiConfidences.length > 0
        ? aiConfidences.reduce((a, b) => a + b, 0) / aiConfidences.length
        : 0,
      ai_escalation_rate: aiReviews.length > 0 ? aiEscalated / aiReviews.length : 0,
    };

    // Guardrail stats
    const guardrailByName: Record<string, { pass: number; fail: number; flag: number }> = {};
    for (const ge of guardrailEvals) {
      const name = (ge.guardrail as { name: string }).name;
      if (!guardrailByName[name]) guardrailByName[name] = { pass: 0, fail: 0, flag: 0 };
      if (ge.verdict === "pass") guardrailByName[name].pass++;
      else if (ge.verdict === "fail") guardrailByName[name].fail++;
      else if (ge.verdict === "flag") guardrailByName[name].flag++;
    }
    const guardrailStats = {
      total_evaluations: guardrailEvals.length,
      by_guardrail: guardrailByName,
    };

    // SLA compliance (submissions decided within 60 minutes)
    const decided = submissions.filter((s) => s.decidedAt);
    const withinSLA = decided.filter(
      (s) => (s.decidedAt!.getTime() - s.createdAt.getTime()) / 60000 <= 60,
    );
    const slaComplianceRate = decided.length > 0 ? withinSLA.length / decided.length : 1;

    res.json({
      total_submissions: total,
      approved,
      rejected,
      pending,
      approval_rate: round(approvalRate, 4),
      avg_review_time_seconds: round(avgReviewTime, 2),
      median_review_time_seconds: round(medianReviewTime, 2),
      top_rejection_reasons: topRejectionReasons,
      by_channel: byChannel,
      feedback_summary: feedbackSummary,
      sla_compliance_rate: round(slaComplianceRate, 4),
      review_tier_funnel: funnel,
      ai_review_stats: aiStats,
      guardrail_stats: guardrailStats,
    });
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

function buildTierFunnel(
  submissions: { id: string; status: string; decidedBy: string | null }[],
  policyEvals: { result: string; actionTaken: string }[],
  guardrailEvals: { verdict: string }[],
  reviews: { submissionId: string; reviewerType: string; decision: string }[],
) {
  const autoApprovedByRules = submissions.filter((s) => s.decidedBy === "rules" && s.status === "approved").length;
  const autoRejectedByRules = submissions.filter((s) => s.decidedBy === "rules" && s.status === "rejected").length;

  const guardrailPasses = guardrailEvals.filter((g) => g.verdict === "pass").length;
  const guardrailRejects = guardrailEvals.filter((g) => g.verdict === "fail").length;

  const aiReviews = reviews.filter((r) => r.reviewerType === "ai");
  const aiCleared = aiReviews.filter((r) => r.decision === "approved").length;
  const aiRejected = aiReviews.filter((r) => r.decision === "rejected").length;
  const aiEscalated = aiReviews.filter((r) => r.decision === "escalated").length;

  const humanReviews = reviews.filter((r) => r.reviewerType === "human");

  return {
    auto_approved_by_rules: autoApprovedByRules,
    auto_rejected_by_rules: autoRejectedByRules,
    cleared_by_guardrails: guardrailPasses,
    rejected_by_guardrails: guardrailRejects,
    cleared_by_ai_review: aiCleared,
    rejected_by_ai_review: aiRejected,
    escalated_to_human: aiEscalated,
    decided_by_human: humanReviews.length,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
