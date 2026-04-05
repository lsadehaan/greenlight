import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCleanup } from "./retention.js";

const now = new Date("2026-04-05T12:00:00Z");
const retentionDays = 90;

// Submissions older than cutoff
const oldApproved = { id: "old-1" };
const oldRejected = { id: "old-2" };

function createMockPrisma() {
  const base = {
    submission: {
      findMany: vi.fn()
        .mockResolvedValueOnce([oldApproved, oldRejected])
        .mockResolvedValueOnce([]),
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
    // Interactive transaction: receives a callback, passes `tx` (which is the same mock)
    $transaction: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValueOnce(0),
  };

  // $transaction calls the callback with the mock itself as the tx client
  base.$transaction.mockImplementation(
    async (fn: (tx: typeof base) => Promise<unknown>) => fn(base),
  );

  return base;
}

describe("runCleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  it("deletes expired non-pending submissions in batches", async () => {
    const prisma = createMockPrisma();
    const result = await runCleanup(prisma as any, retentionDays);

    expect(result.submissions).toBe(2);

    // Verify findMany was called with correct filters inside the transaction
    const findCall = prisma.submission.findMany.mock.calls[0][0];
    expect(findCall.where.createdAt.lt).toBeInstanceOf(Date);
    expect(findCall.where.status.not).toBe("pending");
    expect(findCall.take).toBe(1000);
  });

  it("excludes pending submissions from deletion", async () => {
    const prisma = createMockPrisma();
    await runCleanup(prisma as any, retentionDays);

    for (const call of prisma.submission.findMany.mock.calls) {
      expect(call[0].where.status.not).toBe("pending");
    }
  });

  it("deletes child records before submissions in transaction", async () => {
    const prisma = createMockPrisma();
    await runCleanup(prisma as any, retentionDays);

    // Transaction should have been called (interactive transaction with callback)
    expect(prisma.$transaction).toHaveBeenCalled();

    // Inside the transaction, child deletions happen before submission deletion
    // Verify the order via call order tracking
    const policyDeleteOrder = prisma.policyEvaluation.deleteMany.mock.invocationCallOrder[0];
    const subDeleteOrder = prisma.submission.deleteMany.mock.invocationCallOrder[0];
    expect(policyDeleteOrder).toBeLessThan(subDeleteOrder);
  });

  it("deletes orphaned audit events via $executeRaw", async () => {
    const prisma = createMockPrisma();
    await runCleanup(prisma as any, retentionDays);

    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it("records audit event after cleanup", async () => {
    const prisma = createMockPrisma();
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
    // Override: first transaction call returns 0 (empty batch)
    prisma.submission.findMany = vi.fn().mockResolvedValue([]);

    const result = await runCleanup(prisma as any, retentionDays);

    expect(result.submissions).toBe(0);
    expect(result.auditEvents).toBe(0);
  });

  it("handles multiple batches", async () => {
    const prisma = createMockPrisma();
    const fullBatch = Array.from({ length: 1000 }, (_, i) => ({ id: `s-${i}` }));
    const partialBatch = Array.from({ length: 500 }, (_, i) => ({ id: `s-${1000 + i}` }));
    prisma.submission.findMany = vi.fn()
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce(partialBatch);
    prisma.submission.deleteMany = vi.fn()
      .mockResolvedValueOnce({ count: 1000 })
      .mockResolvedValueOnce({ count: 500 });

    const result = await runCleanup(prisma as any, retentionDays);

    expect(result.submissions).toBe(1500);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("uses configured retention days for cutoff", async () => {
    const prisma = createMockPrisma();
    prisma.submission.findMany = vi.fn().mockResolvedValue([]);

    await runCleanup(prisma as any, 30);

    const findCall = prisma.submission.findMany.mock.calls[0][0];
    const expectedCutoff = new Date(now);
    expectedCutoff.setDate(expectedCutoff.getDate() - 30);
    expect(findCall.where.createdAt.lt.getTime()).toBe(expectedCutoff.getTime());
  });
});
