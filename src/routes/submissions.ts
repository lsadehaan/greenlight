import { Router } from "express";
import type { Queue } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client.js";
import { evaluatePolicies } from "../engine/policy.js";
import type { WebhookJobData } from "../workers/webhook.js";
import { enqueueWebhook } from "../workers/webhook.js";
import { recordAuditEvent } from "../services/audit.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSubmissionRouter(
  prisma: PrismaClient,
  webhookQueue?: Queue<WebhookJobData>,
): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const { channel, content_type, content, metadata, callback_url } = req.body as {
      channel?: string;
      content_type?: string;
      content?: unknown;
      metadata?: Record<string, unknown>;
      callback_url?: string;
    };

    if (!channel || typeof channel !== "string" || channel.trim().length === 0) {
      res.status(400).json({ error: "bad_request", message: "channel is required" });
      return;
    }
    if (!content_type || typeof content_type !== "string" || content_type.trim().length === 0) {
      res.status(400).json({ error: "bad_request", message: "content_type is required" });
      return;
    }
    if (content === undefined || content === null) {
      res.status(400).json({ error: "bad_request", message: "content is required" });
      return;
    }

    // Check for empty content (empty string or empty object)
    const contentStr =
      typeof content === "string"
        ? content
        : typeof content === "object"
          ? JSON.stringify(content)
          : String(content);
    if (contentStr.length === 0 || contentStr === "{}") {
      res.status(422).json({ error: "unprocessable_entity", message: "content must not be empty" });
      return;
    }

    if (metadata !== undefined && (typeof metadata !== "object" || Array.isArray(metadata))) {
      res.status(400).json({ error: "bad_request", message: "metadata must be a JSON object" });
      return;
    }

    const apiKeyId = req.apiKey?.id;
    if (!apiKeyId) {
      res.status(401).json({ error: "unauthorized", message: "API key required" });
      return;
    }

    // Run policy evaluation
    const policyResults = await evaluatePolicies(prisma, {
      content: contentStr,
      metadata: (metadata as Record<string, unknown>) ?? {},
      channel: channel.trim(),
      contentType: content_type.trim(),
    });

    // Determine status based on policy results
    const hasBlock = policyResults.some((r) => r.result === "match" && r.action === "block");
    const hasFlag = policyResults.some((r) => r.result === "match" && r.action === "flag");

    let status: "approved" | "rejected" | "pending";
    let decidedBy: string | null = null;
    let decidedAt: Date | null = null;

    if (hasBlock) {
      status = "rejected";
      decidedBy = "policy";
      decidedAt = new Date();
    } else if (hasFlag) {
      status = "pending";
    } else {
      status = "approved";
      decidedBy = "policy";
      decidedAt = new Date();
    }

    const submission = await prisma.$transaction(async (tx) => {
      const sub = await tx.submission.create({
        data: {
          apiKeyId,
          channel: channel.trim(),
          contentType: content_type.trim(),
          content: content as object,
          metadata: (metadata as object) ?? undefined,
          status,
          callbackUrl: callback_url ?? null,
          decidedAt,
        },
      });

      if (policyResults.length > 0) {
        await tx.policyEvaluation.createMany({
          data: policyResults.map((r) => ({
            submissionId: sub.id,
            policyId: r.policyId,
            result: r.result === "match" ? mapAction(r.action) : ("pass" as const),
            actionTaken: r.action,
            details: { detail: r.detail },
          })),
        });
      }

      return sub;
    });

    // Enqueue webhook if callback_url provided and decision is terminal
    // Best-effort: don't fail the submission if webhook enqueueing fails
    if (webhookQueue && callback_url && (status === "approved" || status === "rejected")) {
      try {
        const now = new Date();
        await enqueueWebhook(webhookQueue, {
          submissionId: submission.id,
          callbackUrl: callback_url,
          payload: {
            submission_id: submission.id,
            decision: status,
            policy_results: policyResults.map((r) => ({
              policy_name: r.policyName,
              result: r.result,
              action: r.action,
            })),
            decided_at: (decidedAt ?? now).toISOString(),
            timestamp: now.toISOString(),
          },
        });
      } catch (err) {
        console.error(`Failed to enqueue webhook for submission ${submission.id}:`, err);
      }
    }

    // Record audit events (best-effort)
    try {
      const autoEvent =
        status === "approved"
          ? "submission.auto_approved"
          : status === "rejected"
            ? "submission.auto_rejected"
            : undefined;

      await recordAuditEvent(prisma, {
        eventType: "submission.created",
        submissionId: submission.id,
        actor: req.apiKey?.name ?? "unknown",
        actorType: "system",
        payload: {
          channel: channel.trim(),
          content_type: content_type.trim(),
          status,
        },
      });

      for (const r of policyResults) {
        await recordAuditEvent(prisma, {
          eventType: "policy.evaluated",
          submissionId: submission.id,
          actor: r.policyName,
          actorType: "system",
          payload: {
            policy_name: r.policyName,
            result: r.result,
            action: r.action,
            detail: r.detail,
          },
        });
      }

      if (autoEvent) {
        await recordAuditEvent(prisma, {
          eventType: autoEvent,
          submissionId: submission.id,
          actor: "policy",
          actorType: "system",
          payload: { decision: status },
        });
      }
    } catch {
      // Best-effort audit recording
    }

    const response: Record<string, unknown> = {
      id: submission.id,
      status: submission.status,
      policy_results: policyResults.map((r) => ({
        policy_name: r.policyName,
        result: r.result,
        action: r.action,
        detail: r.detail,
      })),
      decided_at: decidedAt,
      decided_by: decidedBy,
      created_at: submission.createdAt,
    };

    if (status === "pending") {
      response.review_url = `/api/v1/submissions/${submission.id}/reviews`;
      response.estimated_review_time = "24h";
    }

    res.status(201).json(response);
  });

  router.get("/", async (req, res) => {
    const { status, channel, from, to, limit, offset } = req.query as {
      status?: string;
      channel?: string;
      from?: string;
      to?: string;
      limit?: string;
      offset?: string;
    };

    const take = Math.min(parseInt(limit ?? "20", 10) || 20, 100);
    const skip = parseInt(offset ?? "0", 10) || 0;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (channel) where.channel = channel;
    if (from || to) {
      const dateFilter: Record<string, Date> = {};
      if (from) dateFilter.gte = new Date(from);
      if (to) dateFilter.lte = new Date(to);
      where.createdAt = dateFilter;
    }

    const [submissions, total] = await Promise.all([
      prisma.submission.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: { policyEvaluations: { include: { policy: { select: { name: true } } } } },
      }),
      prisma.submission.count({ where }),
    ]);

    res.json({
      data: submissions.map((s) => ({
        id: s.id,
        channel: s.channel,
        content_type: s.contentType,
        status: s.status,
        created_at: s.createdAt,
        decided_at: s.decidedAt,
        policy_results: s.policyEvaluations.map((e) => ({
          policy_name: e.policy.name,
          result: e.result,
          action_taken: e.actionTaken,
        })),
      })),
      total,
      limit: take,
      offset: skip,
    });
  });

  router.get("/:id", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid submission ID" });
      return;
    }

    const submission = await prisma.submission.findUnique({
      where: { id },
      include: {
        policyEvaluations: { include: { policy: { select: { name: true } } } },
        reviews: true,
        feedbacks: true,
      },
    });

    if (!submission) {
      res.status(404).json({ error: "not_found", message: "Submission not found" });
      return;
    }

    res.json({
      id: submission.id,
      channel: submission.channel,
      content_type: submission.contentType,
      content: submission.content,
      metadata: submission.metadata,
      status: submission.status,
      review_mode: submission.reviewMode,
      callback_url: submission.callbackUrl,
      created_at: submission.createdAt,
      decided_at: submission.decidedAt,
      policy_results: submission.policyEvaluations.map((e) => ({
        policy_name: e.policy.name,
        result: e.result,
        action_taken: e.actionTaken,
        details: e.details,
        evaluated_at: e.evaluatedAt,
      })),
      reviews: submission.reviews,
      feedbacks: submission.feedbacks,
    });
  });

  return router;
}

function mapAction(action: string): "pass" | "flag" | "block" {
  if (action === "block") return "block";
  if (action === "flag") return "flag";
  return "pass";
}
