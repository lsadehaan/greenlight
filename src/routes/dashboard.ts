import { Router } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ejs from "ejs";
import type { PrismaClient } from "../generated/prisma/client.js";
import { hashApiKey } from "../middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, "..", "views");

function renderPage(templateName: string, data: Record<string, unknown>): string {
  const layout = readFileSync(path.join(VIEWS_DIR, "layout.ejs"), "utf-8");
  const template = readFileSync(path.join(VIEWS_DIR, `${templateName}.ejs`), "utf-8");
  const body = ejs.render(template, data, { filename: path.join(VIEWS_DIR, `${templateName}.ejs`) });
  return ejs.render(layout, { ...data, body }, { filename: path.join(VIEWS_DIR, "layout.ejs") });
}

export function createDashboardRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Auth middleware
  router.use(async (req, res, next) => {
    const token = (req.query.token as string) || "";
    if (!token) {
      res.status(401).send("Access denied. Provide ?token=<api-key> to authenticate.");
      return;
    }
    const keyHash = hashApiKey(token);
    const apiKey = await prisma.apiKey.findUnique({ where: { keyHash } });
    if (!apiKey || !apiKey.active) {
      res.status(401).send("Invalid or inactive API key.");
      return;
    }
    req.apiKey = { id: apiKey.id, name: apiKey.name };
    next();
  });

  // GET /dashboard
  router.get("/", async (req, res) => {
    const token = req.query.token as string;

    const [submissions, reviews, feedbacks, policyEvals, guardrailEvals, pendingCount] = await Promise.all([
      prisma.submission.findMany({
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
        select: {
          submissionId: true,
          reviewerType: true,
          decision: true,
          confidence: true,
          createdAt: true,
        },
      }),
      prisma.feedback.findMany({
        select: { outcome: true },
      }),
      prisma.policyEvaluation.findMany({
        select: {
          result: true,
          actionTaken: true,
          policy: { select: { name: true } },
        },
      }),
      prisma.guardrailEvaluation.findMany({
        select: {
          verdict: true,
          confidence: true,
          guardrail: { select: { name: true } },
        },
      }),
      prisma.submission.count({ where: { status: "pending" } }),
    ]);

    const total = submissions.length;
    const approved = submissions.filter((s) => s.status === "approved").length;
    const rejected = submissions.filter((s) => s.status === "rejected").length;
    const pending = submissions.filter((s) => s.status === "pending").length;
    const approvalRate = total > 0 ? approved / total : 0;

    const reviewTimes = submissions
      .filter((s) => s.decidedAt)
      .map((s) => (s.decidedAt!.getTime() - s.createdAt.getTime()) / 1000);
    const avgReviewTime = reviewTimes.length > 0
      ? reviewTimes.reduce((a, b) => a + b, 0) / reviewTimes.length
      : 0;

    const decided = submissions.filter((s) => s.decidedAt);
    const withinSLA = decided.filter(
      (s) => (s.decidedAt!.getTime() - s.createdAt.getTime()) / 60000 <= 60,
    );
    const slaComplianceRate = decided.length > 0 ? withinSLA.length / decided.length : 1;

    // Top rejection reasons
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

    // Funnel
    const autoApprovedByRules = submissions.filter((s) => s.decidedBy === "rules" && s.status === "approved").length;
    const autoRejectedByRules = submissions.filter((s) => s.decidedBy === "rules" && s.status === "rejected").length;
    const aiReviews = reviews.filter((r) => r.reviewerType === "ai");
    const humanReviews = reviews.filter((r) => r.reviewerType === "human");

    // AI stats
    const aiConfidences = aiReviews
      .filter((r) => r.confidence != null)
      .map((r) => r.confidence as number);
    const aiEscalated = aiReviews.filter((r) => r.decision === "escalated").length;

    // Guardrail stats
    const guardrailByName: Record<string, { pass: number; fail: number; flag: number }> = {};
    for (const ge of guardrailEvals) {
      const name = (ge.guardrail as { name: string }).name;
      if (!guardrailByName[name]) guardrailByName[name] = { pass: 0, fail: 0, flag: 0 };
      if (ge.verdict === "pass") guardrailByName[name].pass++;
      else if (ge.verdict === "fail") guardrailByName[name].fail++;
      else if (ge.verdict === "flag") guardrailByName[name].flag++;
    }

    const feedbackSummary = {
      total: feedbacks.length,
      positive: feedbacks.filter((f) => f.outcome === "positive").length,
      negative: feedbacks.filter((f) => f.outcome === "negative").length,
      neutral: feedbacks.filter((f) => f.outcome === "neutral").length,
    };

    const data = {
      total_submissions: total,
      approved,
      rejected,
      pending,
      approval_rate: approvalRate,
      avg_review_time_seconds: avgReviewTime,
      sla_compliance_rate: slaComplianceRate,
      top_rejection_reasons: topRejectionReasons,
      by_channel: byChannel,
      review_tier_funnel: {
        auto_approved_by_rules: autoApprovedByRules,
        auto_rejected_by_rules: autoRejectedByRules,
        cleared_by_guardrails: guardrailEvals.filter((g) => g.verdict === "pass").length,
        rejected_by_guardrails: guardrailEvals.filter((g) => g.verdict === "fail").length,
        cleared_by_ai_review: aiReviews.filter((r) => r.decision === "approved").length,
        rejected_by_ai_review: aiReviews.filter((r) => r.decision === "rejected").length,
        escalated_to_human: aiEscalated,
        decided_by_human: humanReviews.length,
      },
      ai_review_stats: {
        total_ai_reviews: aiReviews.length,
        avg_ai_confidence: aiConfidences.length > 0
          ? aiConfidences.reduce((a, b) => a + b, 0) / aiConfidences.length
          : 0,
        ai_escalation_rate: aiReviews.length > 0 ? aiEscalated / aiReviews.length : 0,
      },
      guardrail_stats: {
        total_evaluations: guardrailEvals.length,
        by_guardrail: guardrailByName,
      },
      feedback_summary: feedbackSummary,
    };

    const html = renderPage("dashboard", {
      title: "Dashboard",
      token,
      pendingCount,
      data,
    });
    res.type("html").send(html);
  });

  return router;
}
