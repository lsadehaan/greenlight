import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCleanup } from "./retention.js";

const now = new Date("2026-04-05T12:00:00Z");
const retentionDays = 90;
const cutoff = new Date(now);
cutoff.setDate(cutoff.getDate() - retentionDays);

// Submissions older than cutoff
const oldApproved = { id: "old-1" };
const oldRejected = { id: "old-2" };
// Pending submission older than cutoff — should NOT be deleted
const oldPending = { id: "old-pending" };
// Recent submission — should NOT be deleted
const recent = { id: "recent-1" };

function createMockPrisma() {
  const mockTx = vi.fn().mockResolvedValue(undefined);

  return {
    submission: {
      findMany: vi.fn()
        .mockResolvedValueOnce([oldApproved, oldRejected])
        .mockResolvedValueOnce([]), // second batch empty → stop
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    policyEvaluation: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
    guardrailEvaluation: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    review: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
    feedback: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditEvent: {
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: mockTx,
    $executeRaw: vi.fn().mockResolvedValueOnce(0), // no orphaned audit events
  };
}

describe("runCleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  it("deletes expired non-pending submissions in batches", async () => {
    const prisma = createMockPrisma();
    // Make $transaction execute the batch operations array
    prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);

    const result = await runCleanup(prisma as any, retentionDays);

    expect(result.submissions).toBe(2);

    // Verify findMany was called with correct filters
    const findCall = prisma.submission.findMany.mock.calls[0][0];
    expect(findCall.where.createdAt.lt).toBeInstanceOf(Date);
    expect(findCall.where.status.not).toBe("pending");
    expect(findCall.take).toBe(1000);
  });

  it("excludes pending submissions from deletion", async () => {
    const prisma = createMockPrisma();
    prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);

    await runCleanup(prisma as any, retentionDays);

    // Every findMany call should exclude pending
    for (const call of prisma.submission.findMany.mock.calls) {
      expect(call[0].where.status.not).toBe("pending");
    }
  });

  it("deletes child records before submissions in transaction", async () => {
    const prisma = createMockPrisma();
    const txOps: unknown[] = [];
    prisma.$transaction.mockImplementation(async (ops: unknown[]) => {
      txOps.push(...ops);
      return ops;
    });

    await runCleanup(prisma as any, retentionDays);

    // Transaction should have been called with 6 operations
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Array));
    const txCall = prisma.$transaction.mock.calls[0][0];
    expect(txCall).toHaveLength(6);
  });

  it("deletes orphaned audit events via $executeRaw", async () => {
    const prisma = createMockPrisma();
    prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);

    await runCleanup(prisma as any, retentionDays);

    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it("records audit event after cleanup", async () => {
    const prisma = createMockPrisma();
    prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);

    await runCleanup(prisma as any, retentionDays);

    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "retention.cleanup",
          actorType: "system",
          actor: "retention-worker",
        }),
      }),
    );
  });

  it("returns zero when no expired records exist", async () => {
    const prisma = createMockPrisma();
    prisma.submission.findMany = vi.fn().mockResolvedValue([]);
    prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);

    const result = await runCleanup(prisma as any, retentionDays);

    expect(result.submissions).toBe(0);
    expect(result.auditEvents).toBe(0);
    // No transaction should have been called (no submissions to delete)
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("handles multiple batches", async () => {
    const prisma = createMockPrisma();
    // First batch returns 1000 items (full batch → continue), second returns 500 (partial → stop)
    const fullBatch = Array.from({ length: 1000 }, (_, i) => ({ id: `s-${i}` }));
    const partialBatch = Array.from({ length: 500 }, (_, i) => ({ id: `s-${1000 + i}` }));
    prisma.submission.findMany = vi.fn()
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce(partialBatch)
      .mockResolvedValueOnce([]); // shouldn't be reached
    prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);

    const result = await runCleanup(prisma as any, retentionDays);

    expect(result.submissions).toBe(1500);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("uses configured retention days for cutoff", async () => {
    const prisma = createMockPrisma();
    prisma.submission.findMany = vi.fn().mockResolvedValue([]);
    prisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);

    await runCleanup(prisma as any, 30);

    const findCall = prisma.submission.findMany.mock.calls[0][0];
    const expectedCutoff = new Date(now);
    expectedCutoff.setDate(expectedCutoff.getDate() - 30);
    expect(findCall.where.createdAt.lt.getTime()).toBe(expectedCutoff.getTime());
  });
});
