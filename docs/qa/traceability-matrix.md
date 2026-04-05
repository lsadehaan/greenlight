# Traceability Matrix -- Greenlight

> **Last updated:** 2026-04-05
> **Updated by:** planner (build authorization)

## Requirements Traceability

| ID | Requirement (from PRD) | Issue | PR | Test File:Line | Staging Evidence | Status |
|----|------------------------|-------|----|----------------|------------------|--------|
| REQ-001 | Submit content for approval via POST | #5 | -- | -- | -- | Planned |
| REQ-002 | Receive approval decisions via webhook | #7 | -- | -- | -- | Planned |
| REQ-003 | Configure policy rules via API | #4 | -- | -- | -- | Planned |
| REQ-004 | Query analytics API | #17 | -- | -- | -- | Planned |
| REQ-005 | Submit feedback on approved content | #8 | -- | -- | -- | Planned |
| REQ-006 | Authenticate with API keys | #3 | -- | -- | -- | Planned |
| REQ-007 | Receive approval requests via email/Slack | #13 | -- | -- | -- | Planned |
| REQ-008 | Approve/reject with optional comment | #6 | -- | -- | -- | Planned |
| REQ-009 | See pending submissions in web UI | #16 | -- | -- | -- | Planned |
| REQ-010 | Dashboard showing approval metrics | #17 | -- | -- | -- | Planned |
| REQ-011 | Immutable audit trail | #9 | -- | -- | -- | Planned |
| REQ-012 | Configure escalation rules | #14 | -- | -- | -- | Planned |
| REQ-013 | Configure AI-based review (modes, thresholds, verdicts) | #11, #15 | -- | -- | -- | Planned |
| REQ-014 | Register external AI guardrail services | #10 | -- | -- | -- | Planned |
| REQ-015 | Tiered evaluation pipeline (rules -> guardrails -> AI -> human) | #12 | -- | -- | -- | Planned |
| NFR-001 | Auto-approve latency < 200ms p95 | #5, #20 | -- | -- | -- | Planned |
| NFR-002 | API availability 99.5% | #20 | -- | -- | -- | Planned |
| NFR-003 | Analytics queries < 500ms on 100k rows | #17, #20 | -- | -- | -- | Planned |
| NFR-004 | Webhook delivery 99% with retries | #7, #20 | -- | -- | -- | Planned |
| NFR-005 | Docker image < 200MB | #1, #20 | -- | -- | -- | Planned |
| NFR-006 | Zero console errors in normal operation | #1, #20 | -- | -- | -- | Planned |
| NFR-007 | OpenAPI 3.0 spec auto-generated | #18 | -- | -- | -- | Planned |
| NFR-008 | Configurable data retention | #19 | -- | -- | -- | Planned |
| NFR-009 | Review UI usable at 375px | #16 | -- | -- | -- | Planned |
| NFR-010 | Startup time < 5s | #1, #20 | -- | -- | -- | Planned |
| NFR-011 | AI review latency < 5s p95 | #11, #20 | -- | -- | -- | Planned |
| NFR-012 | Guardrail adapter timeout configurable (default 10s, max 30s) | #10 | -- | -- | -- | Planned |
| NFR-013 | Full pipeline (rules + 2 guardrails + AI) < 15s p95 | #12, #20 | -- | -- | -- | Planned |

## Coverage Summary

- **Requirements defined:** 28 (15 functional + 13 non-functional)
- **Requirements with issues:** 28
- **Requirements with merged PRs:** 0
- **Requirements with passing tests:** 0
- **Requirements with passing staging evidence:** 0
- **Coverage:** 0% (0 / 28) -- all requirements have mapped issues, awaiting implementation

## Issue Dependency Graph

```
#1 Scaffolding (Ready)
  |
  +-- #2 Database schema
  |     |
  |     +-- #3 API key auth
  |     |     |
  |     |     +-- #4 Policy engine
  |     |     |     |
  |     |     |     +-- #5 Submission API
  |     |     |     |     |
  |     |     |     |     +-- #6 Review API
  |     |     |     |     |     |
  |     |     |     |     |     +-- #7 Webhook delivery
  |     |     |     |     |     +-- #13 Notifications
  |     |     |     |     |     |     |
  |     |     |     |     |     |     +-- #14 Escalation
  |     |     |     |     |     +-- #16 Review UI
  |     |     |     |     |
  |     |     |     |     +-- #8 Feedback API
  |     |     |     |
  |     |     |     +-- #12 Tiered pipeline (needs #4, #5, #6, #7, #9, #10, #11, #15)
  |     |     |
  |     |     +-- #9 Audit trail
  |     |     |     |
  |     |     |     +-- #10 Guardrail pipeline (needs #5, #9)
  |     |     |     |
  |     |     |     +-- #19 Data retention
  |     |     |
  |     |     +-- #15 Review config
  |     |     |     |
  |     |     |     +-- #11 AI review (needs #5, #6, #7, #9, #15)
  |     |     |
  |     |     +-- #17 Analytics (needs #5, #8, #9, #10, #11)
  |     |     +-- #18 OpenAPI spec (needs #4, #5, #6, #8, #9, #10, #15)
  |
  #20 E2E tests + perf validation (needs #1-#19)
```

## Gaps

| Requirement ID | Gap | Action |
|----------------|-----|--------|
| -- | All requirements have mapped issues | Awaiting implementation |

## Regression Notes

| PR | Features Potentially Affected | Regression Check | Result |
|----|------------------------------|-----------------|--------|
| -- | -- | -- | -- |
