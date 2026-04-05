/**
 * E2E lifecycle tests — run against a live Greenlight server.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *   E2E_BASE_URL=http://localhost:3000 npm run test:e2e
 *
 * These tests exercise the complete submission lifecycle:
 *   submit -> policy eval -> guardrail -> AI review -> human review -> webhook -> feedback
 */
import { describe, it, expect, beforeAll } from "vitest";
import { api, submitContent, waitForDecision, isE2EEnabled } from "./helpers.js";

// Skip entire suite if E2E_BASE_URL is not set
const describeE2E = isE2EEnabled() ? describe : describe.skip;

let apiKey: string;

describeE2E("E2E: Submission lifecycle", () => {
  beforeAll(async () => {
    // Bootstrap: create an API key via the initial seed or POST
    // The test assumes a bootstrap key is available via env
    apiKey = process.env.E2E_API_KEY || "";
    if (!apiKey) {
      throw new Error("E2E_API_KEY must be set to a valid API key for the test server");
    }
  });

  it("health check returns 200", async () => {
    const res = await api("/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
  });

  it("creates a policy", async () => {
    const res = await api("/api/v1/policies", {
      method: "POST",
      apiKey,
      body: {
        name: "e2e-test-length-check",
        type: "keyword",
        config: { keywords: ["blocked-word"] },
        action: "block",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("name", "e2e-test-length-check");
  });

  it("auto-approves a clean submission via rules", async () => {
    const sub = await submitContent(apiKey, {
      channel: "email",
      content_type: "text/plain",
      content: { text: "This is a perfectly fine submission" },
    });

    expect(sub.id).toBeDefined();

    // For auto-approve, the response should already have a decision
    // or we wait briefly for async processing
    const result = await waitForDecision(apiKey, sub.id, 10000);
    expect(["approved", "pending"]).toContain(result.status);
  });

  it("blocks a submission matching a block policy", async () => {
    const sub = await submitContent(apiKey, {
      channel: "email",
      content_type: "text/plain",
      content: { text: "This contains blocked-word and should be rejected" },
    });

    const result = await waitForDecision(apiKey, sub.id, 10000);
    expect(result.status).toBe("rejected");
  });

  it("submits feedback on a decided submission", async () => {
    // Create and wait for a submission to be decided
    const sub = await submitContent(apiKey, {
      channel: "email",
      content_type: "text/plain",
      content: { text: "Feedback test submission" },
    });

    const result = await waitForDecision(apiKey, sub.id, 10000);
    expect(result.status).not.toBe("pending");

    // Submit feedback
    const feedbackRes = await api(`/api/v1/submissions/${sub.id}/feedback`, {
      method: "POST",
      apiKey,
      body: { outcome: "positive", reason: "Correct decision" },
    });
    expect(feedbackRes.status).toBe(201);
  });

  it("retrieves audit trail for a submission", async () => {
    const sub = await submitContent(apiKey, {
      channel: "api",
      content_type: "text/plain",
      content: { text: "Audit trail test" },
    });

    await waitForDecision(apiKey, sub.id, 10000);

    const auditRes = await api(`/api/v1/audit?submission_id=${sub.id}`, { apiKey });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body).toHaveProperty("data");
  });

  it("analytics summary returns valid data", async () => {
    const res = await api("/api/v1/analytics/summary", { apiKey });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("total_submissions");
    expect(res.body).toHaveProperty("approval_rate");
    expect(res.body).toHaveProperty("review_tier_funnel");
    expect(res.body).toHaveProperty("ai_review_stats");
    expect(res.body).toHaveProperty("guardrail_stats");
  });

  it("analytics submissions returns paginated data", async () => {
    const res = await api("/api/v1/analytics/submissions?page=1&per_page=5", { apiKey });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("page", 1);
    expect(res.body).toHaveProperty("per_page", 5);
  });

  it("OpenAPI spec is accessible", async () => {
    const res = await api("/api/docs/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("openapi", "3.0.3");
    expect(res.body).toHaveProperty("paths");
  });

  it("Swagger UI is accessible", async () => {
    const res = await api("/api/docs/");
    expect(res.status).toBe(200);
  });
});

describeE2E("E2E: Webhook delivery", () => {
  beforeAll(async () => {
    apiKey = process.env.E2E_API_KEY || "";
  });

  it("delivers webhook on submission decision", async () => {
    // This test requires a webhook receiver (e.g., mock server)
    const callbackUrl = process.env.E2E_WEBHOOK_URL;
    if (!callbackUrl) {
      console.log("Skipping webhook test: E2E_WEBHOOK_URL not set");
      return;
    }

    const sub = await submitContent(apiKey, {
      channel: "webhook-test",
      content_type: "text/plain",
      content: { text: "Webhook delivery test" },
      callback_url: callbackUrl,
    });

    // Wait for decision
    await waitForDecision(apiKey, sub.id, 15000);

    // The webhook should have been delivered to the callback URL
    // Verification depends on the mock server collecting requests
  });
});

describeE2E("E2E: Review UI", () => {
  beforeAll(async () => {
    apiKey = process.env.E2E_API_KEY || "";
  });

  it("review queue page loads", async () => {
    const res = await api(`/review?token=${apiKey}`);
    expect(res.status).toBe(200);
  });

  it("dashboard page loads", async () => {
    const res = await api(`/dashboard?token=${apiKey}`);
    expect(res.status).toBe(200);
  });
});
