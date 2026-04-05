/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  enqueueNotification,
  processNotificationJob,
  buildSlackPayload,
  buildEmailHtml,
} from "./notification.js";
import type { NotificationJobData } from "./notification.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const baseJobData: NotificationJobData = {
  submissionId: "sub-1",
  contentPreview: "This is test content that needs review",
  channel: "email",
  contentType: "text/plain",
  policyFlags: [{ policy_name: "regex-check", action: "flag", detail: "Matched pattern" }],
  guardrailFlags: [],
  approveToken: "approve-token-123",
  rejectToken: "reject-token-456",
  tokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
};

const smtpConfig = {
  host: "",
  port: 587,
  user: "",
  pass: "",
  from: "test@greenlight.local",
};

// ---------- enqueueNotification ----------

describe("enqueueNotification", () => {
  it("adds a job to the queue with retry config", async () => {
    const addFn = vi.fn().mockResolvedValue({ id: "job-1" });
    const mockQueue = { add: addFn } as unknown as Parameters<typeof enqueueNotification>[0];

    await enqueueNotification(mockQueue, baseJobData);

    expect(addFn).toHaveBeenCalledOnce();
    expect(addFn).toHaveBeenCalledWith("notify", baseJobData, {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
    });
  });
});

// ---------- buildSlackPayload ----------

describe("buildSlackPayload", () => {
  it("builds correct Block Kit payload", () => {
    const payload = buildSlackPayload(
      baseJobData,
      "https://app.test/approve",
      "https://app.test/reject",
    ) as { blocks: Array<{ type: string; elements?: Array<{ url?: string }> }> };

    expect(payload.blocks).toBeDefined();
    expect(payload.blocks.length).toBeGreaterThan(0);

    // Header block
    expect(payload.blocks[0].type).toBe("header");

    // Actions block with approve/reject buttons
    const actionsBlock = payload.blocks.find((b) => b.type === "actions");
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock!.elements).toHaveLength(2);
    expect(actionsBlock!.elements![0].url).toBe("https://app.test/approve");
    expect(actionsBlock!.elements![1].url).toBe("https://app.test/reject");
  });

  it("includes policy flags when present", () => {
    const payload = buildSlackPayload(baseJobData, "https://a", "https://r") as {
      blocks: Array<{ type: string; text?: { text: string } }>;
    };

    const policyBlock = payload.blocks.find(
      (b) => b.type === "section" && b.text?.text?.includes("Policy Flags"),
    );
    expect(policyBlock).toBeDefined();
    expect(policyBlock!.text!.text).toContain("regex-check");
  });

  it("includes guardrail flags when present", () => {
    const data = {
      ...baseJobData,
      guardrailFlags: [
        { guardrail_name: "toxicity", verdict: "flag", reasoning: "Borderline content" },
      ],
    };
    const payload = buildSlackPayload(data, "https://a", "https://r") as {
      blocks: Array<{ type: string; text?: { text: string } }>;
    };

    const guardrailBlock = payload.blocks.find(
      (b) => b.type === "section" && b.text?.text?.includes("Guardrail Flags"),
    );
    expect(guardrailBlock).toBeDefined();
    expect(guardrailBlock!.text!.text).toContain("toxicity");
  });

  it("omits policy section when no flags", () => {
    const data = { ...baseJobData, policyFlags: [] };
    const payload = buildSlackPayload(data, "https://a", "https://r") as {
      blocks: Array<{ type: string; text?: { text: string } }>;
    };

    const policyBlock = payload.blocks.find(
      (b) => b.type === "section" && b.text?.text?.includes("Policy Flags"),
    );
    expect(policyBlock).toBeUndefined();
  });
});

// ---------- buildEmailHtml ----------

