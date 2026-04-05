import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { validatePolicyConfig, evaluatePolicies } from "./policy.js";

// ---------- validatePolicyConfig ----------

describe("validatePolicyConfig", () => {
  it("rejects non-object config", () => {
    expect(validatePolicyConfig("regex", null)).toBe("config must be a JSON object");
    expect(validatePolicyConfig("regex", "string")).toBe("config must be a JSON object");
    expect(validatePolicyConfig("regex", [1])).toBe("config must be a JSON object");
  });

  describe("regex", () => {
    it("accepts valid regex config", () => {
      expect(validatePolicyConfig("regex", { pattern: "foo.*bar" })).toBeNull();
    });
    it("accepts regex with flags", () => {
      expect(validatePolicyConfig("regex", { pattern: "test", flags: "gi" })).toBeNull();
    });
    it("rejects missing pattern", () => {
      expect(validatePolicyConfig("regex", {})).toContain("pattern");
    });
    it("rejects invalid regex", () => {
      expect(validatePolicyConfig("regex", { pattern: "[invalid" })).toContain("invalid pattern");
    });
  });

  describe("keyword_blocklist", () => {
    it("accepts valid config", () => {
      expect(validatePolicyConfig("keyword_blocklist", { keywords: ["spam"] })).toBeNull();
    });
    it("rejects empty keywords", () => {
      expect(validatePolicyConfig("keyword_blocklist", { keywords: [] })).toContain("non-empty");
    });
    it("rejects non-string keywords", () => {
      expect(validatePolicyConfig("keyword_blocklist", { keywords: [123] })).toContain("strings");
    });
  });

  describe("content_length", () => {
    it("accepts min only", () => {
      expect(validatePolicyConfig("content_length", { min: 10 })).toBeNull();
    });
    it("accepts max only", () => {
      expect(validatePolicyConfig("content_length", { max: 1000 })).toBeNull();
    });
    it("accepts min and max", () => {
      expect(validatePolicyConfig("content_length", { min: 10, max: 1000 })).toBeNull();
    });
    it("rejects neither min nor max", () => {
      expect(validatePolicyConfig("content_length", {})).toContain("at least");
    });
    it("rejects min > max", () => {
      expect(validatePolicyConfig("content_length", { min: 100, max: 10 })).toContain("<=");
    });
  });

  describe("required_fields", () => {
    it("accepts valid config", () => {
      expect(validatePolicyConfig("required_fields", { fields: ["title"] })).toBeNull();
    });
    it("rejects empty fields", () => {
      expect(validatePolicyConfig("required_fields", { fields: [] })).toContain("non-empty");
    });
  });

  describe("webhook", () => {
    it("accepts valid config", () => {
      expect(validatePolicyConfig("webhook", { url: "https://example.com/hook" })).toBeNull();
    });
    it("rejects missing url", () => {
      expect(validatePolicyConfig("webhook", {})).toContain("url");
    });
  });

  it("rejects unknown type", () => {
    expect(validatePolicyConfig("unknown_type", {})).toContain("unknown policy type");
  });
});

// ---------- evaluatePolicies ----------

function mockPrisma(policies: Record<string, unknown>[]) {
  return {
    policy: {
      findMany: vi.fn().mockResolvedValue(policies),
    },
  } as unknown as Parameters<typeof evaluatePolicies>[0];
}

