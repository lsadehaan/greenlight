import { Router } from "express";
import { PrismaClient } from "./generated/prisma/client.js";
import type { Redis } from "ioredis";
import { config } from "./config.js";

export function createHealthRouter(prisma: PrismaClient, redis: Redis): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const uptimeSeconds = Math.floor(process.uptime());

    const [dbStatus, redisStatus] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(
        () => "connected" as const,
        () => "disconnected" as const,
      ),
      redis.ping().then(
        () => "connected" as const,
        () => "disconnected" as const,
      ),
    ]);

    const status =
      dbStatus === "connected" && redisStatus === "connected" ? "healthy" : "unhealthy";
    const statusCode = status === "healthy" ? 200 : 503;

    res.status(statusCode).json({
      status,
      version: config.version,
      uptime_seconds: uptimeSeconds,
      db: dbStatus,
      redis: redisStatus,
    });
  });

  return router;
}
