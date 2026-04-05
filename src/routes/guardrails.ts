import { Router } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_FAILURE_MODES = ["fail_open", "fail_closed"] as const;
const MAX_TIMEOUT_MS = 30000;

const PRIVATE_IP_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|fc|fd|fe80|::1|localhost)/i;

function validateEndpointUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "endpoint_url must be a valid URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "endpoint_url must use http or https";
  }
  if (PRIVATE_IP_RE.test(parsed.hostname)) {
    return "endpoint_url must not point to private/loopback addresses";
  }
  return null;
}

export function createGuardrailRouter(prisma: PrismaClient): Router {
  const router = Router();

  // POST /api/v1/guardrails — register a guardrail adapter
  router.post("/", async (req, res) => {
    const {
      name,
      endpoint_url,
      timeout_ms,
      failure_mode,
      pipeline_order,
      scope_channel,
      scope_content_type,
    } = req.body as {
      name?: string;
      endpoint_url?: string;
      timeout_ms?: number;
      failure_mode?: string;
      pipeline_order?: number;
      scope_channel?: string;
      scope_content_type?: string;
    };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "bad_request", message: "name is required" });
      return;
    }
    if (!endpoint_url || typeof endpoint_url !== "string") {
      res.status(400).json({ error: "bad_request", message: "endpoint_url is required" });
      return;
    }
    const urlError = validateEndpointUrl(endpoint_url);
    if (urlError) {
      res.status(400).json({ error: "bad_request", message: urlError });
      return;
    }
    if (
      !failure_mode ||
      !VALID_FAILURE_MODES.includes(failure_mode as (typeof VALID_FAILURE_MODES)[number])
    ) {
      res.status(400).json({
        error: "bad_request",
        message: `failure_mode must be one of: ${VALID_FAILURE_MODES.join(", ")}`,
      });
      return;
    }
    if (
      pipeline_order === undefined ||
      typeof pipeline_order !== "number" ||
      !Number.isInteger(pipeline_order)
    ) {
      res.status(400).json({ error: "bad_request", message: "pipeline_order must be an integer" });
      return;
    }
    if (
      timeout_ms !== undefined &&
      (typeof timeout_ms !== "number" || timeout_ms < 1 || timeout_ms > MAX_TIMEOUT_MS)
    ) {
      res.status(400).json({
        error: "bad_request",
        message: `timeout_ms must be between 1 and ${MAX_TIMEOUT_MS}`,
      });
      return;
    }

    const guardrail = await prisma.guardrail.create({
      data: {
        name: name.trim(),
        endpointUrl: endpoint_url,
        timeoutMs: timeout_ms ?? 10000,
        failureMode: failure_mode as "fail_open" | "fail_closed",
        pipelineOrder: pipeline_order,
        scopeChannel: scope_channel || null,
        scopeContentType: scope_content_type || null,
      },
    });

    res.status(201).json(formatGuardrail(guardrail));
  });

  // GET /api/v1/guardrails — list all guardrails
  router.get("/", async (_req, res) => {
    const guardrails = await prisma.guardrail.findMany({
      orderBy: { pipelineOrder: "asc" },
    });

    res.json({
      data: guardrails.map(formatGuardrail),
      total: guardrails.length,
    });
  });

  // GET /api/v1/guardrails/:id
  router.get("/:id", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid guardrail ID" });
      return;
    }

    const guardrail = await prisma.guardrail.findUnique({ where: { id } });
    if (!guardrail) {
      res.status(404).json({ error: "not_found", message: "Guardrail not found" });
      return;
    }

    res.json(formatGuardrail(guardrail));
  });

  // PUT /api/v1/guardrails/:id
  router.put("/:id", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid guardrail ID" });
      return;
    }

    const existing = await prisma.guardrail.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "not_found", message: "Guardrail not found" });
      return;
    }

    const {
      name,
      endpoint_url,
      timeout_ms,
      failure_mode,
      pipeline_order,
      scope_channel,
      scope_content_type,
    } = req.body as {
      name?: string;
      endpoint_url?: string;
      timeout_ms?: number;
      failure_mode?: string;
      pipeline_order?: number;
      scope_channel?: string;
      scope_content_type?: string;
    };

    if (endpoint_url) {
      const updateUrlError = validateEndpointUrl(endpoint_url);
      if (updateUrlError) {
        res.status(400).json({ error: "bad_request", message: updateUrlError });
        return;
      }
    }
    if (
      failure_mode &&
      !VALID_FAILURE_MODES.includes(failure_mode as (typeof VALID_FAILURE_MODES)[number])
    ) {
      res.status(400).json({
        error: "bad_request",
        message: `failure_mode must be one of: ${VALID_FAILURE_MODES.join(", ")}`,
      });
      return;
    }
    if (
      timeout_ms !== undefined &&
      (typeof timeout_ms !== "number" || timeout_ms < 1 || timeout_ms > MAX_TIMEOUT_MS)
    ) {
      res.status(400).json({
        error: "bad_request",
        message: `timeout_ms must be between 1 and ${MAX_TIMEOUT_MS}`,
      });
      return;
    }
    if (
      pipeline_order !== undefined &&
      (typeof pipeline_order !== "number" || !Number.isInteger(pipeline_order))
    ) {
      res.status(400).json({ error: "bad_request", message: "pipeline_order must be an integer" });
      return;
    }

    const updated = await prisma.guardrail.update({
      where: { id },
      data: {
        ...(name && { name: name.trim() }),
        ...(endpoint_url && { endpointUrl: endpoint_url }),
        ...(timeout_ms !== undefined && { timeoutMs: timeout_ms }),
        ...(failure_mode && { failureMode: failure_mode as "fail_open" | "fail_closed" }),
        ...(pipeline_order !== undefined && { pipelineOrder: pipeline_order }),
        ...(scope_channel !== undefined && { scopeChannel: scope_channel || null }),
        ...(scope_content_type !== undefined && { scopeContentType: scope_content_type || null }),
      },
    });

    res.json(formatGuardrail(updated));
  });

  // DELETE /api/v1/guardrails/:id — soft delete
  router.delete("/:id", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid guardrail ID" });
      return;
    }

    const existing = await prisma.guardrail.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "not_found", message: "Guardrail not found" });
      return;
    }

    await prisma.guardrail.update({
      where: { id },
      data: { active: false },
    });

    res.status(204).send();
  });

  return router;
}

function formatGuardrail(g: {
  id: string;
  name: string;
  endpointUrl: string;
  timeoutMs: number;
  failureMode: string;
  pipelineOrder: number;
  scopeChannel: string | null;
  scopeContentType: string | null;
  active: boolean;
  createdAt: Date;
}) {
  return {
    id: g.id,
    name: g.name,
    endpoint_url: g.endpointUrl,
    timeout_ms: g.timeoutMs,
    failure_mode: g.failureMode,
    pipeline_order: g.pipelineOrder,
    scope_channel: g.scopeChannel,
    scope_content_type: g.scopeContentType,
    active: g.active,
    created_at: g.createdAt,
  };
}
