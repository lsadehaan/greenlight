import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createApiKeyRouter } from "./api-keys.js";
import { hashApiKey } from "../middleware/auth.js";

function buildApp(mockPrisma: Record<string, unknown>) {
  const prisma = { apiKey: mockPrisma } as unknown as Parameters<typeof createApiKeyRouter>[0];
  const app = express();
  app.use(express.json());
  app.use("/api/v1/api-keys", createApiKeyRouter(prisma));
  return app;
}

describe("POST /api/v1/api-keys", () => {
  it("creates a new API key and returns plaintext", async () => {
    const createFn = vi.fn().mockImplementation(async ({ data }) => ({
      id: "new-id",
      keyHash: data.keyHash,
      name: data.name,
      active: true,
      createdAt: new Date("2026-01-01"),
    }));
    const app = buildApp({ create: createFn });
    const res = await request(app).post("/api/v1/api-keys").send({ name: "my-key" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("new-id");
    expect(res.body.key).toMatch(/^gl_/);
    expect(res.body.name).toBe("my-key");
    expect(res.body.created_at).toBeDefined();
    expect(createFn).toHaveBeenCalledOnce();

    // Verify the stored hash matches the returned key
    const storedHash = createFn.mock.calls[0][0].data.keyHash;
    expect(storedHash).toBe(hashApiKey(res.body.key));
  });

  it("returns 400 when name is missing", async () => {
    const app = buildApp({ create: vi.fn() });
    const res = await request(app).post("/api/v1/api-keys").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("returns 400 when name is empty string", async () => {
    const app = buildApp({ create: vi.fn() });
    const res = await request(app).post("/api/v1/api-keys").send({ name: "  " });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/api-keys", () => {
  it("lists all keys without exposing hashes", async () => {
    const findManyFn = vi.fn().mockResolvedValue([
      { id: "1", name: "key-1", active: true, createdAt: new Date("2026-01-01"), revokedAt: null },
      {
        id: "2",
        name: "key-2",
        active: false,
        createdAt: new Date("2026-01-02"),
        revokedAt: new Date("2026-01-03"),
      },
    ]);
    const app = buildApp({ findMany: findManyFn });
    const res = await request(app).get("/api/v1/api-keys");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).not.toHaveProperty("keyHash");
    expect(res.body[0]).not.toHaveProperty("key");
    expect(res.body[0].name).toBe("key-1");
    expect(res.body[1].active).toBe(false);
  });
});

describe("DELETE /api/v1/api-keys/:id", () => {
  it("revokes a key", async () => {
    const updateFn = vi.fn().mockResolvedValue({});
    const app = buildApp({
      findUnique: vi.fn().mockResolvedValue({ id: "1", active: true }),
      update: updateFn,
    });
    const res = await request(app).delete("/api/v1/api-keys/1");
    expect(res.status).toBe(204);
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "1" },
        data: expect.objectContaining({ active: false }),
      }),
    );
  });

  it("returns 404 when key does not exist", async () => {
    const app = buildApp({
      findUnique: vi.fn().mockResolvedValue(null),
    });
    const res = await request(app).delete("/api/v1/api-keys/nonexistent");
    expect(res.status).toBe(404);
  });
});
