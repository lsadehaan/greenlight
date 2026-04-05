# Product Requirements -- Greenlight

## Overview

Greenlight is an open-source approval and compliance proxy for outbound content. It sits between any system that produces content (AI agents, CRMs, marketing tools, custom apps) and the delivery channel (email, SMS, Slack, API), intercepting items for automated policy checks and optional human review before release. It stores every decision for analytics, audit, and feedback. Targeted at SMBs and developers who need a no-brainer way to add approval workflows without deploying enterprise orchestration.

## Goals

1. **Provide a universal approval checkpoint** -- any system can submit content for approval via a single REST API call, and receive an approved/rejected decision via sync response or async webhook.
2. **Enable pluggable policy rules** -- ship with built-in rules (regex, keyword blocklist, content length, required fields) and support custom policies via webhook.
3. **Store analytics and feedback data** -- track approval rates, rejection reasons, latency, reviewer behavior, and expose this via API and a minimal dashboard.
4. **Be trivially adoptable** -- a developer should be able to go from `npm install` to first approval request in under 10 minutes with zero configuration beyond a database connection string.

## Non-Goals (Explicit Out of Scope)

- **Not a workflow engine** -- Greenlight does not orchestrate multi-step business processes. It is a single approval checkpoint, not a BPMN engine.
- **Not an AI guardrails library** -- Greenlight does not validate LLM output structure or token usage. It works downstream of guardrails tools like NeMo or Guardrails AI.
- **Not a delivery channel** -- Greenlight does not send emails, SMS, or messages. It approves/rejects content and calls back the originating system.
- **Not a user management system** -- Greenlight uses API keys for authentication and supports webhook-based reviewer notification. It does not manage user accounts, roles, or SSO (v1).
- **Not a multi-tenant SaaS platform** -- v1 is single-tenant, self-hosted. Multi-tenancy is deferred.

## User Stories

### Persona 1: Developer (integrating Greenlight into their app)

- **REQ-001** As a developer, I want to submit content for approval via a single POST request so that I can add approval to my workflow without changing my architecture.
  - Acceptance criteria:
    - [ ] `POST /api/v1/submissions` accepts a JSON payload with content, metadata, channel, and callback URL
    - [ ] Returns a submission ID and status (approved/pending/rejected) synchronously
    - [ ] If policies auto-approve, response is immediate with status `approved`
    - [ ] If human review is needed, response is `pending` with estimated review time

- **REQ-002** As a developer, I want to receive approval decisions via webhook so that my system can proceed when content is approved without polling.
  - Acceptance criteria:
    - [ ] Greenlight sends a POST to the callback URL with the decision (approved/rejected), reviewer info, and timestamp
    - [ ] Webhook includes HMAC signature for verification
    - [ ] Failed webhook deliveries are retried with exponential backoff (3 attempts)

- **REQ-003** As a developer, I want to configure policy rules via API so that I can automate content checks without human involvement for low-risk items.
  - Acceptance criteria:
    - [ ] `POST /api/v1/policies` creates a new policy rule
    - [ ] Policy types include: regex match, keyword blocklist, content length bounds, required metadata fields, custom webhook
    - [ ] Policies can be scoped to specific channels or content types
    - [ ] Policies can be set to `block` (reject on match), `flag` (require human review on match), or `info` (log only)

- **REQ-004** As a developer, I want to query the analytics API so that I can build dashboards or feed approval data back into my AI systems.
  - Acceptance criteria:
    - [ ] `GET /api/v1/analytics/summary` returns approval rate, average review time, rejection reasons breakdown, volume over time
    - [ ] `GET /api/v1/analytics/submissions` returns paginated submission history with filters (status, channel, date range, policy triggered)
    - [ ] All analytics endpoints support date range filtering

- **REQ-005** As a developer, I want to submit feedback on approved content after delivery so that I can close the feedback loop (e.g., "this email got a complaint" or "this post performed well").
  - Acceptance criteria:
    - [ ] `POST /api/v1/submissions/:id/feedback` accepts outcome data (positive/negative/neutral + freetext reason)
    - [ ] Feedback is linked to the original submission and visible in analytics
    - [ ] Feedback aggregates are available in the analytics summary (e.g., "12% of approved items received negative feedback")

- **REQ-006** As a developer, I want to authenticate with API keys so that I can secure my integration without complex OAuth setup.
  - Acceptance criteria:
    - [ ] API keys are created via CLI command or API endpoint
    - [ ] Every API request requires a valid `Authorization: Bearer <key>` header
    - [ ] Invalid/missing keys return 401
    - [ ] API keys can be revoked

