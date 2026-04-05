import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createAuthMiddleware, hashApiKey } from "./auth.js";

function buildApp(mockFindUnique: ReturnType<typeof vi.fn>) {
  const prisma = {
    apiKey: { findUnique: mockFindUnique },
  } as unknown as Parameters<typeof createAuthMiddleware>[0];

  const app = express();
  app.use(express.json());
  app.use("/api/v1", createAuthMiddleware(prisma));
  app.get("/api/v1/test", (_req, res) => {
    res.json({ ok: true, apiKey: _req.apiKey });
  });
  app.get("/health", (_req, res) => {
    res.json({ status: "healthy" });
  });
  return app;
}

describe("auth middleware", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const app = buildApp(vi.fn());
    const res = await request(app).get("/api/v1/test");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
    expect(res.body.message).toBe("API key required");
  });

  it("returns 401 when Authorization header is not Bearer", async () => {
    const app = buildApp(vi.fn());
    const res = await request(app).get("/api/v1/test").set("Authorization", "Basic abc");
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("API key required");
  });

  it("returns 401 when API key is not found", async () => {
    const app = buildApp(vi.fn().mockResolvedValue(null));
    const res = await request(app).get("/api/v1/test").set("Authorization", "Bearer invalid-key");
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid API key");
  });

  it("returns 401 when API key is revoked (active=false)", async () => {
    const app = buildApp(
      vi.fn().mockResolvedValue({ id: "key-1", name: "revoked", active: false }),
    );
    const res = await request(app).get("/api/v1/test").set("Authorization", "Bearer some-key");
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid API key");
  });

  it("passes through when API key is valid and populates req.apiKey", async () => {
    const token = "gl_testkey123";
    const keyHash = hashApiKey(token);
    const app = buildApp(
      vi.fn().mockImplementation(async (args: { where: { keyHash: string } }) => {
        if (args.where.keyHash === keyHash) {
          return { id: "key-1", name: "test-key", active: true };
        }
        return null;
      }),
    );
    const res = await request(app).get("/api/v1/test").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.apiKey).toEqual({ id: "key-1", name: "test-key" });
  });

  it("accepts lowercase bearer scheme", async () => {
    const token = "gl_testkey123";
    const keyHash = hashApiKey(token);
    const app = buildApp(
      vi.fn().mockImplementation(async (args: { where: { keyHash: string } }) => {
        if (args.where.keyHash === keyHash) {
          return { id: "key-1", name: "test-key", active: true };
        }
        return null;
      }),
    );
    const res = await request(app).get("/api/v1/test").set("Authorization", `bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("returns 401 when Bearer token is empty", async () => {
    const app = buildApp(vi.fn());
    const res = await request(app).get("/api/v1/test").set("Authorization", "Bearer ");
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("API key required");
  });

  it("does not affect non /api/v1 routes", async () => {
    const app = buildApp(vi.fn());
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
  });
});

describe("hashApiKey", () => {
  it("returns consistent SHA-256 hash", () => {
    const hash1 = hashApiKey("test-key");
    const hash2 = hashApiKey("test-key");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("returns different hashes for different keys", () => {
    expect(hashApiKey("key-a")).not.toBe(hashApiKey("key-b"));
  });
});
