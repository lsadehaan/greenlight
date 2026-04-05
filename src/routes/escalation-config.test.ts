import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createEscalationConfigRouter } from "./escalation-config.js";

const UUID = "00000000-0000-0000-0000-000000000001";

function buildApp(mockPrisma: Record<string, unknown>) {
  const prisma = mockPrisma as unknown as Parameters<typeof createEscalationConfigRouter>[0];
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    _req.apiKey = { id: "api-key-1", name: "test-key" };
    next();
  });
  app.use("/api/v1/escalation-config", createEscalationConfigRouter(prisma));
  return app;
}

const baseMocks = () => ({
  escalationConfig: {
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: UUID,
      ...data,
      active: true,
    })),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: UUID,
      slaMinutes: 60,
      escalationChannel: "slack",
      escalationTarget: "#reviews",
      timeoutAction: "auto_approve",
      timeoutMinutes: 30,
      active: true,
      ...data,
    })),
  },
});

describe("POST /api/v1/escalation-config", () => {
  it("creates an escalation config", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/escalation-config").send({
      sla_minutes: 60,
      escalation_channel: "slack",
      escalation_target: "#reviews",
      timeout_action: "auto_approve",
      timeout_minutes: 30,
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(UUID);
    expect(res.body.sla_minutes).toBe(60);
    expect(res.body.timeout_action).toBe("auto_approve");
  });

  it("rejects missing sla_minutes", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/escalation-config").send({
      escalation_channel: "slack",
      escalation_target: "#reviews",
      timeout_action: "auto_approve",
      timeout_minutes: 30,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("sla_minutes");
  });

  it("rejects invalid timeout_action", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/escalation-config").send({
      sla_minutes: 60,
      escalation_channel: "slack",
      escalation_target: "#reviews",
      timeout_action: "auto_delete",
      timeout_minutes: 30,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("timeout_action");
  });

  it("rejects negative sla_minutes", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/escalation-config").send({
      sla_minutes: -5,
      escalation_channel: "slack",
      escalation_target: "#reviews",
      timeout_action: "auto_approve",
      timeout_minutes: 30,
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/escalation-config", () => {
  it("lists configs", async () => {
    const mocks = baseMocks();
    mocks.escalationConfig.findMany = vi.fn().mockResolvedValue([
      {
        id: UUID,
        slaMinutes: 60,
        escalationChannel: "slack",
        escalationTarget: "#reviews",
        timeoutAction: "auto_approve",
        timeoutMinutes: 30,
        active: true,
      },
    ]);
    const app = buildApp(mocks);
    const res = await request(app).get("/api/v1/escalation-config");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].sla_minutes).toBe(60);
  });
});

describe("PUT /api/v1/escalation-config/:id", () => {
  it("updates a config", async () => {
    const mocks = baseMocks();
    mocks.escalationConfig.findUnique = vi.fn().mockResolvedValue({
      id: UUID,
      slaMinutes: 60,
      active: true,
    });
    const app = buildApp(mocks);
    const res = await request(app)
      .put(`/api/v1/escalation-config/${UUID}`)
      .send({ sla_minutes: 120 });

    expect(res.status).toBe(200);
  });

  it("returns 404 for non-existent config", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app)
      .put(`/api/v1/escalation-config/${UUID}`)
      .send({ sla_minutes: 120 });

    expect(res.status).toBe(404);
  });

  it("rejects invalid timeout_action on update", async () => {
    const mocks = baseMocks();
    mocks.escalationConfig.findUnique = vi.fn().mockResolvedValue({ id: UUID, active: true });
    const app = buildApp(mocks);
    const res = await request(app)
      .put(`/api/v1/escalation-config/${UUID}`)
      .send({ timeout_action: "bad" });

    expect(res.status).toBe(400);
  });
});
