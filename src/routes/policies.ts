import { Router } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { POLICY_TYPES, validatePolicyConfig } from "../engine/policy.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ACTIONS = ["block", "flag", "info"] as const;

export function createPolicyRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const { name, type, config, action, scope_channel, scope_content_type, priority } =
      req.body as {
        name?: string;
        type?: string;
        config?: unknown;
        action?: string;
        scope_channel?: string;
        scope_content_type?: string;
        priority?: number;
      };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "bad_request", message: "name is required" });
      return;
    }
    if (!type || !POLICY_TYPES.includes(type as (typeof POLICY_TYPES)[number])) {
      res
        .status(400)
        .json({ error: "bad_request", message: `type must be one of: ${POLICY_TYPES.join(", ")}` });
      return;
    }
    if (!action || !VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])) {
      res.status(400).json({
        error: "bad_request",
        message: `action must be one of: ${VALID_ACTIONS.join(", ")}`,
      });
      return;
    }

    if (
      priority !== undefined &&
      (typeof priority !== "number" || !Number.isFinite(priority) || !Number.isInteger(priority))
    ) {
      res.status(400).json({ error: "bad_request", message: "priority must be an integer" });
      return;
    }

    const configError = validatePolicyConfig(type, config);
    if (configError) {
      res.status(400).json({ error: "bad_request", message: configError });
      return;
    }

    const policy = await prisma.policy.create({
      data: {
        name: name.trim(),
        type,
        config: config as object,
        action: action as "block" | "flag" | "info",
        scopeChannel: scope_channel ?? null,
        scopeContentType: scope_content_type ?? null,
        priority: typeof priority === "number" ? priority : 0,
      },
    });

    res.status(201).json({
      id: policy.id,
      name: policy.name,
      type: policy.type,
      config: policy.config,
      action: policy.action,
      scope_channel: policy.scopeChannel,
      scope_content_type: policy.scopeContentType,
      priority: policy.priority,
      active: policy.active,
      created_at: policy.createdAt,
    });
  });

  router.get("/", async (_req, res) => {
    const policies = await prisma.policy.findMany({
      where: { active: true },
      orderBy: { priority: "asc" },
    });

    res.json(
      policies.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        config: p.config,
        action: p.action,
        scope_channel: p.scopeChannel,
        scope_content_type: p.scopeContentType,
        priority: p.priority,
        active: p.active,
        created_at: p.createdAt,
      })),
    );
  });

  router.get("/:id", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid policy ID" });
      return;
    }

    const policy = await prisma.policy.findUnique({ where: { id } });
    if (!policy || !policy.active) {
      res.status(404).json({ error: "not_found", message: "Policy not found" });
      return;
    }

    res.json({
      id: policy.id,
      name: policy.name,
      type: policy.type,
      config: policy.config,
      action: policy.action,
      scope_channel: policy.scopeChannel,
      scope_content_type: policy.scopeContentType,
      priority: policy.priority,
      active: policy.active,
      created_at: policy.createdAt,
    });
  });

  router.put("/:id", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid policy ID" });
      return;
    }

    const existing = await prisma.policy.findUnique({ where: { id } });
    if (!existing || !existing.active) {
      res.status(404).json({ error: "not_found", message: "Policy not found" });
      return;
    }

    const { name, type, config, action, scope_channel, scope_content_type, priority } =
      req.body as {
        name?: string;
        type?: string;
        config?: unknown;
        action?: string;
        scope_channel?: string | null;
        scope_content_type?: string | null;
        priority?: number;
      };

    if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
      res.status(400).json({ error: "bad_request", message: "name must be a non-empty string" });
      return;
    }
    if (
      priority !== undefined &&
      (typeof priority !== "number" || !Number.isFinite(priority) || !Number.isInteger(priority))
    ) {
      res.status(400).json({ error: "bad_request", message: "priority must be an integer" });
      return;
    }

    const updatedType = type ?? existing.type;
    const updatedConfig = config ?? existing.config;

    if (type !== undefined && !POLICY_TYPES.includes(type as (typeof POLICY_TYPES)[number])) {
      res
        .status(400)
        .json({ error: "bad_request", message: `type must be one of: ${POLICY_TYPES.join(", ")}` });
      return;
    }
    if (action !== undefined && !VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])) {
      res.status(400).json({
        error: "bad_request",
        message: `action must be one of: ${VALID_ACTIONS.join(", ")}`,
      });
      return;
    }

    if (config !== undefined || type !== undefined) {
      const configError = validatePolicyConfig(updatedType, updatedConfig);
      if (configError) {
        res.status(400).json({ error: "bad_request", message: configError });
        return;
      }
    }

    const policy = await prisma.policy.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(type !== undefined && { type }),
        ...(config !== undefined && { config: config as object }),
        ...(action !== undefined && { action: action as "block" | "flag" | "info" }),
        ...(scope_channel !== undefined && { scopeChannel: scope_channel }),
        ...(scope_content_type !== undefined && { scopeContentType: scope_content_type }),
        ...(priority !== undefined && { priority }),
      },
    });

    res.json({
      id: policy.id,
      name: policy.name,
      type: policy.type,
      config: policy.config,
      action: policy.action,
      scope_channel: policy.scopeChannel,
      scope_content_type: policy.scopeContentType,
      priority: policy.priority,
      active: policy.active,
      created_at: policy.createdAt,
    });
  });

  router.delete("/:id", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid policy ID" });
      return;
    }

    const existing = await prisma.policy.findUnique({ where: { id } });
    if (!existing || !existing.active) {
      res.status(404).json({ error: "not_found", message: "Policy not found" });
      return;
    }

    await prisma.policy.update({
      where: { id },
      data: { active: false },
    });

    res.status(204).end();
  });

  return router;
}
