import { Router } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TYPES = ["slack", "email"] as const;

export function createNotificationChannelRouter(prisma: PrismaClient): Router {
  const router = Router();

  // POST /api/v1/notification-channels — create a channel
  router.post("/", async (req, res) => {
    const { type, config: channelConfig } = req.body as {
      type?: string;
      config?: Record<string, unknown>;
    };

    if (!type || !VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
      res.status(400).json({
        error: "bad_request",
        message: `type must be one of: ${VALID_TYPES.join(", ")}`,
      });
      return;
    }

    if (!channelConfig || typeof channelConfig !== "object" || Array.isArray(channelConfig)) {
      res.status(400).json({ error: "bad_request", message: "config must be a JSON object" });
      return;
    }

    const configError = validateChannelConfig(type, channelConfig);
    if (configError) {
      res.status(400).json({ error: "bad_request", message: configError });
      return;
    }

    const channel = await prisma.notificationChannel.create({
      data: {
        type,
        config: channelConfig as object,
      },
    });

    res.status(201).json({
      id: channel.id,
      type: channel.type,
      config: channel.config,
      active: channel.active,
      created_at: channel.createdAt,
    });
  });

  // GET /api/v1/notification-channels — list channels
  router.get("/", async (_req, res) => {
    const channels = await prisma.notificationChannel.findMany({
      orderBy: { createdAt: "desc" },
    });

    res.json({
      data: channels.map((ch) => ({
        id: ch.id,
        type: ch.type,
        config: ch.config,
        active: ch.active,
        created_at: ch.createdAt,
      })),
    });
  });

  // PUT /api/v1/notification-channels/:id — update a channel
  router.put("/:id", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid channel ID" });
      return;
    }

    const existing = await prisma.notificationChannel.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "not_found", message: "Notification channel not found" });
      return;
    }

    const {
      type,
      config: channelConfig,
      active,
    } = req.body as {
      type?: string;
      config?: Record<string, unknown>;
      active?: boolean;
    };

    const updateType = type ?? existing.type;
    if (type && !VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
      res.status(400).json({
        error: "bad_request",
        message: `type must be one of: ${VALID_TYPES.join(", ")}`,
      });
      return;
    }

    if (channelConfig !== undefined) {
      if (typeof channelConfig !== "object" || Array.isArray(channelConfig)) {
        res.status(400).json({ error: "bad_request", message: "config must be a JSON object" });
        return;
      }
      const configError = validateChannelConfig(updateType, channelConfig);
      if (configError) {
        res.status(400).json({ error: "bad_request", message: configError });
        return;
      }
    }

    const channel = await prisma.notificationChannel.update({
      where: { id },
      data: {
        ...(type !== undefined && { type }),
        ...(channelConfig !== undefined && { config: channelConfig as object }),
        ...(active !== undefined && { active }),
      },
    });

    res.json({
      id: channel.id,
      type: channel.type,
      config: channel.config,
      active: channel.active,
      created_at: channel.createdAt,
    });
  });

  // DELETE /api/v1/notification-channels/:id — deactivate a channel
  router.delete("/:id", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request", message: "Invalid channel ID" });
      return;
    }

    const existing = await prisma.notificationChannel.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "not_found", message: "Notification channel not found" });
      return;
    }

    await prisma.notificationChannel.update({
      where: { id },
      data: { active: false },
    });

    res.status(204).end();
  });

  return router;
}

function validateChannelConfig(type: string, config: Record<string, unknown>): string | null {
  if (type === "slack") {
    if (typeof config.webhook_url !== "string" || config.webhook_url.length === 0) {
      return "slack config requires a non-empty 'webhook_url' string";
    }
    if (
      !config.webhook_url.startsWith("https://hooks.slack.com/") &&
      !config.webhook_url.startsWith("https://hooks.slack-gov.com/")
    ) {
      return "slack webhook_url must start with https://hooks.slack.com/ or https://hooks.slack-gov.com/";
    }
  } else if (type === "email") {
    if (
      !Array.isArray(config.recipients) ||
      config.recipients.length === 0 ||
      !config.recipients.every((r: unknown) => typeof r === "string" && r.includes("@"))
    ) {
      return "email config requires a non-empty 'recipients' array of email addresses";
    }
  }
  return null;
}