describe("buildEmailHtml", () => {
  it("builds HTML with required elements", () => {
    const html = buildEmailHtml(baseJobData, "https://app.test/approve", "https://app.test/reject");

    expect(html).toContain("sub-1");
    expect(html).toContain("email");
    expect(html).toContain("text/plain");
    expect(html).toContain("This is test content");
    expect(html).toContain("https://app.test/approve");
    expect(html).toContain("https://app.test/reject");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
  });

  it("includes policy flags in HTML", () => {
    const html = buildEmailHtml(baseJobData, "https://a", "https://r");
    expect(html).toContain("Policy Flags");
    expect(html).toContain("regex-check");
  });

  it("escapes HTML in content preview", () => {
    const data = { ...baseJobData, contentPreview: '<script>alert("xss")</script>' };
    const html = buildEmailHtml(data, "https://a", "https://r");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ---------- processNotificationJob ----------

describe("processNotificationJob", () => {
  it("sends slack notification to configured channels", async () => {
    let slackBody: unknown = null;
    server.use(
      http.post("https://hooks.slack.com/services/test", async ({ request }) => {
        slackBody = await request.json();
        return HttpResponse.text("ok");
      }),
    );

    const prisma = {
      notificationChannel: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "ch-1",
            type: "slack",
            config: { webhook_url: "https://hooks.slack.com/services/test" },
            active: true,
          },
        ]),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as Parameters<typeof processNotificationJob>[0];

    await processNotificationJob(prisma, baseJobData, smtpConfig, "https://app.test");

    expect(slackBody).toBeDefined();
    expect((slackBody as { blocks: unknown[] }).blocks).toBeDefined();
  });

  it("skips when no active channels configured", async () => {
    const prisma = {
      notificationChannel: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as Parameters<typeof processNotificationJob>[0];

    // Should return without error
    await processNotificationJob(prisma, baseJobData, smtpConfig, "https://app.test");

    expect(prisma.notificationChannel.findMany).toHaveBeenCalledOnce();
  });

  it("continues on slack delivery failure (best-effort)", async () => {
    server.use(
      http.post("https://hooks.slack.com/services/fail", () =>
        HttpResponse.text("error", { status: 500 }),
      ),
    );

    const prisma = {
      notificationChannel: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "ch-1",
            type: "slack",
            config: { webhook_url: "https://hooks.slack.com/services/fail" },
            active: true,
          },
        ]),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as Parameters<typeof processNotificationJob>[0];

    // Should not throw
    await processNotificationJob(prisma, baseJobData, smtpConfig, "https://app.test");
  });

  it("skips email when SMTP not configured", async () => {
    const prisma = {
      notificationChannel: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "ch-2",
            type: "email",
            config: { recipients: ["reviewer@test.com"] },
            active: true,
          },
        ]),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as Parameters<typeof processNotificationJob>[0];

    // Should not throw — SMTP not configured is handled gracefully
    await processNotificationJob(prisma, baseJobData, smtpConfig, "https://app.test");
  });

  it("constructs correct action URLs from base URL", async () => {
    let receivedBody: { blocks: Array<{ elements?: Array<{ url: string }> }> } | null = null;
    server.use(
      http.post("https://hooks.slack.com/services/urls", async ({ request }) => {
        receivedBody = (await request.json()) as typeof receivedBody;
        return HttpResponse.text("ok");
      }),
    );

    const prisma = {
      notificationChannel: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "ch-1",
            type: "slack",
            config: { webhook_url: "https://hooks.slack.com/services/urls" },
            active: true,
          },
        ]),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as Parameters<typeof processNotificationJob>[0];

    await processNotificationJob(prisma, baseJobData, smtpConfig, "https://myapp.example.com");

    const actionsBlock = receivedBody!.blocks.find((b) => b.elements);
    expect(actionsBlock!.elements![0].url).toBe(
      "https://myapp.example.com/api/v1/review-actions/approve-token-123",
    );
    expect(actionsBlock!.elements![1].url).toBe(
      "https://myapp.example.com/api/v1/review-actions/reject-token-456",
    );
  });
});
