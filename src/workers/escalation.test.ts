import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkEscalations } from "./escalation.js";

vi.mock("../services/audit.js", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./notification.js", () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./webhook.js", () => ({
  enqueueWebhook: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../routes/reviews.js", () => ({
  actionTokens: new Map(),
}));

import { recordAuditEvent } from "../services/audit.js";
import { enqueueNotification } from "./notification.js";
import { enqueueWebhook } from "./webhook.js";

const mockedRecordAudit = vi.mocked(recordAuditEvent);
const mockedEnqueueNotification = vi.mocked(enqueueNotification);
const mockedEnqueueWebhook = vi.mocked(enqueueWebhook);

const mockNotifQueue = { add: vi.fn().mockResolvedValue({}) } as unknown as Parameters<
  typeof checkEscalations
>[1];
const mockWebhookQueue = { add: vi.fn().mockResolvedValue({}) } as unknown as Parameters<
  typeof checkEscalations
>[2];

beforeEach(() => {
  vi.clearAllMocks();
});

function mockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    escalationConfig: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    submission: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ status: "pending" }),
      update: vi.fn().mockResolvedValue({}),
    },
    auditEvent: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  } as unknown as Parameters<typeof checkEscalations>[0];
}

const activeConfig = {
  id: "esc-1",
  slaMinutes: 60,
  escalationChannel: "slack",
  escalationTarget: "#reviews",
  timeoutAction: "auto_approve",
  timeoutMinutes: 30,
  active: true,
};

describe("checkEscalations", () => {
  it("does nothing when no active configs", async () => {
    const prisma = mockPrisma();
    await checkEscalations(prisma, mockNotifQueue, mockWebhookQueue);

    expect(
      (prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>).submission
        .findMany,
    ).not.toHaveBeenCalled();
  });

  it("does nothing when no overdue submissions", async () => {
    const prisma = mockPrisma({
      escalationConfig: {
        findMany: vi.fn().mockResolvedValue([activeConfig]),
      },
    });
    await checkEscalations(prisma, mockNotifQueue, mockWebhookQueue);

    expect(mockedEnqueueNotification).not.toHaveBeenCalled();
  });

  it("escalates submission past SLA with notification", async () => {
    const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000);
    const prisma = mockPrisma({
      escalationConfig: {
        findMany: vi.fn().mockResolvedValue([activeConfig]),
      },
      submission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "sub-1",
            content: "test content",
            channel: "email",
            contentType: "text/plain",
            callbackUrl: null,
            createdAt: twoHoursAgo, // Past 60 min SLA but within 60+30=90 min timeout
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({ status: "pending" }),
        update: vi.fn().mockResolvedValue({}),
      },
    });

    // Make the submission within the escalation window (past SLA, not past timeout)
    // twoHoursAgo is past both SLA (60min) and timeout (60+30=90min)
    // Use 70 min ago instead for just SLA breach
    const seventyMinAgo = new Date(Date.now() - 70 * 60 * 1000);
    (
      prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
    ).submission.findMany.mockResolvedValue([
      {
        id: "sub-1",
        content: "test content",
        channel: "email",
        contentType: "text/plain",
        callbackUrl: null,
        createdAt: seventyMinAgo,
      },
    ]);

    await checkEscalations(prisma, mockNotifQueue, mockWebhookQueue);

    expect(mockedEnqueueNotification).toHaveBeenCalledOnce();
    expect(mockedRecordAudit).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        eventType: "escalation.triggered",
        submissionId: "sub-1",
        actorType: "system",
      }),
    );
  });

  it("skips escalation if already escalated (idempotency)", async () => {
    const seventyMinAgo = new Date(Date.now() - 70 * 60 * 1000);
    const prisma = mockPrisma({
      escalationConfig: {
        findMany: vi.fn().mockResolvedValue([activeConfig]),
      },
      submission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "sub-1",
            content: "test",
            channel: "email",
            contentType: "text/plain",
            callbackUrl: null,
            createdAt: seventyMinAgo,
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({ status: "pending" }),
        update: vi.fn().mockResolvedValue({}),
      },
      auditEvent: {
        create: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue({ id: "existing-escalation" }),
      },
    });

    await checkEscalations(prisma, mockNotifQueue, mockWebhookQueue);

    expect(mockedEnqueueNotification).not.toHaveBeenCalled();
  });

  it("auto-approves when past SLA + timeout", async () => {
    const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000);
    const prisma = mockPrisma({
      escalationConfig: {
        findMany: vi.fn().mockResolvedValue([activeConfig]),
      },
      submission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "sub-1",
            content: "test",
            channel: "email",
            contentType: "text/plain",
            callbackUrl: null,
            createdAt: twoHoursAgo,
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({ status: "pending" }),
        update: vi.fn().mockResolvedValue({}),
      },
    });

    await checkEscalations(prisma, mockNotifQueue, mockWebhookQueue);

    const updateMock = (
      prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
    ).submission.update;
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "approved",
          decidedBy: "system",
        }),
      }),
    );
    expect(mockedRecordAudit).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        eventType: "submission.auto_approved",
        payload: expect.objectContaining({ reason: "escalation_timeout" }),
      }),
    );
  });

  it("auto-rejects when timeout_action is auto_reject", async () => {
    const rejectConfig = { ...activeConfig, timeoutAction: "auto_reject" };
    const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000);
    const prisma = mockPrisma({
      escalationConfig: {
        findMany: vi.fn().mockResolvedValue([rejectConfig]),
      },
      submission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "sub-1",
            content: "test",
            channel: "email",
            contentType: "text/plain",
            callbackUrl: null,
            createdAt: twoHoursAgo,
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({ status: "pending" }),
        update: vi.fn().mockResolvedValue({}),
      },
    });

    await checkEscalations(prisma, mockNotifQueue, mockWebhookQueue);

    const updateMock = (
      prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
    ).submission.update;
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "rejected",
          decidedBy: "system",
        }),
      }),
    );
  });

  it("skips auto-decide if submission no longer pending", async () => {
    const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000);
    const prisma = mockPrisma({
      escalationConfig: {
        findMany: vi.fn().mockResolvedValue([activeConfig]),
      },
      submission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "sub-1",
            content: "test",
            channel: "email",
            contentType: "text/plain",
            callbackUrl: null,
            createdAt: twoHoursAgo,
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({ status: "approved" }),
        update: vi.fn().mockResolvedValue({}),
      },
    });

    await checkEscalations(prisma, mockNotifQueue, mockWebhookQueue);

    const updateMock = (
      prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
    ).submission.update;
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("triggers webhook on auto-decide when callback_url exists", async () => {
    const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000);
    const prisma = mockPrisma({
      escalationConfig: {
        findMany: vi.fn().mockResolvedValue([activeConfig]),
      },
      submission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "sub-1",
            content: "test",
            channel: "email",
            contentType: "text/plain",
            callbackUrl: "https://example.com/hook",
            createdAt: twoHoursAgo,
          },
        ]),
        findUnique: vi.fn().mockResolvedValue({ status: "pending" }),
        update: vi.fn().mockResolvedValue({}),
      },
    });

    await checkEscalations(prisma, mockNotifQueue, mockWebhookQueue);

    expect(mockedEnqueueWebhook).toHaveBeenCalledWith(
      mockWebhookQueue,
      expect.objectContaining({
        submissionId: "sub-1",
        callbackUrl: "https://example.com/hook",
        payload: expect.objectContaining({
          decision: "approved",
          decided_by: "system",
        }),
      }),
    );
  });
});