### Persona 2: Reviewer (approving/rejecting content)

- **REQ-007** As a reviewer, I want to receive approval requests via email or Slack so that I can review content where I already work.
  - Acceptance criteria:
    - [ ] Greenlight sends notification to configured channel (email via SMTP, Slack via webhook) when a submission needs human review
    - [ ] Notification includes content preview, metadata, policy flags, and approve/reject action links
    - [ ] Action links are single-use, time-limited tokens

- **REQ-008** As a reviewer, I want to approve or reject a submission with an optional comment so that the originating system knows why.
  - Acceptance criteria:
    - [ ] `POST /api/v1/submissions/:id/review` accepts decision (approved/rejected) and optional comment
    - [ ] Decision triggers the callback webhook to the originating system
    - [ ] Decision is recorded in the audit trail with reviewer identity and timestamp

- **REQ-009** As a reviewer, I want to see pending submissions in a minimal web UI so that I have a fallback when email/Slack is not configured.
  - Acceptance criteria:
    - [ ] Web UI at `/review` shows list of pending submissions with content preview
    - [ ] Each submission shows the policy results that triggered human review
    - [ ] Reviewer can approve/reject with one click + optional comment
    - [ ] UI is responsive and works on mobile (375px+)

### Persona 3: Operations/Compliance (monitoring and auditing)

- **REQ-010** As an operations lead, I want a dashboard showing approval metrics so that I can monitor team performance and compliance health.
  - Acceptance criteria:
    - [ ] Dashboard at `/dashboard` shows: approval rate, average review latency, submissions volume (24h/7d/30d), top rejection reasons, SLA compliance rate
    - [ ] Dashboard auto-refreshes every 30 seconds
    - [ ] Dashboard is read-only (no actions, just data)

- **REQ-011** As a compliance officer, I want an immutable audit trail of all approval decisions so that I can demonstrate compliance to auditors.
  - Acceptance criteria:
    - [ ] Every submission, policy evaluation, review decision, override, and feedback event is stored with timestamp, actor, and full payload
    - [ ] Audit entries cannot be modified or deleted via the API
    - [ ] `GET /api/v1/audit` returns paginated audit log with filters
    - [ ] Audit log supports export as JSON or CSV

- **REQ-012** As an operations lead, I want to configure escalation rules so that submissions not reviewed within an SLA are escalated.
  - Acceptance criteria:
    - [ ] Escalation config specifies: SLA duration (e.g., 30 minutes), escalation channel (email/Slack), escalation reviewer
    - [ ] If a submission is not reviewed within the SLA, Greenlight sends an escalation notification
    - [ ] If escalation is not acted on within a second SLA, the submission can be auto-approved or auto-rejected per config

## Non-Functional Requirements

| ID | Requirement | Target | How to Verify |
|----|-------------|--------|---------------|
| NFR-001 | Auto-approve latency | < 200ms p95 for policy-only path | Load test with k6: 100 concurrent submissions, measure p95 |
| NFR-002 | API availability | 99.5% uptime on staging | Monitor teammate health checks over 24h |
| NFR-003 | Database query performance | Analytics queries < 500ms on 100k submissions | Seed DB with 100k rows, time analytics endpoints |
| NFR-004 | Webhook delivery reliability | 99% delivery rate with 3 retries | Submit 1000 items with callback, verify delivery count |
| NFR-005 | Docker image size | < 200MB compressed | `docker image ls` after build |
| NFR-006 | Zero console errors | 0 errors in server logs during normal operation | Review logs after test suite run |
| NFR-007 | API documentation | OpenAPI 3.0 spec auto-generated | Verify /api/docs serves Swagger UI |
| NFR-008 | Data retention | Configurable retention period, default 90 days | Verify cleanup job removes old data per config |
| NFR-009 | Review UI mobile support | Usable at 375px | Playwright screenshot at 375px, verify no horizontal scroll |
| NFR-010 | Startup time | < 5s from container start to healthy | Time from `docker run` to `/health` returning 200 |

## Data Model

