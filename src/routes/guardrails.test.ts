import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createGuardrailRouter } from "./guardrails.js";

const UUID = "00000000-0000-0000-0000-000000000001";

function buildApp(mockPrisma: Record<string, unknown>) {
  const prisma = mockPrisma as unknown as Parameters<typeof createGuardrailRouter>[0];
  const app = express();
  app.use(express.json());
  app.use("/api/v1/guardrails", createGuardrailRouter(prisma));
  return app;
}

const sampleGuardrail = {
  id: UUID,
  name: "test-guardrail",
  endpointUrl: "https://example.com/evaluate",
  timeoutMs: 10000,
  failureMode: "fail_closed",
  pipelineOrder: 1,
  scopeChannel: null,
  scopeContentType: null,
  active: true,
  createdAt: new Date("2026-01-01"),
};

describe("POST /api/v1/guardrails", () => {
  it("creates a guardrail adapter", async () => {
    const createFn = vi.fn().mockResolvedValue(sampleGuardrail);
    const app = buildApp({ guardrail: { create: createFn } });

    const res = await request(app).post("/api/v1/guardrails").send({
      name: "test-guardrail",
      endpoint_url: "https://example.com/evaluate",
      failure_mode: "fail_closed",
      pipeline_order: 1,
    });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("test-guardrail");
    expect(res.body.endpoint_url).toBe("https://example.com/evaluate");
    expect(res.body.failure_mode).toBe("fail_closed");
    expect(res.body.pipeline_order).toBe(1);
    expect(res.body.timeout_ms).toBe(10000);
  });

  it("creates with custom timeout", async () => {
    const createFn = vi.fn().mockResolvedValue({ ...sampleGuardrail, timeoutMs: 5000 });
    const app = buildApp({ guardrail: { create: createFn } });

    const res = await request(app).post("/api/v1/guardrails").send({
      name: "test",
      endpoint_url: "https://example.com/evaluate",
      failure_mode: "fail_open",
      pipeline_order: 1,
      timeout_ms: 5000,
    });

    expect(res.status).toBe(201);
    expect(res.body.timeout_ms).toBe(5000);
  });

  it("returns 400 for missing name", async () => {
    const app = buildApp({ guardrail: { create: vi.fn() } });

    const res = await request(app).post("/api/v1/guardrails").send({
      endpoint_url: "https://example.com/evaluate",
      failure_mode: "fail_closed",
      pipeline_order: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("name");
  });

  it("returns 400 for missing endpoint_url", async () => {
    const app = buildApp({ guardrail: { create: vi.fn() } });

    const res = await request(app).post("/api/v1/guardrails").send({
      name: "test",
      failure_mode: "fail_closed",
      pipeline_order: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("endpoint_url");
  });

  it("returns 400 for invalid failure_mode", async () => {
    const app = buildApp({ guardrail: { create: vi.fn() } });

    const res = await request(app).post("/api/v1/guardrails").send({
      name: "test",
      endpoint_url: "https://example.com/evaluate",
      failure_mode: "invalid",
      pipeline_order: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("failure_mode");
  });

  it("returns 400 for missing pipeline_order", async () => {
    const app = buildApp({ guardrail: { create: vi.fn() } });

    const res = await request(app).post("/api/v1/guardrails").send({
      name: "test",
      endpoint_url: "https://example.com/evaluate",
      failure_mode: "fail_closed",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("pipeline_order");
  });

  it("returns 400 for timeout_ms exceeding max", async () => {
    const app = buildApp({ guardrail: { create: vi.fn() } });

    const res = await request(app).post("/api/v1/guardrails").send({
      name: "test",
      endpoint_url: "https://example.com/evaluate",
      failure_mode: "fail_closed",
      pipeline_order: 1,
      timeout_ms: 50000,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("timeout_ms");
  });
});

describe("GET /api/v1/guardrails", () => {
  it("lists all guardrails", async () => {
    const app = buildApp({
      guardrail: { findMany: vi.fn().mockResolvedValue([sampleGuardrail]) },
    });

    const res = await request(app).get("/api/v1/guardrails");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].name).toBe("test-guardrail");
  });
});

describe("GET /api/v1/guardrails/:id", () => {
  it("returns a single guardrail", async () => {
    const app = buildApp({
      guardrail: { findUnique: vi.fn().mockResolvedValue(sampleGuardrail) },
    });

    const res = await request(app).get(`/api/v1/guardrails/${UUID}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("test-guardrail");
  });

  it("returns 404 for non-existent guardrail", async () => {
    const app = buildApp({
      guardrail: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    const res = await request(app).get(`/api/v1/guardrails/${UUID}`);

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid ID format", async () => {
    const app = buildApp({ guardrail: { findUnique: vi.fn() } });

    const res = await request(app).get("/api/v1/guardrails/not-a-uuid");

    expect(res.status).toBe(400);
  });
});

describe("PUT /api/v1/guardrails/:id", () => {
  it("updates a guardrail", async () => {
    const updatedGuardrail = { ...sampleGuardrail, name: "updated-name" };
    const app = buildApp({
      guardrail: {
        findUnique: vi.fn().mockResolvedValue(sampleGuardrail),
        update: vi.fn().mockResolvedValue(updatedGuardrail),
      },
    });

    const res = await request(app).put(`/api/v1/guardrails/${UUID}`).send({ name: "updated-name" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("updated-name");
  });

  it("returns 404 for non-existent guardrail", async () => {
    const app = buildApp({
      guardrail: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    const res = await request(app).put(`/api/v1/guardrails/${UUID}`).send({ name: "updated" });

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid failure_mode", async () => {
    const app = buildApp({
      guardrail: { findUnique: vi.fn().mockResolvedValue(sampleGuardrail) },
    });

    const res = await request(app)
      .put(`/api/v1/guardrails/${UUID}`)
      .send({ failure_mode: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("failure_mode");
  });
});

describe("DELETE /api/v1/guardrails/:id", () => {
  it("soft-deletes a guardrail", async () => {
    const updateFn = vi.fn().mockResolvedValue({ ...sampleGuardrail, active: false });
    const app = buildApp({
      guardrail: {
        findUnique: vi.fn().mockResolvedValue(sampleGuardrail),
        update: updateFn,
      },
    });

    const res = await request(app).delete(`/api/v1/guardrails/${UUID}`);

    expect(res.status).toBe(204);
    expect(updateFn).toHaveBeenCalledWith({
      where: { id: UUID },
      data: { active: false },
    });
  });

  it("returns 404 for non-existent guardrail", async () => {
    const app = buildApp({
      guardrail: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    const res = await request(app).delete(`/api/v1/guardrails/${UUID}`);

    expect(res.status).toBe(404);
  });
});
