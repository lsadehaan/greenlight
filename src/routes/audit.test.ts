import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createAuditRouter } from "./audit.js";

const UUID = "00000000-0000-0000-0000-000000000001";

function buildApp(mockPrisma: Record<string, unknown>) {
  const prisma = mockPrisma as unknown as Parameters<typeof createAuditRouter>[0];
  const app = express();
  app.use(express.json());
  app.use("/api/v1/audit", createAuditRouter(prisma));
  return app;
}

const sampleEvents = [
  {
    id: "00000000-0000-0000-0000-000000000010",
    submissionId: UUID,
    eventType: "submission.created",
    actor: "test-key",
    actorType: "system",
    payload: { channel: "email" },
    createdAt: new Date("2026-01-01T00:00:00Z"),
  },
  {
    id: "00000000-0000-0000-0000-000000000011",
    submissionId: UUID,
    eventType: "policy.evaluated",
    actor: "no-spam",
    actorType: "system",
    payload: { result: "pass" },
    createdAt: new Date("2026-01-01T00:00:01Z"),
  },
];

describe("GET /api/v1/audit", () => {
  it("returns paginated audit events", async () => {
    const app = buildApp({
      auditEvent: {
        findMany: vi.fn().mockResolvedValue(sampleEvents),
        count: vi.fn().mockResolvedValue(2),
      },
    });

    const res = await request(app).get("/api/v1/audit");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.per_page).toBe(50);
    expect(res.body.data[0].event_type).toBe("submission.created");
    expect(res.body.data[0].submission_id).toBe(UUID);
  });

  it("filters by submission_id", async () => {
    const findManyFn = vi.fn().mockResolvedValue(sampleEvents);
    const countFn = vi.fn().mockResolvedValue(2);
    const app = buildApp({
      auditEvent: { findMany: findManyFn, count: countFn },
    });

    await request(app).get(`/api/v1/audit?submission_id=${UUID}`);

    expect(findManyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ submissionId: UUID }),
      }),
    );
  });

  it("filters by event_type", async () => {
    const findManyFn = vi.fn().mockResolvedValue([]);
    const countFn = vi.fn().mockResolvedValue(0);
    const app = buildApp({
      auditEvent: { findMany: findManyFn, count: countFn },
    });

    await request(app).get("/api/v1/audit?event_type=submission.created");

    expect(findManyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventType: "submission.created" }),
      }),
    );
  });

  it("filters by actor_type", async () => {
    const findManyFn = vi.fn().mockResolvedValue([]);
    const countFn = vi.fn().mockResolvedValue(0);
    const app = buildApp({
      auditEvent: { findMany: findManyFn, count: countFn },
    });

    await request(app).get("/api/v1/audit?actor_type=human");

    expect(findManyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorType: "human" }),
      }),
    );
  });

  it("filters by date range", async () => {
    const findManyFn = vi.fn().mockResolvedValue([]);
    const countFn = vi.fn().mockResolvedValue(0);
    const app = buildApp({
      auditEvent: { findMany: findManyFn, count: countFn },
    });

    await request(app).get("/api/v1/audit?from=2026-01-01&to=2026-01-31");

    expect(findManyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date("2026-01-01"),
            lte: new Date("2026-01-31"),
          },
        }),
      }),
    );
  });

  it("supports pagination with page and per_page", async () => {
    const findManyFn = vi.fn().mockResolvedValue([]);
    const countFn = vi.fn().mockResolvedValue(100);
    const app = buildApp({
      auditEvent: { findMany: findManyFn, count: countFn },
    });

    const res = await request(app).get("/api/v1/audit?page=3&per_page=10");

    expect(res.body.page).toBe(3);
    expect(res.body.per_page).toBe(10);
    expect(findManyFn).toHaveBeenCalledWith(expect.objectContaining({ take: 10, skip: 20 }));
  });

  it("caps per_page at 200", async () => {
    const findManyFn = vi.fn().mockResolvedValue([]);
    const countFn = vi.fn().mockResolvedValue(0);
    const app = buildApp({
      auditEvent: { findMany: findManyFn, count: countFn },
    });

    const res = await request(app).get("/api/v1/audit?per_page=500");

    expect(res.body.per_page).toBe(200);
  });

  it("returns 400 for invalid submission_id format", async () => {
    const app = buildApp({
      auditEvent: { findMany: vi.fn(), count: vi.fn() },
    });

    const res = await request(app).get("/api/v1/audit?submission_id=not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Invalid submission_id");
  });

  it("returns CSV format", async () => {
    const app = buildApp({
      auditEvent: {
        findMany: vi.fn().mockResolvedValue(sampleEvents),
        count: vi.fn().mockResolvedValue(2),
      },
    });

    const res = await request(app).get("/api/v1/audit?format=csv");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("audit.csv");

    const lines = res.text.split("\n");
    expect(lines[0]).toBe("id,submission_id,event_type,actor,actor_type,payload,created_at");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).toContain("submission.created");
    expect(lines[1]).toContain(UUID);
  });

  it("CSV escapes fields with commas and quotes", async () => {
    const eventWithComma = [
      {
        id: "00000000-0000-0000-0000-000000000012",
        submissionId: UUID,
        eventType: "review.created",
        actor: 'user, "admin"',
        actorType: "human",
        payload: { note: "has, comma" },
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];
    const app = buildApp({
      auditEvent: {
        findMany: vi.fn().mockResolvedValue(eventWithComma),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const res = await request(app).get("/api/v1/audit?format=csv");

    const lines = res.text.split("\n");
    // Actor field should be escaped
    expect(lines[1]).toContain('"user, ""admin"""');
  });

  it("returns empty list when no events match", async () => {
    const app = buildApp({
      auditEvent: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    });

    const res = await request(app).get("/api/v1/audit");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});
