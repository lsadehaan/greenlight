# Knowledge Tree -- Greenlight

## Executive Research Summary

- No focused open-source "approval proxy" exists today -- the market has guardrails (NeMo, Guardrails AI) for AI output validation, workflow engines (n8n, Conductor) for orchestration, and SEGs for email filtering, but nothing that serves as a universal, pluggable approval checkpoint for any outbound content from any workflow.
- The "agent control plane" market (Forrester, Dec 2025) is emerging fast -- governance that sits outside the agent's execution loop is becoming a distinct product category, and Greenlight can claim the approval-and-analytics niche within it.
- SMBs need something radically simpler than enterprise workflow engines -- Camunda, ServiceNow, and Orkes are powerful but operationally heavy; the opportunity is a single-endpoint proxy that a developer can add in one API call.
- Analytics and feedback loops on approvals are an underserved differentiator -- existing tools either approve/reject or observe, but none close the loop by tracking approval latency, rejection reasons, override rates, and feeding that data back to upstream systems.
- TypeScript + PostgreSQL + Redis is the right stack for a self-hostable, low-ops approval service targeting developer adoption through npm.

## DOK 1-2: Facts and Sources

### Domain Overview

An "approval layer" sits between a system that produces outbound content (emails, messages, documents, AI-generated text, invoices, social posts, notifications) and the channel that delivers it. Its job is to intercept outbound items, route them through configurable approval rules (automatic policy checks, human review queues, or both), record the decision, and either release or block the item.

For SMBs, this is typically handled ad-hoc: a Slack message asking "can I send this?", a shared Google Doc for review, or nothing at all. As AI generates more outbound content on behalf of businesses, the gap between "AI produced this" and "a human approved this" becomes a compliance and reputational risk.

### Glossary

| Term | Definition |
|------|-----------|
| Approval Gate | A checkpoint where an item must receive explicit approval before proceeding |
| Policy Rule | An automated check (regex, word list, AI classifier, custom webhook) that can auto-approve or auto-reject |
| Escalation | Routing an item to a higher-authority reviewer when initial rules are inconclusive |
| Override | A human approving an item that a policy rule flagged for rejection |
| Approval Proxy | A service that sits in the request path between producer and delivery channel |
| Feedback Loop | Data flowing back from approval outcomes to the system that produced the content |
| Audit Trail | Immutable log of every approval decision, who made it, when, and why |
| SLA | Maximum time allowed for an approval decision before auto-escalation |

### Key Facts

| Fact | Source | Confidence |
|------|--------|-----------|
| Forrester defined "agent control plane" as a distinct market category in Dec 2025 | Authority Partners / Forrester reference | High |
| NeMo Guardrails is the leading OSS toolkit for LLM guardrails (12k+ GitHub stars) | github.com/NVIDIA-NeMo/Guardrails | High |
| Guardrails AI provides structural + content validation for LLM outputs | guardrailsai.com | High |
| HumanLayer SDK provides @require_approval decorator for agent tool calls | permit.io blog on HITL | High |
| Microsoft Agent Framework supports human-in-the-loop with approval queues | Microsoft Learn docs | High |
| n8n, Activepieces, and Conductor all support approval steps within their workflow engines | Various product docs | High |
| No standalone open-source "approval proxy" service exists on npm or PyPI as of April 2026 | Web search across npm, PyPI, GitHub | Medium |
| Enterprise SEGs (Proofpoint, Mimecast) handle outbound email compliance but are closed-source and expensive | Proofpoint, Cloudflare docs | High |
| Approveit offers API-driven approval workflows but is SaaS-only, not open-source | approveit.today | High |

### Technology Landscape

| Option | Pros | Cons | Recommendation |
|--------|------|------|---------------|
| NeMo Guardrails | Mature, Python, programmable rails | Focused on LLM conversations, not general outbound content | No -- wrong scope |
| Guardrails AI | Structural validation, validators hub | LLM-output-specific, no human review queue | No -- complementary, not competing |
| HumanLayer | Developer-friendly decorators, Slack/email integration | Agent-specific, not a standalone proxy service | No -- too narrow |
| n8n / Activepieces | Full workflow engine with approval steps | Overkill for a single approval checkpoint, heavy to self-host | No -- too heavy |
| Conductor (Orkes) | Microservice orchestration with human tasks | Enterprise complexity, Java ecosystem | No -- wrong target market |
| Custom build (TypeScript + Postgres + Redis) | Exactly our scope, lightweight, npm-publishable, self-hostable | Need to build from scratch | Yes -- fills the gap |

### Constraints

- Must be open-source (MIT or Apache 2.0) to drive adoption
- Must be self-hostable with minimal ops (single Docker container + Postgres)
- Must not require any specific AI provider -- works with AI outputs AND non-AI workflows
- Must have sub-second latency for auto-approved items (policy-only path)
- Must support webhook-based integration (no SDK lock-in)
- Must store all approval data for analytics and audit (GDPR-aware: support data retention policies)

