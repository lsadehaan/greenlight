import { Router } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ejs from "ejs";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { Queue } from "bullmq";
import type { WebhookJobData } from "../workers/webhook.js";
import { hashApiKey } from "../middleware/auth.js";
import { recordAuditEvent } from "../services/audit.js";
import { enqueueWebhook } from "../workers/webhook.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, "..", "views");

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function contentPreview(content: unknown, maxLen = 200): string {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

function renderPage(
  templateName: string,
  data: Record<string, unknown>,
): string {
  const layout = readFileSync(path.join(VIEWS_DIR, "layout.ejs"), "utf-8");
  const template = readFileSync(path.join(VIEWS_DIR, `${templateName}.ejs`), "utf-8");
  const body = ejs.render(template, data, { filename: path.join(VIEWS_DIR, `${templateName}.ejs`) });
  return ejs.render(layout, { ...data, body }, { filename: path.join(VIEWS_DIR, "layout.ejs") });
}

export function createReviewUIRouter(
  prisma: PrismaClient,
  webhookQueue: Queue<WebhookJobData>,
): Router {
  const router = Router();

  // Auth middleware: query token or session cookie
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

  // GET /review — queue page
  router.get("/", async (req, res) => {
    const token = req.query.token as string;
    const channel = (req.query.channel as string) || "";
    const sort = (req.query.sort as string) || "newest";

    const where: Record<string, unknown> = { status: "pending" };
    if (channel) where.channel = channel;

    const [submissions, pendingCount, channelRows] = await Promise.all([
      prisma.submission.findMany({
        where,
        orderBy: { createdAt: sort === "oldest" ? "asc" : "desc" },
        take: 50,
        include: {
          policyEvaluations: { include: { policy: { select: { name: true } } } },
          guardrailEvaluations: { include: { guardrail: { select: { name: true } } } },
        },
      }),
      prisma.submission.count({ where: { status: "pending" } }),
      prisma.submission.findMany({
        where: { status: "pending" },
        select: { channel: true },
        distinct: ["channel"],
      }),
    ]);

    const channels = channelRows.map((r: { channel: string }) => r.channel).sort();

    const mapped = submissions.map((sub) => {
      const flags: { type: string; label: string }[] = [];
      for (const pe of sub.policyEvaluations) {
        if (pe.result !== "pass") {
          flags.push({ type: pe.result, label: (pe.policy as { name: string }).name });
        }
      }
      for (const ge of sub.guardrailEvaluations) {
        if (ge.verdict !== "pass") {
          flags.push({ type: ge.verdict, label: (ge.guardrail as { name: string }).name });
        }
      }

      const metadata = sub.metadata as Record<string, unknown> | null;
      const isUrgent = metadata?.priority === "urgent";

      return {
        id: sub.id,
        channel: sub.channel,
        preview: escapeHtml(contentPreview(sub.content)),
        timeAgo: timeAgo(sub.createdAt),
        flags,
        isUrgent,
      };
    });

    const html = renderPage("queue", {
      title: "Review Queue",
      token,
      pendingCount,
      channel,
      sort,
      channels,
      submissions: mapped,
    });
    res.type("html").send(html);
  });

  // GET /review/:id — detail page
  router.get("/:id", async (req, res) => {
    const token = req.query.token as string;
    const { id } = req.params;

    const sub = await prisma.submission.findUnique({
      where: { id },
      include: {
        policyEvaluations: { include: { policy: { select: { name: true } } } },
        guardrailEvaluations: { include: { guardrail: { select: { name: true } } } },
        reviews: true,
      },
    });

    if (!sub) {
      res.status(404).send("Submission not found.");
      return;
    }

    const pendingCount = await prisma.submission.count({ where: { status: "pending" } });

    const contentText = typeof sub.content === "string"
      ? sub.content
      : JSON.stringify(sub.content, null, 2);

    const policyResults = sub.policyEvaluations.map((pe) => ({
      policyName: (pe.policy as { name: string }).name,
      result: pe.result,
      actionTaken: pe.actionTaken,
      details: pe.details,
    }));

    const guardrailResults = sub.guardrailEvaluations.map((ge) => ({
      guardrailName: (ge.guardrail as { name: string }).name,
      verdict: ge.verdict,
      confidence: ge.confidence,
      reasoning: ge.reasoning,
    }));

    const aiReview = sub.reviews.find(
      (r: { reviewerType: string }) => r.reviewerType === "ai",
    ) || null;
    const humanReviews = sub.reviews.filter(
      (r: { reviewerType: string }) => r.reviewerType === "human",
    );

    const html = renderPage("detail", {
      title: `Submission ${sub.id.slice(0, 8)}`,
      token,
      pendingCount,
      submission: {
        id: sub.id,
        channel: sub.channel,
        contentType: sub.contentType,
        contentText,
        metadata: sub.metadata,
        status: sub.status,
        reviewMode: sub.reviewMode,
        decidedAt: sub.decidedAt,
        decidedBy: sub.decidedBy,
        timeAgo: timeAgo(sub.createdAt),
      },
      policyResults,
      guardrailResults,
      aiReview,
      reviews: humanReviews,
    });
    res.type("html").send(html);
  });

  // POST /review/:id/approve — approve submission
  router.post("/:id/approve", express.urlencoded({ extended: false }), async (req, res) => {
    const token = req.query.token as string;
    await handleDecision(prisma, webhookQueue, req, res, token, "approved");
  });

  // POST /review/:id/reject — reject submission
  router.post("/:id/reject", express.urlencoded({ extended: false }), async (req, res) => {
    const token = req.query.token as string;
    await handleDecision(prisma, webhookQueue, req, res, token, "rejected");
  });

  return router;
}

import express from "express";
import type { Request, Response } from "express";

async function handleDecision(
  prisma: PrismaClient,
  webhookQueue: Queue<WebhookJobData>,
  req: Request,
  res: Response,
  token: string,
  decision: "approved" | "rejected",
): Promise<void> {
  const id = req.params.id as string;
  const comment = (req.body?.comment as string) || null;

  // Atomic check-and-update
  const updated = await prisma.$transaction(async (tx) => {
    const sub = await tx.submission.findUnique({
      where: { id },
      select: { status: true, callbackUrl: true },
    });
    if (!sub || sub.status !== "pending") return null;

    const now = new Date();
    await tx.review.create({
      data: {
        submissionId: id,
        reviewerType: "human",
        reviewerIdentity: req.apiKey?.name ?? null,
        decision,
        comment,
      },
    });

    await tx.submission.update({
      where: { id },
      data: {
        status: decision,
        decidedAt: now,
        decidedBy: "human",
      },
    });

    return { callbackUrl: sub.callbackUrl, decidedAt: now };
  });

  if (!updated) {
    res.redirect(`/review?token=${encodeURIComponent(token)}`);
    return;
  }

  // Audit + webhook (best-effort, outside transaction)
  try {
    await recordAuditEvent(prisma, {
      eventType: "review.created",
      submissionId: id,
      actor: req.apiKey?.name ?? "unknown",
      actorType: "human",
      payload: { decision, comment, source: "review_ui" },
    });
  } catch { /* best-effort */ }

  if (updated.callbackUrl) {
    try {
      await enqueueWebhook(webhookQueue, {
        submissionId: id,
        callbackUrl: updated.callbackUrl,
        payload: {
          submission_id: id,
          decision,
          decided_by: "human",
          decided_at: updated.decidedAt.toISOString(),
          timestamp: updated.decidedAt.toISOString(),
        },
      });
    } catch { /* best-effort */ }
  }

  res.redirect(`/review?token=${encodeURIComponent(token)}`);
}
