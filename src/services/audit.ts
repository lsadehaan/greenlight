import type { PrismaClient } from "../generated/prisma/client.js";

export type AuditEventType =
  | "submission.created"
  | "submission.auto_approved"
  | "submission.auto_rejected"
  | "policy.evaluated"
  | "guardrail.evaluated"
  | "review.created"
  | "review.escalated"
  | "feedback.received"
  | "webhook.delivered"
  | "webhook.failed"
  | "notification.delivered"
  | "notification.failed"
  | "escalation.triggered";

export type AuditActorType = "human" | "ai" | "system" | "guardrail";

export interface AuditEntry {
  eventType: AuditEventType;
  submissionId?: string;
  actor?: string;
  actorType: AuditActorType;
  payload?: Record<string, unknown>;
}

export async function recordAuditEvent(prisma: PrismaClient, entry: AuditEntry): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      eventType: entry.eventType,
      submissionId: entry.submissionId ?? null,
      actor: entry.actor ?? null,
      actorType: entry.actorType,
      payload: entry.payload ? (entry.payload as object) : undefined,
    },
  });
}
