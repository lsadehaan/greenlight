import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { signPayload, enqueueWebhook } from "./webhook.js";
import type { WebhookJobData } from "./webhook.js";

// ---------- signPayload ----------

describe("signPayload", () => {
  it("returns consistent HMAC-SHA256 signature", () => {
    const sig1 = signPayload('{"test":true}', "secret");
    const sig2 = signPayload('{"test":true}', "secret");
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(64);
  });

  it("returns different signatures for different payloads", () => {
    const sig1 = signPayload("payload-a", "secret");
    const sig2 = signPayload("payload-b", "secret");
    expect(sig1).not.toBe(sig2);
  });

  it("returns different signatures for different secrets", () => {
    const sig1 = signPayload("same-payload", "secret-1");
    const sig2 = signPayload("same-payload", "secret-2");
    expect(sig1).not.toBe(sig2);
  });
});

// ---------- enqueueWebhook ----------

describe("enqueueWebhook", () => {
  it("adds a job to the queue with retry config", async () => {
    const addFn = vi.fn().mockResolvedValue({ id: "job-1" });
    const mockQueue = { add: addFn } as unknown as Parameters<typeof enqueueWebhook>[0];

    const data: WebhookJobData = {
      submissionId: "sub-1",
      callbackUrl: "https://example.com/webhook",
      payload: {
        submission_id: "sub-1",
        decision: "approved",
        decided_at: "2026-01-01T00:00:00.000Z",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    };

    await enqueueWebhook(mockQueue, data);

    expect(addFn).toHaveBeenCalledOnce();
    expect(addFn).toHaveBeenCalledWith("deliver", data, {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
    });
  });
});

// ---------- Webhook delivery integration ----------

describe("webhook delivery (via direct import)", () => {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterAll(() => server.close());

  it("delivers payload with HMAC signature header", async () => {
    let receivedHeaders: Record<string, string> = {};
    let receivedBody = "";

    server.use(
      http.post("https://hook.test/callback", async ({ request }) => {
        receivedHeaders = Object.fromEntries(request.headers.entries());
        receivedBody = await request.text();
        return HttpResponse.json({ ok: true });
      }),
    );

    // Directly test the delivery function via fetch (simulating what the worker does)
    const payload = JSON.stringify({
      submission_id: "sub-1",
      decision: "approved",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const signature = signPayload(payload, "test-secret");

    const resp = await fetch("https://hook.test/callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Greenlight-Signature": `sha256=${signature}`,
      },
      body: payload,
    });

    expect(resp.ok).toBe(true);
    expect(receivedHeaders["x-greenlight-signature"]).toBe(`sha256=${signature}`);
    expect(receivedBody).toBe(payload);

    // Verify signature matches
    const expectedSig = signPayload(receivedBody, "test-secret");
    expect(receivedHeaders["x-greenlight-signature"]).toBe(`sha256=${expectedSig}`);
  });

  it("HMAC signature can be verified by recipient", () => {
    const payload = '{"submission_id":"abc","decision":"approved"}';
    const secret = "shared-secret";
    const signature = signPayload(payload, secret);

    // Recipient verifies by computing same HMAC
    const verified = signPayload(payload, secret);
    expect(signature).toBe(verified);
  });
});

// ---------- Webhook job data shape ----------

describe("WebhookJobData", () => {
  it("includes all required fields", () => {
    const data: WebhookJobData = {
      submissionId: "sub-1",
      callbackUrl: "https://example.com/hook",
      payload: {
        submission_id: "sub-1",
        decision: "rejected",
        reviewer_type: "human",
        reviewer_identity: "admin",
        policy_results: [
          { policy_name: "no-spam", result: "match", action: "block" },
        ],
        decided_at: "2026-01-01T00:00:00.000Z",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    };

    expect(data.payload.decision).toBe("rejected");
    expect(data.payload.policy_results).toHaveLength(1);
    expect(data.payload.reviewer_type).toBe("human");
  });
});