```mermaid
erDiagram
    API_KEY {
        uuid id PK
        string key_hash
        string name
        boolean active
        datetime created_at
        datetime revoked_at
    }
    SUBMISSION {
        uuid id PK
        uuid api_key_id FK
        string channel
        string content_type
        jsonb content
        jsonb metadata
        string status
        string callback_url
        string callback_status
        datetime created_at
        datetime decided_at
    }
    POLICY {
        uuid id PK
        string name
        string type
        jsonb config
        string action
        string scope_channel
        string scope_content_type
        integer priority
        boolean active
        datetime created_at
    }
    POLICY_EVALUATION {
        uuid id PK
        uuid submission_id FK
        uuid policy_id FK
        string result
        string action_taken
        jsonb details
        datetime evaluated_at
    }
    REVIEW {
        uuid id PK
        uuid submission_id FK
        string reviewer_identity
        string decision
        string comment
        datetime created_at
    }
    FEEDBACK {
        uuid id PK
        uuid submission_id FK
        string outcome
        string reason
        jsonb data
        datetime created_at
    }
    AUDIT_EVENT {
        uuid id PK
        uuid submission_id FK
        string event_type
        jsonb payload
        string actor
        datetime created_at
    }
    ESCALATION_CONFIG {
        uuid id PK
        integer sla_minutes
        string escalation_channel
        string escalation_target
        string timeout_action
        integer timeout_minutes
        boolean active
    }
    NOTIFICATION_CHANNEL {
        uuid id PK
        string type
        jsonb config
        boolean active
        datetime created_at
    }

    API_KEY ||--o{ SUBMISSION : "creates"
    SUBMISSION ||--o{ POLICY_EVALUATION : "evaluated by"
    SUBMISSION ||--o| REVIEW : "reviewed in"
    SUBMISSION ||--o{ FEEDBACK : "receives"
    SUBMISSION ||--o{ AUDIT_EVENT : "generates"
    POLICY ||--o{ POLICY_EVALUATION : "applied in"
```

## API Contracts

### POST /api/v1/submissions

- **Method:** POST
- **Path:** `/api/v1/submissions`
- **Auth:** Required (API key)
- **Request body:**
  ```json
  {
    "channel": "string -- delivery channel (email, slack, sms, custom)",
    "content_type": "string -- MIME-like type (text/plain, text/html, application/json)",
    "content": "object -- the content to approve (structure depends on content_type)",
    "metadata": "object -- arbitrary key-value pairs for context (optional)",
    "callback_url": "string -- URL to POST the decision to (optional, for async flow)",
    "priority": "string -- normal/high/urgent (optional, default: normal)"
  }
  ```
- **Success response (201):**
  ```json
  {
    "id": "uuid",
    "status": "approved | pending | rejected",
    "policy_results": [
      {"policy": "string", "result": "pass | flag | block", "details": "string"}
    ],
    "decided_at": "ISO8601 timestamp | null",
    "review_url": "string | null -- URL for human reviewer (if pending)",
    "estimated_review_time": "integer | null -- seconds (if pending)"
  }
  ```
- **Error responses:**
  - `400` -- Invalid payload (missing required fields, invalid channel)
  - `401` -- Missing or invalid API key
  - `422` -- Content fails validation (e.g., empty content)

### GET /api/v1/submissions/:id

- **Method:** GET
- **Path:** `/api/v1/submissions/:id`
- **Auth:** Required
- **Success response (200):**
  ```json
  {
    "id": "uuid",
    "channel": "string",
    "content_type": "string",
    "content": "object",
    "metadata": "object",
    "status": "approved | pending | rejected",
    "policy_results": [],
    "review": {"decision": "string", "comment": "string", "reviewer": "string", "created_at": "ISO8601"} | null,
    "feedback": [],
    "created_at": "ISO8601",
    "decided_at": "ISO8601 | null"
  }
  ```
- **Error responses:**
  - `401` -- Unauthorized
  - `404` -- Submission not found

### POST /api/v1/submissions/:id/review

- **Method:** POST
- **Path:** `/api/v1/submissions/:id/review`
- **Auth:** Required (review token or API key)
- **Request body:**
  ```json
  {
    "decision": "approved | rejected",
    "comment": "string (optional)"
  }
  ```
- **Success response (200):**
  ```json
  {
    "id": "uuid",
    "status": "approved | rejected",
    "review": {"decision": "string", "comment": "string", "reviewer": "string", "created_at": "ISO8601"}
  }
  ```
- **Error responses:**
  - `400` -- Invalid decision value
  - `401` -- Unauthorized
  - `404` -- Submission not found
  - `409` -- Submission already reviewed

### POST /api/v1/submissions/:id/feedback

