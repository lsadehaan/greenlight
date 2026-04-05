import type { PrismaClient } from "../generated/prisma/client.js";

export const POLICY_TYPES = [
  "regex",
  "keyword_blocklist",
  "content_length",
  "required_fields",
  "webhook",
] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

export interface PolicyResult {
  policyId: string;
  policyName: string;
  result: "pass" | "match";
  action: "block" | "flag" | "info";
  detail: string;
}

interface RegexConfig {
  pattern: string;
  flags?: string;
}

interface KeywordBlocklistConfig {
  keywords: string[];
}

interface ContentLengthConfig {
  min?: number;
  max?: number;
}

interface RequiredFieldsConfig {
  fields: string[];
}

interface WebhookConfig {
  url: string;
  timeout_ms?: number;
}

export function validatePolicyConfig(type: string, config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return "config must be a JSON object";
  }

  switch (type) {
    case "regex": {
      const c = config as Record<string, unknown>;
      if (typeof c.pattern !== "string" || c.pattern.length === 0) {
        return "regex config requires a non-empty 'pattern' string";
      }
      try {
        new RegExp(c.pattern, typeof c.flags === "string" ? c.flags : undefined);
      } catch {
        return "regex config has an invalid pattern";
      }
      return null;
    }
    case "keyword_blocklist": {
      const c = config as Record<string, unknown>;
      if (!Array.isArray(c.keywords) || c.keywords.length === 0) {
        return "keyword_blocklist config requires a non-empty 'keywords' array";
      }
      if (!c.keywords.every((k: unknown) => typeof k === "string")) {
        return "keyword_blocklist keywords must all be strings";
      }
      return null;
    }
    case "content_length": {
      const c = config as Record<string, unknown>;
      if (c.min === undefined && c.max === undefined) {
        return "content_length config requires at least 'min' or 'max'";
      }
      if (c.min !== undefined && (typeof c.min !== "number" || c.min < 0)) {
        return "content_length 'min' must be a non-negative number";
      }
      if (c.max !== undefined && (typeof c.max !== "number" || c.max < 0)) {
        return "content_length 'max' must be a non-negative number";
      }
      if (c.min !== undefined && c.max !== undefined && (c.min as number) > (c.max as number)) {
        return "content_length 'min' must be <= 'max'";
      }
      return null;
    }
    case "required_fields": {
      const c = config as Record<string, unknown>;
      if (!Array.isArray(c.fields) || c.fields.length === 0) {
        return "required_fields config requires a non-empty 'fields' array";
      }
      if (!c.fields.every((f: unknown) => typeof f === "string")) {
        return "required_fields fields must all be strings";
      }
      return null;
    }
    case "webhook": {
      const c = config as Record<string, unknown>;
      if (typeof c.url !== "string" || c.url.length === 0) {
        return "webhook config requires a non-empty 'url' string";
      }
      return null;
    }
    default:
      return `unknown policy type: ${type}`;
  }
}

function evaluateRegex(content: string, config: RegexConfig): { match: boolean; detail: string } {
  const re = new RegExp(config.pattern, config.flags);
  const matched = re.test(content);
  return {
    match: matched,
    detail: matched ? `Content matched pattern /${config.pattern}/` : "No match",
  };
}

function evaluateKeywordBlocklist(
  content: string,
  config: KeywordBlocklistConfig,
): { match: boolean; detail: string } {
  const lower = content.toLowerCase();
  const found = config.keywords.filter((kw) => lower.includes(kw.toLowerCase()));
  return {
    match: found.length > 0,
    detail:
      found.length > 0
        ? `Blocked keywords found: ${found.join(", ")}`
        : "No blocked keywords found",
  };
}

function evaluateContentLength(
  content: string,
  config: ContentLengthConfig,
): { match: boolean; detail: string } {
  const len = content.length;
  if (config.min !== undefined && len < config.min) {
    return { match: true, detail: `Content length ${len} is below minimum ${config.min}` };
  }
  if (config.max !== undefined && len > config.max) {
    return { match: true, detail: `Content length ${len} exceeds maximum ${config.max}` };
  }
  return { match: false, detail: `Content length ${len} is within bounds` };
}

function evaluateRequiredFields(
  metadata: Record<string, unknown>,
  config: RequiredFieldsConfig,
): { match: boolean; detail: string } {
  const missing = config.fields.filter((f) => !(f in metadata));
  return {
    match: missing.length > 0,
    detail:
      missing.length > 0
        ? `Missing required fields: ${missing.join(", ")}`
        : "All required fields present",
  };
}

async function evaluateWebhook(
  content: string,
  metadata: Record<string, unknown>,
  config: WebhookConfig,
): Promise<{ match: boolean; action_override?: "flag"; detail: string }> {
  const timeoutMs = config.timeout_ms ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, metadata }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return {
        match: true,
        action_override: "flag",
        detail: `Webhook returned status ${resp.status}`,
      };
    }

    const body = (await resp.json()) as { result?: string };
    if (body.result === "pass") {
      return { match: false, detail: "Webhook passed" };
    }
    if (body.result === "block") {
      return { match: true, detail: "Webhook blocked" };
    }
    // "flag" or any other value
    return {
      match: true,
      action_override: "flag",
      detail: `Webhook flagged: ${body.result ?? "unknown"}`,
    };
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : "Unknown error";
    return { match: true, action_override: "flag", detail: `Webhook error (flagging): ${message}` };
  }
}

export interface EvaluateInput {
  content: string;
  metadata: Record<string, unknown>;
  channel?: string | null;
  contentType?: string | null;
}

export async function evaluatePolicies(
  prisma: PrismaClient,
  input: EvaluateInput,
): Promise<PolicyResult[]> {
  const policies = await prisma.policy.findMany({
    where: { active: true },
    orderBy: { priority: "asc" },
  });

  const applicable = policies.filter((p) => {
    if (p.scopeChannel && p.scopeChannel !== input.channel) return false;
    if (p.scopeContentType && p.scopeContentType !== input.contentType) return false;
    return true;
  });

  const results: PolicyResult[] = [];

  for (const policy of applicable) {
    const config = policy.config as Record<string, unknown>;
    let evalResult: { match: boolean; action_override?: string; detail: string };

    switch (policy.type) {
      case "regex":
        evalResult = evaluateRegex(input.content, config as unknown as RegexConfig);
        break;
      case "keyword_blocklist":
        evalResult = evaluateKeywordBlocklist(
          input.content,
          config as unknown as KeywordBlocklistConfig,
        );
        break;
      case "content_length":
        evalResult = evaluateContentLength(input.content, config as unknown as ContentLengthConfig);
        break;
      case "required_fields":
        evalResult = evaluateRequiredFields(
          input.metadata,
          config as unknown as RequiredFieldsConfig,
        );
        break;
      case "webhook":
        evalResult = await evaluateWebhook(
          input.content,
          input.metadata,
          config as unknown as WebhookConfig,
        );
        break;
      default:
        evalResult = { match: false, detail: `Unknown policy type: ${policy.type}` };
    }

    const action = evalResult.action_override ?? policy.action;

    results.push({
      policyId: policy.id,
      policyName: policy.name,
      result: evalResult.match ? "match" : "pass",
      action: action as PolicyResult["action"],
      detail: evalResult.detail,
    });
  }

  return results;
}
