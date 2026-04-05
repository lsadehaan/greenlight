import { Router } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_OUTCOMES = ["positive", "negative", "neutral"] as const;

export function createFeedbackRouter(prisma: PrismaClient): Router {
  const router = Router();

  // POST /api/v1/submissions/:id/feedback — submit post-delivery feedback
  router.post("/:id/feedback", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid submission ID" });
      return;
    }

    const { outcome, reason, data } = req.body as {
      outcome?: string;
      reason?: string;
      data?: Record<string, unknown>;
    };

    if (!outcome || !VALID_OUTCOMES.includes(outcome as (typeof VALID_OUTCOMES)[number])) {
      res.status(400).json({
        error: "bad_request",
        message: `outcome must be one of: ${VALID_OUTCOMES.join(", ")}`,
      });
      return;
    }

    if (data !== undefined && (typeof data !== "object" || Array.isArray(data))) {
      res.status(400).json({ error: "bad_request", message: "data must be a JSON object" });
      return;
    }

    const submission = await prisma.submission.findUnique({ where: { id } });
    if (!submission) {
      res.status(404).json({ error: "not_found", message: "Submission not found" });
      return;
    }

    const feedback = await prisma.feedback.create({
      data: {
        submissionId: id,
        outcome: outcome as "positive" | "negative" | "neutral",
        reason: reason ?? null,
        data: data ? (data as object) : undefined,
      },
    });

    res.status(201).json({
      id: feedback.id,
      submission_id: feedback.submissionId,
      outcome: feedback.outcome,
      reason: feedback.reason,
      data: feedback.data,
      created_at: feedback.createdAt,
    });
  });

  // GET /api/v1/submissions/:id/feedback — list feedback for a submission
  router.get("/:id/feedback", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid submission ID" });
      return;
    }

    const submission = await prisma.submission.findUnique({ where: { id } });
    if (!submission) {
      res.status(404).json({ error: "not_found", message: "Submission not found" });
      return;
    }

    const feedbacks = await prisma.feedback.findMany({
      where: { submissionId: id },
      orderBy: { createdAt: "desc" },
    });

    const counts = { positive: 0, negative: 0, neutral: 0 };
    for (const f of feedbacks) {
      counts[f.outcome]++;
    }

    res.json({
      data: feedbacks.map((f) => ({
        id: f.id,
        submission_id: f.submissionId,
        outcome: f.outcome,
        reason: f.reason,
        data: f.data,
        created_at: f.createdAt,
      })),
      total: feedbacks.length,
      counts,
    });
  });

  return router;
}