describe("evaluatePolicies", () => {
  describe("regex", () => {
    it("matches content against pattern", async () => {
      const prisma = mockPrisma([
        {
          id: "1",
          name: "no-urls",
          type: "regex",
          config: { pattern: "https?://" },
          action: "block",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, {
        content: "visit https://evil.com",
        metadata: {},
      });
      expect(results).toHaveLength(1);
      expect(results[0].result).toBe("match");
      expect(results[0].action).toBe("block");
    });

    it("passes when no match", async () => {
      const prisma = mockPrisma([
        {
          id: "1",
          name: "no-urls",
          type: "regex",
          config: { pattern: "https?://" },
          action: "block",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, { content: "clean text", metadata: {} });
      expect(results[0].result).toBe("pass");
    });
  });

  describe("keyword_blocklist", () => {
    it("flags content with blocked keywords (case-insensitive)", async () => {
      const prisma = mockPrisma([
        {
          id: "1",
          name: "profanity",
          type: "keyword_blocklist",
          config: { keywords: ["spam", "scam"] },
          action: "flag",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, {
        content: "This is SPAM content",
        metadata: {},
      });
      expect(results[0].result).toBe("match");
      expect(results[0].action).toBe("flag");
      expect(results[0].detail).toContain("spam");
    });

    it("passes clean content", async () => {
      const prisma = mockPrisma([
        {
          id: "1",
          name: "profanity",
          type: "keyword_blocklist",
          config: { keywords: ["spam"] },
          action: "flag",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, { content: "Normal text", metadata: {} });
      expect(results[0].result).toBe("pass");
    });
  });

  describe("content_length", () => {
    it("flags content below minimum", async () => {
      const prisma = mockPrisma([
        {
          id: "1",
          name: "min-length",
          type: "content_length",
          config: { min: 50 },
          action: "block",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, { content: "short", metadata: {} });
      expect(results[0].result).toBe("match");
      expect(results[0].detail).toContain("below minimum");
    });

    it("flags content above maximum", async () => {
      const prisma = mockPrisma([
        {
          id: "1",
          name: "max-length",
          type: "content_length",
          config: { max: 5 },
          action: "block",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, { content: "too long text", metadata: {} });
      expect(results[0].result).toBe("match");
      expect(results[0].detail).toContain("exceeds maximum");
    });

    it("passes content within bounds", async () => {
      const prisma = mockPrisma([
        {
          id: "1",
          name: "length",
          type: "content_length",
          config: { min: 1, max: 100 },
          action: "block",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, { content: "just right", metadata: {} });
      expect(results[0].result).toBe("pass");
    });
  });

  describe("required_fields", () => {
    it("flags missing metadata fields", async () => {
      const prisma = mockPrisma([
        {
          id: "1",
          name: "req-fields",
          type: "required_fields",
          config: { fields: ["title", "author"] },
          action: "flag",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, {
        content: "text",
        metadata: { title: "hi" },
      });
      expect(results[0].result).toBe("match");
      expect(results[0].detail).toContain("author");
    });

    it("passes when all fields present", async () => {
      const prisma = mockPrisma([
        {
          id: "1",
          name: "req-fields",
          type: "required_fields",
          config: { fields: ["title"] },
          action: "flag",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, {
        content: "text",
        metadata: { title: "hi" },
      });
      expect(results[0].result).toBe("pass");
    });
  });

  describe("scope filtering", () => {
    it("skips policies scoped to a different channel", async () => {
      const prisma = mockPrisma([
        {
          id: "1",
          name: "ch-only",
          type: "regex",
          config: { pattern: ".*" },
          action: "block",
          priority: 0,
          active: true,
          scopeChannel: "blog",
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, {
        content: "anything",
        metadata: {},
        channel: "forum",
      });
      expect(results).toHaveLength(0);
    });

    it("applies policies scoped to matching channel", async () => {
      const prisma = mockPrisma([
        {
          id: "1",
          name: "ch-only",
          type: "regex",
          config: { pattern: ".*" },
          action: "block",
          priority: 0,
          active: true,
          scopeChannel: "blog",
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, {
        content: "anything",
        metadata: {},
        channel: "blog",
      });
      expect(results).toHaveLength(1);
    });

    it("skips policies scoped to a different content type", async () => {
      const prisma = mockPrisma([
        {
          id: "1",
          name: "ct-only",
          type: "regex",
          config: { pattern: ".*" },
          action: "block",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: "image",
        },
      ]);
      const results = await evaluatePolicies(prisma, {
        content: "text",
        metadata: {},
        contentType: "text",
      });
      expect(results).toHaveLength(0);
    });
  });

  describe("priority ordering", () => {
    it("evaluates policies in priority order", async () => {
      const prisma = mockPrisma([
        {
          id: "2",
          name: "second",
          type: "regex",
          config: { pattern: "x" },
          action: "info",
          priority: 10,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
        {
          id: "1",
          name: "first",
          type: "regex",
          config: { pattern: "x" },
          action: "block",
          priority: 1,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, { content: "x", metadata: {} });
      expect(results[0].policyName).toBe("second");
      expect(results[1].policyName).toBe("first");
    });
  });

  describe("webhook", () => {
    const server = setupServer();
    beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
    afterAll(() => server.close());

    it("passes when webhook returns pass", async () => {
      server.use(http.post("https://hook.test/check", () => HttpResponse.json({ result: "pass" })));
      const prisma = mockPrisma([
        {
          id: "1",
          name: "hook",
          type: "webhook",
          config: { url: "https://hook.test/check" },
          action: "block",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, { content: "text", metadata: {} });
      expect(results[0].result).toBe("pass");
    });

    it("blocks when webhook returns block", async () => {
      server.use(
        http.post("https://hook.test/block", () => HttpResponse.json({ result: "block" })),
      );
      const prisma = mockPrisma([
        {
          id: "1",
          name: "hook",
          type: "webhook",
          config: { url: "https://hook.test/block" },
          action: "info",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, { content: "text", metadata: {} });
      expect(results[0].result).toBe("match");
      expect(results[0].detail).toBe("Webhook blocked");
    });

    it("flags on webhook timeout", async () => {
      server.use(
        http.post("https://hook.test/slow", async () => {
          await new Promise((r) => setTimeout(r, 10000));
          return HttpResponse.json({ result: "pass" });
        }),
      );
      const prisma = mockPrisma([
        {
          id: "1",
          name: "hook",
          type: "webhook",
          config: { url: "https://hook.test/slow", timeout_ms: 50 },
          action: "block",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, { content: "text", metadata: {} });
      expect(results[0].result).toBe("match");
      expect(results[0].action).toBe("flag");
      expect(results[0].detail).toContain("error");
    });

    it("flags on non-ok webhook response", async () => {
      server.use(
        http.post("https://hook.test/error", () => new HttpResponse(null, { status: 500 })),
      );
      const prisma = mockPrisma([
        {
          id: "1",
          name: "hook",
          type: "webhook",
          config: { url: "https://hook.test/error" },
          action: "block",
          priority: 0,
          active: true,
          scopeChannel: null,
          scopeContentType: null,
        },
      ]);
      const results = await evaluatePolicies(prisma, { content: "text", metadata: {} });
      expect(results[0].result).toBe("match");
      expect(results[0].action).toBe("flag");
    });
  });
});
