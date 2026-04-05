import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_DECISIONS = ["approved", "rejected", "escalated"] as const;
const VALID_REVIEWER_TYPES = ["human", "ai"] as const;

// In-memory store for review action tokens (single-use, time-limited)
const actionTokens = new Map<
  string,
  { submissionId: string; decision: "approved" | "rejected"; expiresAt: number }
>();

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createReviewRouter(prisma: PrismaClient): Router {
  const router = Router();

  // POST /api/v1/submissions/:id/review — submit a review decision
  router.post("/:id/review", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid submission ID" });
      return;
    }

    const { decision, comment, reviewer_type, confidence, reasoning, ai_metadata } = req.body as {
      decision?: string;
      comment?: string;
      reviewer_type?: string;
      confidence?: number;
      reasoning?: string;
      ai_metadata?: Record<string, unknown>;
    };

    const reviewerType = reviewer_type ?? "human";

    if (!VALID_REVIEWER_TYPES.includes(reviewerType as (typeof VALID_REVIEWER_TYPES)[number])) {
      res.status(400).json({
        error: "bad_request",
        message: `reviewer_type must be one of: ${VALID_REVIEWER_TYPES.join(", ")}`,
      });
      return;
    }

    if (!decision || !VALID_DECISIONS.includes(decision as (typeof VALID_DECISIONS)[number])) {
      res.status(400).json({
        error: "bad_request",
        message: `decision must be one of: ${VALID_DECISIONS.join(", ")}`,
      });
      return;
    }

    if (decision === "escalated" && reviewerType === "human") {
      res.status(400).json({
        error: "bad_request",
        message: "escalate is only valid for AI reviewer_type",
      });
      return;
    }

    const submission = await prisma.submission.findUnique({
      where: { id },
      include: { reviews: true },
    });

    if (!submission) {
      res.status(404).json({ error: "not_found", message: "Submission not found" });
      return;
    }

    // Check for duplicate review by same reviewer type
    const existingReview = submission.reviews.find((r) => r.reviewerType === reviewerType);
    if (existingReview) {
      res.status(409).json({
        error: "conflict",
        message: `Submission already has a ${reviewerType} review`,
      });
      return;
    }

    const reviewerIdentity = req.apiKey?.name ?? "unknown";

    const review = await prisma.review.create({
      data: {
        submissionId: id,
        reviewerType: reviewerType as "human" | "ai",
        reviewerIdentity: reviewerIdentity,
        decision: decision as "approved" | "rejected" | "escalated",
        comment: comment ?? null,
        confidence: confidence ?? null,
        reasoning: reasoning ?? null,
        aiMetadata: ai_metadata ? (ai_metadata as object) : undefined,
      },
    });

    // Update submission status for non-escalated decisions
    if (decision === "approved" || decision === "rejected") {
      await prisma.submission.update({
        where: { id },
        data: {
          status: decision as "approved" | "rejected",
          decidedAt: new Date(),
        },
      });
    }

    res.status(201).json({
      id: review.id,
      submission_id: review.submissionId,
      reviewer_type: review.reviewerType,
      reviewer_identity: review.reviewerIdentity,
      decision: review.decision,
      comment: review.comment,
      created_at: review.createdAt,
    });
  });

  // POST /api/v1/submissions/:id/review-tokens — generate single-use action tokens
  router.post("/:id/review-tokens", async (req, res) => {
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

    if (submission.status !== "pending") {
      res.status(409).json({
        error: "conflict",
        message: "Submission is not pending review",
      });
      return;
    }

    const approveToken = randomBytes(32).toString("hex");
    const rejectToken = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + TOKEN_TTL_MS;

    actionTokens.set(approveToken, { submissionId: id, decision: "approved", expiresAt });
    actionTokens.set(rejectToken, { submissionId: id, decision: "rejected", expiresAt });

    res.status(201).json({
      approve_token: approveToken,
      reject_token: rejectToken,
      expires_at: new Date(expiresAt).toISOString(),
    });
  });

  // POST /api/v1/review-actions/:token — use a single-use review token
  router.post("/review-actions/:token", async (req, res) => {
    const { token } = req.params;

    const action = actionTokens.get(token);
    if (!action) {
      res.status(404).json({ error: "not_found", message: "Invalid or expired token" });
      return;
    }

    if (Date.now() > action.expiresAt) {
      actionTokens.delete(token);
      res.status(410).json({ error: "gone", message: "Token has expired" });
      return;
    }

    // Consume the token
    actionTokens.delete(token);

    const submission = await prisma.submission.findUnique({
      where: { id: action.submissionId },
      include: { reviews: true },
    });

    if (!submission) {
      res.status(404).json({ error: "not_found", message: "Submission not found" });
      return;
    }

    const existingHumanReview = submission.reviews.find((r) => r.reviewerType === "human");
    if (existingHumanReview) {
      res.status(409).json({
        error: "conflict",
        message: "Submission already has a human review",
      });
      return;
    }

    const review = await prisma.review.create({
      data: {
        submissionId: action.submissionId,
        reviewerType: "human",
        reviewerIdentity: "token-review",
        decision: action.decision,
        comment: null,
      },
    });

    await prisma.submission.update({
      where: { id: action.submissionId },
      data: {
        status: action.decision,
        decidedAt: new Date(),
      },
    });

    res.status(201).json({
      id: review.id,
      submission_id: review.submissionId,
      decision: review.decision,
      created_at: review.createdAt,
    });
  });

  return router;
}

// Exported for testing
export { actionTokens };
