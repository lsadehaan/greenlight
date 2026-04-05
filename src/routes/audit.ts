import { Router } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAuditRouter(prisma: PrismaClient): Router {
  const router = Router();

  // GET /api/v1/audit — paginated audit log with filtering
  router.get("/", async (req, res) => {
    const { submission_id, event_type, actor_type, from, to, page, per_page, format } =
      req.query as {
        submission_id?: string;
        event_type?: string;
        actor_type?: string;
        from?: string;
        to?: string;
        page?: string;
        per_page?: string;
        format?: string;
      };

    if (submission_id && !UUID_RE.test(submission_id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid submission_id format" });
      return;
    }

    const pageNum = Math.max(parseInt(page ?? "1", 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(per_page ?? "50", 10) || 50, 1), 200);
    const skip = (pageNum - 1) * perPage;

    const where: Record<string, unknown> = {};
    if (submission_id) where.submissionId = submission_id;
    if (event_type) where.eventType = event_type;
    if (actor_type) where.actorType = actor_type;
    if (from || to) {
      const dateFilter: Record<string, Date> = {};
      if (from) dateFilter.gte = new Date(from);
      if (to) dateFilter.lte = new Date(to);
      where.createdAt = dateFilter;
    }

    const [events, total] = await Promise.all([
      prisma.auditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: perPage,
        skip,
      }),
      prisma.auditEvent.count({ where }),
    ]);

    const mapped = events.map((e) => ({
      id: e.id,
      submission_id: e.submissionId,
      event_type: e.eventType,
      actor: e.actor,
      actor_type: e.actorType,
      payload: e.payload,
      created_at: e.createdAt,
    }));

    if (format === "csv") {
      const headers = "id,submission_id,event_type,actor,actor_type,payload,created_at";
      const rows = mapped.map((e) =>
        [
          e.id,
          e.submission_id ?? "",
          e.event_type,
          csvEscape(e.actor ?? ""),
          e.actor_type,
          csvEscape(e.payload ? JSON.stringify(e.payload) : ""),
          e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
        ].join(","),
      );
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=audit.csv");
      res.send([headers, ...rows].join("\n"));
      return;
    }

    res.json({
      data: mapped,
      total,
      page: pageNum,
      per_page: perPage,
    });
  });

  return router;
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
