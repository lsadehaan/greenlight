import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHealthRouter } from "./health.js";

function buildApp(dbOk: boolean, redisOk: boolean) {
  const prisma = {
    $queryRaw: dbOk
      ? vi.fn().mockResolvedValue([{ "?column?": 1 }])
      : vi.fn().mockRejectedValue(new Error("db down")),
  } as unknown as Parameters<typeof createHealthRouter>[0];

  const redis = {
    ping: redisOk
      ? vi.fn().mockResolvedValue("PONG")
      : vi.fn().mockRejectedValue(new Error("redis down")),
  } as unknown as Parameters<typeof createHealthRouter>[1];

  const app = express();
  app.use(createHealthRouter(prisma, redis));
  return app;
}

describe("GET /health", () => {
  it("returns 200 and healthy when all services are connected", async () => {
    const app = buildApp(true, true);
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.db).toBe("connected");
    expect(res.body.redis).toBe("connected");
    expect(res.body).toHaveProperty("version");
    expect(res.body).toHaveProperty("uptime_seconds");
  });

  it("returns 503 when database is disconnected", async () => {
    const app = buildApp(false, true);
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.db).toBe("disconnected");
    expect(res.body.redis).toBe("connected");
  });

  it("returns 503 when redis is disconnected", async () => {
    const app = buildApp(true, false);
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.db).toBe("connected");
    expect(res.body.redis).toBe("disconnected");
  });

  it("returns 503 when both services are disconnected", async () => {
    const app = buildApp(false, false);
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.db).toBe("disconnected");
    expect(res.body.redis).toBe("disconnected");
  });
});
