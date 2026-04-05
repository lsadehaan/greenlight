import type { PrismaClient } from "../generated/prisma/client.js";
import { recordAuditEvent } from "../services/audit.js";

export interface GuardrailInput {
  submissionId: string;
  content: string;
  metadata: Record<string, unknown>;
  channel: string;
  contentType: string;
}

export interface GuardrailResult {
  guardrailId: string;
  guardrailName: string;
  verdict: "pass" | "fail" | "flag";
  confidence: number | null;
  reasoning: string | null;
  categories: string[] | null;
  latencyMs: number;
  failureMode: string;
  error?: string;
}

interface AdapterResponse {
  verdict: "pass" | "fail" | "flag";
  confidence?: number;
  reasoning?: string;
  categories?: string[];
}

const MAX_TIMEOUT_MS = 30000;

export async function evaluateGuardrails(
  prisma: PrismaClient,
  input: GuardrailInput,
): Promise<GuardrailResult[]> {
  const guardrails = await prisma.guardrail.findMany({
    where: {
      active: true,
      OR: [
        { scopeChannel: null, scopeContentType: null },
        { scopeChannel: input.channel, scopeContentType: null },
        { scopeChannel: null, scopeContentType: input.contentType },
        { scopeChannel: input.channel, scopeContentType: input.contentType },
      ],
    },
    orderBy: { pipelineOrder: "asc" },
  });

  const results: GuardrailResult[] = [];

  for (const guardrail of guardrails) {
    const timeoutMs = Math.min(guardrail.timeoutMs, MAX_TIMEOUT_MS);
    const start = Date.now();
    let result: GuardrailResult;

    try {
      const resp = await fetch(guardrail.endpointUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submission_id: input.submissionId,
          content: input.content,
          metadata: input.metadata,
          channel: input.channel,
          content_type: input.contentType,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!resp.ok) {
        throw new Error(`Adapter returned status ${resp.status}`);
      }

      const body = (await resp.json()) as AdapterResponse;
      const latencyMs = Date.now() - start;

      const verdict = validateVerdict(body.verdict);

      result = {
        guardrailId: guardrail.id,
        guardrailName: guardrail.name,
        verdict,
        confidence: body.confidence ?? null,
        reasoning: body.reasoning ?? null,
        categories: body.categories ?? null,
        latencyMs,
        failureMode: guardrail.failureMode,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Apply failure mode
      const verdict = guardrail.failureMode === "fail_closed" ? "fail" : "pass";

      result = {
        guardrailId: guardrail.id,
        guardrailName: guardrail.name,
        verdict,
        confidence: null,
        reasoning: null,
        categories: null,
        latencyMs,
        failureMode: guardrail.failureMode,
        error: errorMsg,
      };
    }

    results.push(result);

    // Record audit event (best-effort)
    try {
      await recordAuditEvent(prisma, {
        eventType: "guardrail.evaluated",
        submissionId: input.submissionId,
        actor: guardrail.name,
        actorType: "guardrail",
        payload: {
          guardrail_id: guardrail.id,
          verdict: result.verdict,
          confidence: result.confidence,
          latency_ms: result.latencyMs,
          error: result.error,
        },
      });
    } catch {
      // Best-effort
    }

    // Short-circuit on fail_closed failure
    if (result.verdict === "fail" && guardrail.failureMode === "fail_closed") {
      break;
    }
  }

  return results;
}

function validateVerdict(verdict: unknown): "pass" | "fail" | "flag" {
  if (verdict === "pass" || verdict === "fail" || verdict === "flag") {
    return verdict;
  }
  throw new Error(`Invalid verdict: ${String(verdict)}`);
}
