const UUID_EXAMPLE = "00000000-0000-0000-0000-000000000001";

const ErrorResponse = {
  type: "object",
  properties: {
    error: { type: "string" },
    message: { type: "string" },
  },
};

const bearerAuth = {
  type: "http",
  scheme: "bearer",
  description: "API key issued via POST /api/v1/api-keys",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const openapiSpec: Record<string, any> = {
  openapi: "3.0.3",
  info: {
    title: "Greenlight API",
    version: "0.1.0",
    description: "Open-source AI Approval and Compliance Layer for SMBs. Greenlight provides a tiered evaluation pipeline (rules → guardrails → AI → human) for content submissions with full audit trail.",
  },
  servers: [{ url: "/", description: "Current server" }],
  components: {
    securitySchemes: { BearerAuth: bearerAuth },
    schemas: {
      Error: ErrorResponse,
      Submission: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid", example: UUID_EXAMPLE },
          channel: { type: "string", example: "email" },
          content_type: { type: "string", example: "text/plain" },
          content: { description: "Submission content (any JSON value)" },
          metadata: { type: "object", nullable: true },
          status: { type: "string", enum: ["pending", "approved", "rejected"] },
          review_mode: { type: "string", enum: ["human_only", "ai_only", "ai_then_human"], nullable: true },
          callback_url: { type: "string", nullable: true },
          decided_at: { type: "string", format: "date-time", nullable: true },
          decided_by: { type: "string", nullable: true },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Review: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          submission_id: { type: "string", format: "uuid" },
          reviewer_type: { type: "string", enum: ["human", "ai"] },
          reviewer_identity: { type: "string", nullable: true },
          decision: { type: "string", enum: ["approved", "rejected", "escalated"] },
          comment: { type: "string", nullable: true },
          confidence: { type: "number", nullable: true },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Policy: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string", example: "profanity-filter" },
          type: { type: "string", example: "keyword" },
          config: { type: "object" },
          action: { type: "string", enum: ["block", "flag", "info"] },
          scope_channel: { type: "string", nullable: true },
          scope_content_type: { type: "string", nullable: true },
          priority: { type: "integer", default: 0 },
          active: { type: "boolean" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Guardrail: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string", example: "toxicity-detector" },
          endpoint_url: { type: "string", example: "https://guardrail.example.com/check" },
          timeout_ms: { type: "integer", default: 10000 },
          failure_mode: { type: "string", enum: ["fail_open", "fail_closed"] },
          pipeline_order: { type: "integer" },
          scope_channel: { type: "string", nullable: true },
          scope_content_type: { type: "string", nullable: true },
          active: { type: "boolean" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      ReviewConfig: {
        type: "object",
        properties: {
          default_review_mode: { type: "string", enum: ["human_only", "ai_only", "ai_then_human"] },
          ai_confidence_threshold: { type: "number", minimum: 0, maximum: 1, example: 0.8 },
          ai_reviewer_endpoint: { type: "string", nullable: true },
          ai_reviewer_timeout_ms: { type: "integer", example: 10000 },
          ai_reviewer_model: { type: "string", nullable: true },
          guardrail_pipeline_enabled: { type: "boolean" },
          tiers_enabled: {
            type: "object",
            properties: {
              rules: { type: "boolean" },
              guardrails: { type: "boolean" },
              ai_review: { type: "boolean" },
              human_review: { type: "boolean" },
            },
          },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      EscalationConfig: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          sla_minutes: { type: "integer", example: 60 },
          escalation_channel: { type: "string", example: "slack" },
          escalation_target: { type: "string", example: "#reviews" },
          timeout_action: { type: "string", enum: ["auto_approve", "auto_reject"] },
          timeout_minutes: { type: "integer", example: 30 },
          active: { type: "boolean" },
        },
      },
      NotificationChannel: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          type: { type: "string", enum: ["slack", "email"] },
          config: { type: "object" },
          active: { type: "boolean" },
        },
      },
      AnalyticsSummary: {
        type: "object",
        properties: {
          total_submissions: { type: "integer" },
          approved: { type: "integer" },
          rejected: { type: "integer" },
          pending: { type: "integer" },
          approval_rate: { type: "number" },
          avg_review_time_seconds: { type: "number" },
          median_review_time_seconds: { type: "number" },
          sla_compliance_rate: { type: "number" },
          top_rejection_reasons: { type: "array", items: { type: "object", properties: { reason: { type: "string" }, count: { type: "integer" } } } },
          by_channel: { type: "object", additionalProperties: { type: "object", properties: { total: { type: "integer" }, approved: { type: "integer" }, rejected: { type: "integer" }, pending: { type: "integer" } } } },
          feedback_summary: { type: "object", properties: { total: { type: "integer" }, positive: { type: "integer" }, negative: { type: "integer" }, neutral: { type: "integer" } } },
          review_tier_funnel: { type: "object" },
          ai_review_stats: { type: "object" },
          guardrail_stats: { type: "object" },
        },
      },
    },
  },
  security: [{ BearerAuth: [] }],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        security: [],
        responses: { "200": { description: "Service healthy", content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" }, database: { type: "string" }, redis: { type: "string" } } } } } } },
      },
    },
    "/api/v1/api-keys": {
      post: {
        tags: ["API Keys"],
        summary: "Create an API key",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string", example: "my-app" } } } } } },
        responses: {
          "201": { description: "API key created", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, key: { type: "string", description: "Plaintext key (shown once)" } } } } } },
          "400": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      get: {
        tags: ["API Keys"],
        summary: "List API keys",
        responses: { "200": { description: "List of API keys", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { type: "object" } } } } } } } },
      },
    },
    "/api/v1/api-keys/{id}": {
      delete: {
        tags: ["API Keys"],
        summary: "Revoke an API key",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Key revoked" },
          "404": { description: "Key not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/v1/submissions": {
      post: {
        tags: ["Submissions"],
        summary: "Create a submission",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["channel", "content_type", "content"], properties: { channel: { type: "string", example: "email" }, content_type: { type: "string", example: "text/plain" }, content: { description: "Content to review" }, metadata: { type: "object" }, callback_url: { type: "string" } } } } },
        },
        responses: {
          "201": { description: "Submission created", content: { "application/json": { schema: { $ref: "#/components/schemas/Submission" } } } },
          "400": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      get: {
        tags: ["Submissions"],
        summary: "List submissions",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["pending", "approved", "rejected"] } },
          { name: "channel", in: "query", schema: { type: "string" } },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "Paginated submissions", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Submission" } }, total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" } } } } } } },
      },
    },
    "/api/v1/submissions/{id}": {
      get: {
        tags: ["Submissions"],
        summary: "Get submission detail",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Submission detail with evaluations and reviews", content: { "application/json": { schema: { $ref: "#/components/schemas/Submission" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/v1/submissions/{id}/review": {
      post: {
        tags: ["Reviews"],
        summary: "Submit a review decision",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["decision"], properties: { decision: { type: "string", enum: ["approved", "rejected", "escalated"] }, reviewer_type: { type: "string", enum: ["human", "ai"], default: "human" }, comment: { type: "string" }, confidence: { type: "number" }, reasoning: { type: "string" } } } } },
        },
        responses: {
          "201": { description: "Review created", content: { "application/json": { schema: { $ref: "#/components/schemas/Review" } } } },
          "400": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Submission not found" },
          "409": { description: "Review already exists for this reviewer type" },
        },
      },
    },
    "/api/v1/submissions/{id}/review-tokens": {
      post: {
        tags: ["Reviews"],
        summary: "Generate single-use review action tokens",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "201": { description: "Tokens generated", content: { "application/json": { schema: { type: "object", properties: { approve_token: { type: "string" }, reject_token: { type: "string" }, expires_at: { type: "string", format: "date-time" } } } } } } },
      },
    },
    "/api/v1/review-actions/{token}": {
      post: {
        tags: ["Reviews"],
        summary: "Execute a review action via token (no auth required)",
        security: [],
        parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Action executed" },
          "400": { description: "Invalid or expired token" },
        },
      },
    },
    "/api/v1/submissions/{id}/feedback": {
      post: {
        tags: ["Feedback"],
        summary: "Submit feedback on a submission",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["outcome"], properties: { outcome: { type: "string", enum: ["positive", "negative", "neutral"] }, reason: { type: "string" }, data: { type: "object" } } } } } },
        responses: { "201": { description: "Feedback recorded" }, "404": { description: "Submission not found" } },
      },
      get: {
        tags: ["Feedback"],
        summary: "Get feedback for a submission",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Feedback list" } },
      },
    },
    "/api/v1/policies": {
      post: {
        tags: ["Policies"],
        summary: "Create a policy",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name", "type", "config", "action"], properties: { name: { type: "string" }, type: { type: "string" }, config: { type: "object" }, action: { type: "string", enum: ["block", "flag", "info"] }, scope_channel: { type: "string" }, scope_content_type: { type: "string" }, priority: { type: "integer" }, active: { type: "boolean" } } } } } },
        responses: { "201": { description: "Policy created", content: { "application/json": { schema: { $ref: "#/components/schemas/Policy" } } } }, "400": { description: "Validation error" } },
      },
      get: {
        tags: ["Policies"],
        summary: "List policies",
        responses: { "200": { description: "List of policies" } },
      },
    },
    "/api/v1/policies/{id}": {
      get: { tags: ["Policies"], summary: "Get policy by ID", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Policy detail" }, "404": { description: "Not found" } } },
      put: { tags: ["Policies"], summary: "Update a policy", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, type: { type: "string" }, config: { type: "object" }, action: { type: "string", enum: ["block", "flag", "info"] }, scope_channel: { type: "string" }, scope_content_type: { type: "string" }, priority: { type: "integer" }, active: { type: "boolean" } } } } } }, responses: { "200": { description: "Policy updated" }, "404": { description: "Not found" } } },
      delete: { tags: ["Policies"], summary: "Delete a policy", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Policy deleted" }, "404": { description: "Not found" } } },
    },
    "/api/v1/guardrails": {
      post: { tags: ["Guardrails"], summary: "Create a guardrail", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name", "endpoint_url", "failure_mode", "pipeline_order"], properties: { name: { type: "string" }, endpoint_url: { type: "string" }, timeout_ms: { type: "integer", default: 10000 }, failure_mode: { type: "string", enum: ["fail_open", "fail_closed"] }, pipeline_order: { type: "integer" }, scope_channel: { type: "string" }, scope_content_type: { type: "string" }, active: { type: "boolean" } } } } } }, responses: { "201": { description: "Guardrail created" }, "400": { description: "Validation error" } } },
      get: { tags: ["Guardrails"], summary: "List guardrails", responses: { "200": { description: "List of guardrails" } } },
    },
    "/api/v1/guardrails/{id}": {
      get: { tags: ["Guardrails"], summary: "Get guardrail by ID", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Guardrail detail" }, "404": { description: "Not found" } } },
      put: { tags: ["Guardrails"], summary: "Update a guardrail", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, endpoint_url: { type: "string" }, timeout_ms: { type: "integer" }, failure_mode: { type: "string", enum: ["fail_open", "fail_closed"] }, pipeline_order: { type: "integer" }, scope_channel: { type: "string" }, scope_content_type: { type: "string" } } } } } }, responses: { "200": { description: "Guardrail updated" }, "404": { description: "Not found" } } },
      delete: { tags: ["Guardrails"], summary: "Delete a guardrail", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Guardrail deleted" }, "404": { description: "Not found" } } },
    },
    "/api/v1/review-config": {
      get: { tags: ["Review Config"], summary: "Get review pipeline configuration", responses: { "200": { description: "Current config", content: { "application/json": { schema: { $ref: "#/components/schemas/ReviewConfig" } } } } } },
      put: {
        tags: ["Review Config"],
        summary: "Update review pipeline configuration",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { default_review_mode: { type: "string", enum: ["human_only", "ai_only", "ai_then_human"] }, ai_confidence_threshold: { type: "number", minimum: 0, maximum: 1 }, ai_reviewer_endpoint: { type: "string" }, ai_reviewer_timeout_ms: { type: "integer" }, ai_reviewer_model: { type: "string" }, guardrail_pipeline_enabled: { type: "boolean" }, tiers_enabled: { type: "object" } } } } } },
        responses: { "200": { description: "Config updated", content: { "application/json": { schema: { $ref: "#/components/schemas/ReviewConfig" } } } }, "400": { description: "Validation error" } },
      },
    },
    "/api/v1/escalation-config": {
      post: { tags: ["Escalation Config"], summary: "Create an escalation config", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["sla_minutes", "escalation_channel", "escalation_target", "timeout_action", "timeout_minutes"], properties: { sla_minutes: { type: "integer" }, escalation_channel: { type: "string" }, escalation_target: { type: "string" }, timeout_action: { type: "string", enum: ["auto_approve", "auto_reject"] }, timeout_minutes: { type: "integer" } } } } } }, responses: { "201": { description: "Config created", content: { "application/json": { schema: { $ref: "#/components/schemas/EscalationConfig" } } } } } },
      get: { tags: ["Escalation Config"], summary: "List escalation configs", responses: { "200": { description: "List of configs" } } },
    },
    "/api/v1/escalation-config/{id}": {
      put: { tags: ["Escalation Config"], summary: "Update an escalation config", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Config updated" }, "404": { description: "Not found" } } },
    },
    "/api/v1/notification-channels": {
      post: { tags: ["Notification Channels"], summary: "Create a notification channel", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["type", "config"], properties: { type: { type: "string", enum: ["slack", "email"] }, config: { type: "object" } } } } } }, responses: { "201": { description: "Channel created" }, "400": { description: "Validation error" } } },
      get: { tags: ["Notification Channels"], summary: "List notification channels", responses: { "200": { description: "List of channels" } } },
    },
    "/api/v1/notification-channels/{id}": {
      put: { tags: ["Notification Channels"], summary: "Update a notification channel", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Channel updated" }, "404": { description: "Not found" } } },
      delete: { tags: ["Notification Channels"], summary: "Delete a notification channel", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Channel deleted" }, "404": { description: "Not found" } } },
    },
    "/api/v1/audit": {
      get: {
        tags: ["Audit"],
        summary: "Query audit events",
        parameters: [
          { name: "submission_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "event_type", in: "query", schema: { type: "string" } },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "Audit events" } },
      },
    },
    "/api/v1/analytics/summary": {
      get: {
        tags: ["Analytics"],
        summary: "Get analytics summary",
        parameters: [
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "channel", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Analytics summary", content: { "application/json": { schema: { $ref: "#/components/schemas/AnalyticsSummary" } } } } },
      },
    },
    "/api/v1/analytics/submissions": {
      get: {
        tags: ["Analytics"],
        summary: "Paginated submission history",
        parameters: [
          { name: "status", in: "query", schema: { type: "string" } },
          { name: "channel", in: "query", schema: { type: "string" } },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "per_page", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "policy_triggered", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Paginated submissions" } },
      },
    },
  },
  tags: [
    { name: "Health", description: "Service health checks" },
    { name: "API Keys", description: "API key management" },
    { name: "Submissions", description: "Content submission and review pipeline" },
    { name: "Reviews", description: "Review decisions and action tokens" },
    { name: "Feedback", description: "Post-review feedback" },
    { name: "Policies", description: "Rule-based policy management" },
    { name: "Guardrails", description: "AI guardrail configuration" },
    { name: "Review Config", description: "Review pipeline configuration" },
    { name: "Escalation Config", description: "SLA and escalation rules" },
    { name: "Notification Channels", description: "Notification channel management" },
    { name: "Audit", description: "Audit trail" },
    { name: "Analytics", description: "Analytics and metrics" },
  ],
};
