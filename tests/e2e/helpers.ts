/** E2E test helpers — HTTP client for testing against a live Greenlight server */

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  apiKey?: string;
}

interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };
  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await res.json() : await res.text();
  return { status: res.status, body: body as T, headers: res.headers };
}

/** Create an API key and return the raw key for auth */
export async function createApiKey(existingKey: string, name: string): Promise<string> {
  const res = await api<{ key: string }>("/api/v1/api-keys", {
    method: "POST",
    apiKey: existingKey,
    body: { name },
  });
  if (res.status !== 201) {
    throw new Error(`Failed to create API key: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.key;
}

/** Submit content and return the submission */
export async function submitContent(
  apiKey: string,
  content: { channel: string; content_type: string; content: unknown; metadata?: unknown; callback_url?: string },
): Promise<{ id: string; status: string }> {
  const res = await api<{ id: string; status: string }>("/api/v1/submissions", {
    method: "POST",
    apiKey,
    body: content,
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Failed to submit: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** Poll a submission until it reaches a terminal status or timeout */
export async function waitForDecision(
  apiKey: string,
  submissionId: string,
  timeoutMs = 30000,
  pollIntervalMs = 500,
): Promise<{ status: string; decided_by: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api<{ status: string; decided_by: string | null }>(
      `/api/v1/submissions/${submissionId}`,
      { apiKey },
    );
    if (res.status === 200 && res.body.status !== "pending") {
      return res.body;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Submission ${submissionId} did not reach terminal status within ${timeoutMs}ms`);
}

export function isE2EEnabled(): boolean {
  return !!process.env.E2E_BASE_URL;
}