## DOK 3: Insights and Analysis

### Cross-Referenced Insights

The market splits into three camps and none of them overlap with our target:

1. **AI guardrails** (NeMo, Guardrails AI, LLM Guard): These validate LLM outputs for safety, structure, and content policy. They operate synchronously inside the LLM call chain. They do not support human review, do not store analytics, and do not work with non-AI content.

2. **Workflow engines** (n8n, Conductor, Camunda): These orchestrate multi-step business processes with human approval nodes. They require you to move your entire workflow into their engine. An SMB that just wants to add an approval step before sending an email cannot justify deploying Conductor.

3. **Enterprise compliance** (Proofpoint, Mimecast, DLP tools): These are closed-source, expensive, email-specific, and targeted at large enterprises with dedicated security teams.

The gap is clear: a lightweight, open-source, channel-agnostic approval proxy that any developer can drop into any workflow with a single HTTP call. It should combine automated policy checks with optional human review, store everything for analytics, and provide a feedback API so upstream systems can learn from approval patterns.

### Competitive/Reference Analysis

| Reference | What They Do Well | What They Miss | Relevance |
|-----------|-------------------|---------------|-----------|
| Guardrails AI | Validator ecosystem, structural checks | No human review, no analytics, LLM-only | Can be used upstream of Greenlight |
| HumanLayer | Clean developer UX (@require_approval) | Agent-only, no policy engine, no analytics | Validates the decorator pattern |
| Approveit | API-driven approvals, webhook integration | SaaS-only, not open-source, no AI policy checks | Closest competitor in shape |
| Courier Template Approval | Content-specific approval with webhook model | Publishing-specific, no general content approval | Good UX reference |
| Permit.io | Fine-grained policy engine, OPAL/OPA | Authorization-focused, not content approval | Policy engine architecture reference |

### Tradeoffs

| Decision | Option A | Option B | Recommendation |
|----------|----------|----------|---------------|
| Sync vs async approval | Sync: caller blocks until approved (simpler) | Async: caller submits and polls/webhooks (scalable) | Both -- auto-approve path is sync, human review is async with webhook callback |
| Policy engine | Built-in rule engine (regex, keywords, thresholds) | Pluggable (webhook to external policy service) | Both -- built-in basics + webhook escape hatch for custom policies |
| Human review UI | Build a full review dashboard | Headless API + integrate with Slack/email/existing tools | Headless first -- provide API + Slack/email notifications, ship minimal web UI for standalone use |
| Storage | SQLite (simpler) | PostgreSQL (scalable, better analytics queries) | PostgreSQL -- analytics is a core feature, needs proper queries |
| Queue | In-process queue | Redis-backed queue | Redis -- approval SLAs need reliable delayed jobs for escalation |

## DOK 4: Spiky POVs

### "Approval-as-a-proxy" will become as standard as auth middleware

**Claim:** Within 2 years, every production workflow that sends outbound content will route through an approval proxy, just as every API today routes through auth middleware. AI-generated content accelerates this but non-AI content needs it too.
**Evidence for:** Increasing regulatory pressure on AI-generated content (EU AI Act, state-level US regulations). Reputational risk from AI hallucinations in customer-facing content. SMBs adopting AI tools faster than their compliance processes can keep up.
**Evidence against:** Most SMBs still operate without formal approval processes and may not feel the pain until an incident occurs. Friction in workflows reduces adoption.
**Our position:** The pain is real and growing. By making the approval path frictionless (auto-approve for low-risk, human review only when needed), we remove the adoption barrier. Position as risk reduction, not bureaucracy.

### Analytics on approval patterns is more valuable than the approval itself

**Claim:** The long-term value of Greenlight is not the approve/reject decision -- it is the data about what gets rejected, why, how long approvals take, which generators produce the most rejections, and how approval patterns change over time.
**Evidence for:** Enterprises pay heavily for DLP analytics. Product teams use approval rejection data to improve their AI prompts and templates. Compliance teams need audit trails with analytics for regulators.
**Evidence against:** SMBs may not have the sophistication to act on analytics. Risk of over-engineering the analytics before proving the core approval flow.
**Our position:** Ship analytics from day one but keep the interface simple. Dashboard with 5 key metrics. The data collection happens automatically; the insight layer can grow later. The audit trail is non-negotiable for compliance.

### The review UI should be "bring your own" -- not another dashboard

**Claim:** Developers will not adopt a tool that requires their team to learn a new dashboard. Approval notifications should go to Slack, email, or Teams -- wherever the reviewer already works. A built-in web UI is a secondary convenience, not the primary interface.
**Evidence for:** HumanLayer's success with Slack/email integration. n8n's approval nodes that notify via existing channels. Developer resistance to yet another SaaS dashboard.
**Evidence against:** A web UI provides better context (see the full item, compare with history, view policy results). Some teams prefer centralized review.
**Our position:** Ship headless-first with Slack and email notification channels. Provide a minimal web review UI for teams that want it, but do not make it required. The API is the product; the UI is a convenience.