- **Method:** POST
- **Path:** `/api/v1/submissions/:id/feedback`
- **Auth:** Required
- **Request body:**
  ```json
  {
    "outcome": "positive | negative | neutral",
    "reason": "string (optional)",
    "data": "object (optional -- arbitrary feedback data)"
  }
  ```
- **Success response (201):**
  ```json
  {
    "id": "uuid",
    "submission_id": "uuid",
    "outcome": "string",
    "created_at": "ISO8601"
  }
  ```
- **Error responses:**
  - `400` -- Invalid outcome value
  - `401` -- Unauthorized
  - `404` -- Submission not found

### CRUD /api/v1/policies

- **POST /api/v1/policies** -- Create a policy rule
- **GET /api/v1/policies** -- List all policies
- **GET /api/v1/policies/:id** -- Get a policy
- **PUT /api/v1/policies/:id** -- Update a policy
- **DELETE /api/v1/policies/:id** -- Deactivate a policy (soft delete)

Policy request body:
```json
{
  "name": "string",
  "type": "regex | keyword_blocklist | content_length | required_fields | webhook",
  "config": {
    "pattern": "string (for regex)",
    "keywords": ["string"] ,
    "min_length": "integer",
    "max_length": "integer",
    "fields": ["string"],
    "webhook_url": "string",
    "webhook_timeout_ms": "integer"
  },
  "action": "block | flag | info",
  "scope_channel": "string | null (null = all channels)",
  "scope_content_type": "string | null",
  "priority": "integer (lower = evaluated first)"
}
```

### GET /api/v1/analytics/summary

- **Method:** GET
- **Path:** `/api/v1/analytics/summary`
- **Auth:** Required
- **Query params:** `from` (ISO8601), `to` (ISO8601), `channel` (optional)
- **Success response (200):**
  ```json
  {
    "period": {"from": "ISO8601", "to": "ISO8601"},
    "total_submissions": "integer",
    "approved": "integer",
    "rejected": "integer",
    "pending": "integer",
    "approval_rate": "float (0-1)",
    "avg_review_time_seconds": "float",
    "median_review_time_seconds": "float",
    "top_rejection_reasons": [{"reason": "string", "count": "integer"}],
    "by_channel": {"channel_name": {"total": "int", "approved": "int", "rejected": "int"}},
    "feedback_summary": {"positive": "int", "negative": "int", "neutral": "int"},
    "sla_compliance_rate": "float (0-1)"
  }
  ```

### GET /api/v1/analytics/submissions

- **Method:** GET
- **Path:** `/api/v1/analytics/submissions`
- **Auth:** Required
- **Query params:** `status`, `channel`, `from`, `to`, `page`, `per_page`, `policy_triggered`
- **Success response (200):** Paginated list of submissions with summary fields

### GET /api/v1/audit

- **Method:** GET
- **Path:** `/api/v1/audit`
- **Auth:** Required
- **Query params:** `submission_id`, `event_type`, `from`, `to`, `page`, `per_page`, `format` (json|csv)
- **Success response (200):** Paginated audit log entries

### GET /health

- **Method:** GET
- **Path:** `/health`
- **Auth:** None
- **Success response (200):**
  ```json
  {
    "status": "healthy",
    "version": "string",
    "uptime_seconds": "integer",
    "db": "connected | disconnected",
    "redis": "connected | disconnected"
  }
  ```

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Webhook callback failures cause submissions to be stuck in "pending" forever | Medium | High | Implement retry with exponential backoff. Add TTL-based auto-escalation. Dashboard shows stuck submissions. |
| Policy evaluation webhook to external service is slow, blocking the sync response | Medium | Medium | Timeout external policy webhooks at 5s. Fall back to "flag for human review" on timeout. |
| Audit log grows unbounded and degrades DB performance | Medium | Medium | Configurable retention policy with automated cleanup. Partition audit table by month. |
| Reviewer notification fatigue leads to ignored approvals | Medium | High | SLA-based escalation. Priority levels. Auto-approve rules to reduce noise. Analytics on reviewer response times. |
| API key compromise allows unauthorized submissions | Low | High | Key rotation support. Rate limiting per key. Audit log of all key usage. IP allowlisting (v2). |

## Open Questions

- [ ] Should v1 support batch submissions (submit multiple items in one request)? -- deferred to v2 unless brief specifies
- [ ] Should the review UI support rich content preview (HTML rendering, image display)? -- yes for HTML, images deferred
- [ ] Should Greenlight support approval workflows with multiple reviewers (e.g., 2-of-3 must approve)? -- deferred to v2
