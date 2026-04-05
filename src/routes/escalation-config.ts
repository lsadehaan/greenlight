import { Router } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TIMEOUT_ACTIONS = ["auto_approve", "auto_reject"] as const;

export function createEscalationConfigRouter(prisma: PrismaClient): Router {
  const router = Router();

  // POST /api/v1/escalation-config — create an escalation rule
  router.post("/", async (req, res) => {
    const body = req.body as {
      sla_minutes?: number;
      escalation_channel?: string;
      escalation_target?: string;
      timeout_action?: string;
      timeout_minutes?: number;
    };

    const error = validateEscalationBody(body);
    if (error) {
      res.status(400).json({ error: "bad_request", message: error });
      return;
    }

    const config = await prisma.escalationConfig.create({
      data: {
        slaMinutes: body.sla_minutes as number,
        escalationChannel: body.escalation_channel as string,
        escalationTarget: body.escalation_target as string,
        timeoutAction: body.timeout_action as string,
        timeoutMinutes: body.timeout_minutes as number,
      },
    });

    res.status(201).json(formatConfig(config));
  });

  // GET /api/v1/escalation-config — list active configs
  router.get("/", async (_req, res) => {
    const configs = await prisma.escalationConfig.findMany({
      orderBy: { slaMinutes: "asc" },
    });

    res.json({ data: configs.map(formatConfig) });
  });

  // PUT /api/v1/escalation-config/:id — update
  router.put("/:id", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid config ID" });
      return;
    }

    const existing = await prisma.escalationConfig.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "not_found", message: "Escalation config not found" });
      return;
    }

    const body = req.body as {
      sla_minutes?: number;
      escalation_channel?: string;
      escalation_target?: string;
      timeout_action?: string;
      timeout_minutes?: number;
      active?: boolean;
    };

    if (
      body.sla_minutes !== undefined &&
      (typeof body.sla_minutes !== "number" || body.sla_minutes < 1)
    ) {
      res
        .status(400)
        .json({ error: "bad_request", message: "sla_minutes must be a positive integer" });
      return;
    }
    if (
      body.timeout_action !== undefined &&
      !VALID_TIMEOUT_ACTIONS.includes(body.timeout_action as (typeof VALID_TIMEOUT_ACTIONS)[number])
    ) {
      res
        .status(400)
        .json({
          error: "bad_request",
          message: `timeout_action must be one of: ${VALID_TIMEOUT_ACTIONS.join(", ")}`,
        });
      return;
    }
    if (
      body.timeout_minutes !== undefined &&
      (typeof body.timeout_minutes !== "number" || body.timeout_minutes < 1)
    ) {
      res
        .status(400)
        .json({ error: "bad_request", message: "timeout_minutes must be a positive integer" });
      return;
    }

    const config = await prisma.escalationConfig.update({
      where: { id },
      data: {
        ...(body.sla_minutes !== undefined && { slaMinutes: body.sla_minutes }),
        ...(body.escalation_channel !== undefined && {
          escalationChannel: body.escalation_channel,
        }),
        ...(body.escalation_target !== undefined && { escalationTarget: body.escalation_target }),
        ...(body.timeout_action !== undefined && { timeoutAction: body.timeout_action }),
        ...(body.timeout_minutes !== undefined && { timeoutMinutes: body.timeout_minutes }),
        ...(body.active !== undefined && { active: body.active }),
      },
    });

    res.json(formatConfig(config));
  });

  return router;
}

function validateEscalationBody(body: Record<string, unknown>): string | null {
  if (typeof body.sla_minutes !== "number" || body.sla_minutes < 1) {
    return "sla_minutes is required and must be a positive integer";
  }
  if (typeof body.escalation_channel !== "string" || body.escalation_channel.length === 0) {
    return "escalation_channel is required";
  }
  if (typeof body.escalation_target !== "string" || body.escalation_target.length === 0) {
    return "escalation_target is required";
  }
  if (
    !VALID_TIMEOUT_ACTIONS.includes(body.timeout_action as (typeof VALID_TIMEOUT_ACTIONS)[number])
  ) {
    return `timeout_action must be one of: ${VALID_TIMEOUT_ACTIONS.join(", ")}`;
  }
  if (typeof body.timeout_minutes !== "number" || body.timeout_minutes < 1) {
    return "timeout_minutes is required and must be a positive integer";
  }
  return null;
}

function formatConfig(config: {
  id: string;
  slaMinutes: number;
  escalationChannel: string;
  escalationTarget: string;
  timeoutAction: string;
  timeoutMinutes: number;
  active: boolean;
}) {
  return {
    id: config.id,
    sla_minutes: config.slaMinutes,
    escalation_channel: config.escalationChannel,
    escalation_target: config.escalationTarget,
    timeout_action: config.timeoutAction,
    timeout_minutes: config.timeoutMinutes,
    active: config.active,
  };
}
