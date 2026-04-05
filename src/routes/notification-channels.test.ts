import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createNotificationChannelRouter } from "./notification-channels.js";

const UUID = "00000000-0000-0000-0000-000000000001";

function buildApp(mockPrisma: Record<string, unknown>) {
  const prisma = mockPrisma as unknown as Parameters<typeof createNotificationChannelRouter>[0];
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    _req.apiKey = { id: "api-key-1", name: "test-key" };
    next();
  });
  app.use("/api/v1/notification-channels", createNotificationChannelRouter(prisma));
  return app;
}

const baseMocks = () => ({
  notificationChannel: {
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: UUID,
      ...data,
      active: true,
      createdAt: new Date("2026-01-01"),
    })),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: UUID,
      type: "slack",
      config: { webhook_url: "https://hooks.slack.com/services/test" },
      active: true,
      createdAt: new Date("2026-01-01"),
      ...data,
    })),
  },
});

describe("POST /api/v1/notification-channels", () => {
  it("creates a slack channel", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app)
      .post("/api/v1/notification-channels")
      .send({
        type: "slack",
        config: { webhook_url: "https://hooks.slack.com/services/T00/B00/xxx" },
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(UUID);
    expect(res.body.type).toBe("slack");
    expect(res.body.active).toBe(true);
  });

  it("creates an email channel", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app)
      .post("/api/v1/notification-channels")
      .send({
        type: "email",
        config: { recipients: ["reviewer@example.com"] },
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("email");
  });

  it("rejects invalid type", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/notification-channels").send({
      type: "sms",
      config: {},
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("type must be");
  });

  it("rejects slack without webhook_url", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/notification-channels").send({
      type: "slack",
      config: {},
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("webhook_url");
  });

  it("rejects slack with non-slack webhook URL", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app)
      .post("/api/v1/notification-channels")
      .send({
        type: "slack",
        config: { webhook_url: "https://evil.com/hook" },
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("hooks.slack.com");
  });

  it("rejects email without recipients", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app)
      .post("/api/v1/notification-channels")
      .send({
        type: "email",
        config: { recipients: [] },
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("recipients");
  });

  it("rejects email with invalid recipients", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app)
      .post("/api/v1/notification-channels")
      .send({
        type: "email",
        config: { recipients: ["not-an-email"] },
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("email addresses");
  });

  it("rejects missing config", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).post("/api/v1/notification-channels").send({
      type: "slack",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("config");
  });
});

describe("GET /api/v1/notification-channels", () => {
  it("lists all channels", async () => {
    const mocks = baseMocks();
    mocks.notificationChannel.findMany = vi.fn().mockResolvedValue([
      {
        id: UUID,
        type: "slack",
        config: { webhook_url: "https://hooks.slack.com/services/test" },
        active: true,
        createdAt: new Date("2026-01-01"),
      },
    ]);
    const app = buildApp(mocks);
    const res = await request(app).get("/api/v1/notification-channels");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].type).toBe("slack");
  });
});

describe("PUT /api/v1/notification-channels/:id", () => {
  it("updates a channel", async () => {
    const mocks = baseMocks();
    mocks.notificationChannel.findUnique = vi.fn().mockResolvedValue({
      id: UUID,
      type: "slack",
      config: { webhook_url: "https://hooks.slack.com/services/old" },
      active: true,
    });
    const app = buildApp(mocks);
    const res = await request(app)
      .put(`/api/v1/notification-channels/${UUID}`)
      .send({
        config: { webhook_url: "https://hooks.slack.com/services/new" },
      });

    expect(res.status).toBe(200);
  });

  it("deactivates a channel via active flag", async () => {
    const mocks = baseMocks();
    mocks.notificationChannel.findUnique = vi.fn().mockResolvedValue({
      id: UUID,
      type: "slack",
      config: {},
      active: true,
    });
    mocks.notificationChannel.update = vi.fn().mockResolvedValue({
      id: UUID,
      type: "slack",
      config: {},
      active: false,
      createdAt: new Date(),
    });
    const app = buildApp(mocks);
    const res = await request(app)
      .put(`/api/v1/notification-channels/${UUID}`)
      .send({ active: false });

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  it("returns 404 for non-existent channel", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app)
      .put(`/api/v1/notification-channels/${UUID}`)
      .send({ active: false });

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid UUID", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app)
      .put("/api/v1/notification-channels/bad-id")
      .send({ active: false });

    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/v1/notification-channels/:id", () => {
  it("deactivates a channel", async () => {
    const mocks = baseMocks();
    mocks.notificationChannel.findUnique = vi.fn().mockResolvedValue({
      id: UUID,
      type: "slack",
      active: true,
    });
    const app = buildApp(mocks);
    const res = await request(app).delete(`/api/v1/notification-channels/${UUID}`);

    expect(res.status).toBe(204);
    expect(mocks.notificationChannel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { active: false },
      }),
    );
  });

  it("returns 404 for non-existent channel", async () => {
    const mocks = baseMocks();
    const app = buildApp(mocks);
    const res = await request(app).delete(`/api/v1/notification-channels/${UUID}`);

    expect(res.status).toBe(404);
  });
});
