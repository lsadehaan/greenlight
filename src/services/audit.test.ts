import { describe, it, expect, vi } from "vitest";
import { recordAuditEvent } from "./audit.js";

describe("recordAuditEvent", () => {
  it("creates an audit event with all fields", async () => {
    const createFn = vi.fn().mockResolvedValue({ id: "audit-1" });
    const prisma = { auditEvent: { create: createFn } } as unknown as Parameters<
      typeof recordAuditEvent
    >[0];

    await recordAuditEvent(prisma, {
      eventType: "submission.created",
      submissionId: "sub-1",
      actor: "test-key",
      actorType: "system",
      payload: { channel: "email", status: "approved" },
    });

    expect(createFn).toHaveBeenCalledOnce();
    expect(createFn).toHaveBeenCalledWith({
      data: {
        eventType: "submission.created",
        submissionId: "sub-1",
        actor: "test-key",
        actorType: "system",
        payload: { channel: "email", status: "approved" },
      },
    });
  });

  it("handles missing optional fields", async () => {
    const createFn = vi.fn().mockResolvedValue({ id: "audit-2" });
    const prisma = { auditEvent: { create: createFn } } as unknown as Parameters<
      typeof recordAuditEvent
    >[0];

    await recordAuditEvent(prisma, {
      eventType: "policy.evaluated",
      actorType: "system",
    });

    expect(createFn).toHaveBeenCalledWith({
      data: {
        eventType: "policy.evaluated",
        submissionId: null,
        actor: null,
        actorType: "system",
        payload: undefined,
      },
    });
  });

  it("supports all event types", async () => {
    const createFn = vi.fn().mockResolvedValue({ id: "audit-3" });
    const prisma = { auditEvent: { create: createFn } } as unknown as Parameters<
      typeof recordAuditEvent
    >[0];

    const eventTypes = [
      "submission.created",
      "submission.auto_approved",
      "submission.auto_rejected",
      "policy.evaluated",
      "review.created",
      "review.escalated",
      "feedback.received",
      "webhook.delivered",
      "webhook.failed",
    ] as const;

    for (const eventType of eventTypes) {
      await recordAuditEvent(prisma, { eventType, actorType: "system" });
    }

    expect(createFn).toHaveBeenCalledTimes(eventTypes.length);
  });

  it("supports all actor types", async () => {
    const createFn = vi.fn().mockResolvedValue({ id: "audit-4" });
    const prisma = { auditEvent: { create: createFn } } as unknown as Parameters<
      typeof recordAuditEvent
    >[0];

    const actorTypes = ["human", "ai", "system", "guardrail"] as const;

    for (const actorType of actorTypes) {
      await recordAuditEvent(prisma, { eventType: "submission.created", actorType });
    }

    expect(createFn).toHaveBeenCalledTimes(actorTypes.length);
  });
});
