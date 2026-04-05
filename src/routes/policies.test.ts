import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createPolicyRouter } from "./policies.js";

const UUID = "00000000-0000-0000-0000-000000000001";

function buildApp(mockPrisma: Record<string, unknown>) {
  const prisma = { policy: mockPrisma } as unknown as Parameters<typeof createPolicyRouter>[0];
  const app = express();
  app.use(express.json());
  app.use("/api/v1/policies", createPolicyRouter(prisma));
  return app;
}

describe("POST /api/v1/policies", () => {
  it("creates a regex policy", async () => {
    const createFn = vi
      .fn()
      .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: UUID,
        ...data,
        active: true,
        createdAt: new Date("2026-01-01"),
      }));
    const app = buildApp({ create: createFn });
    const res = await request(app)
      .post("/api/v1/policies")
      .send({
        name: "no-urls",
        type: "regex",
        config: { pattern: "https?://" },
        action: "block",
        priority: 1,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(UUID);
    expect(res.body.name).toBe("no-urls");
    expect(res.body.type).toBe("regex");
    expect(res.body.action).toBe("block");
    expect(res.body.priority).toBe(1);
    expect(createFn).toHaveBeenCalledOnce();
  });

  it("creates a keyword_blocklist policy", async () => {
    const createFn = vi
      .fn()
      .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: UUID,
        ...data,
        active: true,
        createdAt: new Date("2026-01-01"),
      }));
    const app = buildApp({ create: createFn });
    const res = await request(app)
      .post("/api/v1/policies")
      .send({
        name: "profanity",
        type: "keyword_blocklist",
        config: { keywords: ["spam", "scam"] },
        action: "flag",
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("keyword_blocklist");
  });

  it("returns 400 when name is missing", async () => {
    const app = buildApp({});
    const res = await request(app)
      .post("/api/v1/policies")
      .send({ type: "regex", config: { pattern: "x" }, action: "block" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("name");
  });

  it("returns 400 for invalid type", async () => {
    const app = buildApp({});
    const res = await request(app)
      .post("/api/v1/policies")
      .send({ name: "test", type: "invalid", config: {}, action: "block" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("type");
  });

  it("returns 400 for invalid action", async () => {
    const app = buildApp({});
    const res = await request(app)
      .post("/api/v1/policies")
      .send({ name: "test", type: "regex", config: { pattern: "x" }, action: "destroy" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("action");
  });

  it("returns 400 when config doesn't match type", async () => {
    const app = buildApp({});
    const res = await request(app)
      .post("/api/v1/policies")
      .send({ name: "test", type: "regex", config: {}, action: "block" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("pattern");
  });

  it("accepts scope_channel and scope_content_type", async () => {
    const createFn = vi
      .fn()
      .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: UUID,
        ...data,
        active: true,
        createdAt: new Date("2026-01-01"),
      }));
    const app = buildApp({ create: createFn });
    const res = await request(app)
      .post("/api/v1/policies")
      .send({
        name: "blog-regex",
        type: "regex",
        config: { pattern: "test" },
        action: "info",
        scope_channel: "blog",
        scope_content_type: "article",
      });

    expect(res.status).toBe(201);
    expect(res.body.scope_channel).toBe("blog");
    expect(res.body.scope_content_type).toBe("article");
  });
});

describe("GET /api/v1/policies", () => {
  it("lists active policies", async () => {
    const findManyFn = vi.fn().mockResolvedValue([
      {
        id: UUID,
        name: "p1",
        type: "regex",
        config: { pattern: "x" },
        action: "block",
        scopeChannel: null,
        scopeContentType: null,
        priority: 0,
        active: true,
        createdAt: new Date("2026-01-01"),
      },
    ]);
    const app = buildApp({ findMany: findManyFn });
    const res = await request(app).get("/api/v1/policies");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("p1");
    expect(findManyFn).toHaveBeenCalledWith(expect.objectContaining({ where: { active: true } }));
  });
});

describe("GET /api/v1/policies/:id", () => {
  it("returns a single policy", async () => {
    const findUniqueFn = vi.fn().mockResolvedValue({
      id: UUID,
      name: "p1",
      type: "regex",
      config: { pattern: "x" },
      action: "block",
      scopeChannel: null,
      scopeContentType: null,
      priority: 0,
      active: true,
      createdAt: new Date("2026-01-01"),
    });
    const app = buildApp({ findUnique: findUniqueFn });
    const res = await request(app).get(`/api/v1/policies/${UUID}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("p1");
  });

  it("returns 404 for non-existent policy", async () => {
    const app = buildApp({ findUnique: vi.fn().mockResolvedValue(null) });
    const res = await request(app).get(`/api/v1/policies/${UUID}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid UUID", async () => {
    const app = buildApp({});
    const res = await request(app).get("/api/v1/policies/not-a-uuid");
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/v1/policies/:id", () => {
  it("updates a policy", async () => {
    const existing = {
      id: UUID,
      name: "old-name",
      type: "regex",
      config: { pattern: "old" },
      action: "block",
      scopeChannel: null,
      scopeContentType: null,
      priority: 0,
      active: true,
      createdAt: new Date("2026-01-01"),
    };
    const updateFn = vi
      .fn()
      .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...existing,
        ...data,
      }));
    const app = buildApp({ findUnique: vi.fn().mockResolvedValue(existing), update: updateFn });
    const res = await request(app)
      .put(`/api/v1/policies/${UUID}`)
      .send({ name: "new-name", priority: 5 });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("new-name");
    expect(res.body.priority).toBe(5);
    expect(updateFn).toHaveBeenCalledOnce();
  });

  it("returns 404 for non-existent policy", async () => {
    const app = buildApp({ findUnique: vi.fn().mockResolvedValue(null) });
    const res = await request(app).put(`/api/v1/policies/${UUID}`).send({ name: "x" });
    expect(res.status).toBe(404);
  });

  it("validates config when type changes", async () => {
    const existing = {
      id: UUID,
      name: "p",
      type: "regex",
      config: { pattern: "x" },
      action: "block",
      scopeChannel: null,
      scopeContentType: null,
      priority: 0,
      active: true,
      createdAt: new Date(),
    };
    const app = buildApp({ findUnique: vi.fn().mockResolvedValue(existing) });
    const res = await request(app)
      .put(`/api/v1/policies/${UUID}`)
      .send({ type: "keyword_blocklist" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("keywords");
  });

  it("returns 400 for empty name on update", async () => {
    const existing = {
      id: UUID,
      name: "p",
      type: "regex",
      config: { pattern: "x" },
      action: "block",
      scopeChannel: null,
      scopeContentType: null,
      priority: 0,
      active: true,
      createdAt: new Date(),
    };
    const app = buildApp({ findUnique: vi.fn().mockResolvedValue(existing) });
    const res = await request(app).put(`/api/v1/policies/${UUID}`).send({ name: "  " });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("name");
  });

  it("returns 400 for empty action on update", async () => {
    const existing = {
      id: UUID,
      name: "p",
      type: "regex",
      config: { pattern: "x" },
      action: "block",
      scopeChannel: null,
      scopeContentType: null,
      priority: 0,
      active: true,
      createdAt: new Date(),
    };
    const app = buildApp({ findUnique: vi.fn().mockResolvedValue(existing) });
    const res = await request(app).put(`/api/v1/policies/${UUID}`).send({ action: "" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("action");
  });

  it("returns 400 for non-integer priority", async () => {
    const existing = {
      id: UUID,
      name: "p",
      type: "regex",
      config: { pattern: "x" },
      action: "block",
      scopeChannel: null,
      scopeContentType: null,
      priority: 0,
      active: true,
      createdAt: new Date(),
    };
    const app = buildApp({ findUnique: vi.fn().mockResolvedValue(existing) });
    const res = await request(app).put(`/api/v1/policies/${UUID}`).send({ priority: 1.5 });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("integer");
  });
});

describe("DELETE /api/v1/policies/:id", () => {
  it("soft-deletes a policy", async () => {
    const updateFn = vi.fn().mockResolvedValue({});
    const app = buildApp({
      findUnique: vi.fn().mockResolvedValue({ id: UUID, active: true }),
      update: updateFn,
    });
    const res = await request(app).delete(`/api/v1/policies/${UUID}`);

    expect(res.status).toBe(204);
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: UUID },
        data: { active: false },
      }),
    );
  });

  it("returns 404 for non-existent policy", async () => {
    const app = buildApp({ findUnique: vi.fn().mockResolvedValue(null) });
    const res = await request(app).delete(`/api/v1/policies/${UUID}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for already-deleted policy", async () => {
    const app = buildApp({ findUnique: vi.fn().mockResolvedValue({ id: UUID, active: false }) });
    const res = await request(app).delete(`/api/v1/policies/${UUID}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid UUID", async () => {
    const app = buildApp({});
    const res = await request(app).delete("/api/v1/policies/bad-id");
    expect(res.status).toBe(400);
  });
});
