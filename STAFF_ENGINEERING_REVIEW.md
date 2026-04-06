# Staff Engineering Review - Personal Assistant

Date: 2026-04-05
Scope: `compose.stacks/infra/personal-assistant/` plus relevant planning/history in `_tasks/`

Note: file references and line numbers are point-in-time and reflect the tree reviewed on this date.

## Executive Summary

This stack is already a strong V1 invoice/document automation system. It is not yet a broad "personal assistant," and that is okay. The important V2 architectural ideas from `_tasks/_done/11-personal-assistant-v2/` are mostly already in place: durable jobs, explicit approval state, deterministic side effects, and Claude limited to classification and user interaction rather than transaction execution.

The main V2 gap is now simplification, boundary hardening, and product focus - not another rewrite.

My staff-level recommendation is:

1. Treat the current invoice domain as the platform to harden, not as a temporary prototype.
2. Do a focused simplification pass before adding new domains.
3. Make the accountant workflow the next feature on top of the existing job system.
4. Defer vehicle logbook / attendance / broader assistant ambitions until the current system is easier to change.

## 1. What The System Is Today

### Product scope

Based on `docs/USE_CASES.md` and the codebase, the implemented scope is:

| Area | Status | Notes |
|---|---|---|
| Email invoice intake -> Paperless | Implemented | Gmail, Outlook, attachment and link flows |
| Google Drive scan intake -> Paperless | Implemented | Shared worker path with scan-specific download and post-move |
| Workflow durability / approvals / retries | Implemented | SQLite job ledger, classification parking, retryable state |
| Observability | Implemented | Prometheus scrape + OTLP + Grafana |
| Invoice matching / P&L | Implemented | Separate `checker-mcp` bounded context |
| Accountant ZIP/email workflow | Not implemented | Still planned only |
| Month-end auto-check scheduler | Not implemented | No scheduler/cron workflow yet |
| Vehicle logbook / attendance / cross-app workflows | Not implemented | Still roadmap only |

### Architecture summary

The runtime architecture is sound and clear:

- `email-watcher.ts` and `gdrive-watcher.ts` poll external sources, write audit state, and create jobs directly in `workflow.db` (`claude-code/channels/email-watcher.ts:393`, `claude-code/channels/gdrive-watcher.ts:406`).
- `workflow-mcp.ts` owns job CRUD, health, and the single worker loop (`claude-code/channels/workflow-mcp.ts:62`, `claude-code/channels/workflow-mcp.ts:379`).
- `invoice-worker.ts` executes deterministic side effects for both `invoice_intake` and `scan_intake` (`claude-code/channels/invoice-worker.ts:177`, `claude-code/channels/invoice-worker.ts:1132`).
- Claude is only asked to classify email or document content through channel events and then submit structured results back into the workflow (`claude-code/channels/workflow-db.ts:371`, `claude-code/channels/workflow-db.ts:393`).
- `checker-mcp` is a separate domain service for matching and P&L, exposed both as MCP and as a web UI (`checker-mcp/server.py:61`, `checker-mcp/webapp.py:35`).

That is the right shape for this problem.

## 2. Design Evolution From `_tasks/`

The task history tells a coherent story:

- The original design in `_tasks/_done/10-personal-assistant/02-design.md` was broader and more agent-centric: many domains, more channel-driven orchestration, more ambition than boundary clarity.
- The v2 planning docs in `_tasks/_done/11-personal-assistant-v2/01-overview.md` and `_tasks/_done/11-personal-assistant-v2/02-architecture.md` correctly reframed Claude as control plane / reasoning layer and deterministic services as transaction engines.
- `_tasks/_done/36-invoice-link-pipeline/02-architecture.md` explicitly identified a key failure mode: using `CLAUDE.md` prose as the real orchestrator is fundamentally brittle.
- `_tasks/_TECH_DEBT/04-watcher-direct-job-creation.md` was resolved in the right direction by removing Claude from the job-creation critical path.

Current code matches the corrected v2 direction much more than the original broad March vision.

That means the next step should not be "invent a new architecture." The next step is to finish the architecture that already exists.

## 3. What Is Strong And Should Stay

### 3.1 Deterministic worker, Claude as classifier

This is the most important design choice in the stack. The worker owns download, dedup, tagging, upload, and notification. Claude only handles classification and user-facing approval/chat flows.

Evidence:

- `docs/architecture.md:79`
- `claude-code/channels/invoice-worker.ts:177`
- `claude-code/channels/invoice-worker.ts:1132`

Why this is good:

- predictable behavior
- much better testability
- fewer context-window failure modes
- better restart semantics

### 3.2 Durable job ledger and step-level resume

The `jobs` + `job_events` model is simple and effective. Classification steps park the job, the worker resumes from completed step data, and retries do not rerun the entire flow.

Evidence:

- `claude-code/channels/workflow-db.ts:52`
- `claude-code/channels/workflow-db.ts:371`
- `claude-code/channels/workflow-db.ts:393`
- `claude-code/channels/invoice-pipeline.ts:135`

This is real platform value and should be preserved.

### 3.3 Watchers create jobs directly

Moving watcher -> job creation out of Claude was exactly the right simplification. It removes pointless LLM hops and makes ingestion deterministic.

Evidence:

- `claude-code/channels/email-watcher.ts:417`
- `claude-code/channels/gdrive-watcher.ts:444`
- `_tasks/_TECH_DEBT/04-watcher-direct-job-creation.md:16`

### 3.4 Testing and observability are stronger than typical homelab automation

This is not a fragile hobby script anymore. The stack has:

- Bun unit/integration tests for channels and workflow
- pytest E2E coverage for critical paths
- Prometheus + OTLP instrumentation
- health endpoints and stale-job reclamation

Evidence:

- `docs/development.md`
- `tests/README.md`
- `claude-code/channels/workflow-core.ts:173`
- `claude-code/channels/email-watcher.ts:167`

### 3.5 Security posture is pragmatic and thoughtful

The permission model is intentionally narrow. File operations are sandboxed through `file-ops` instead of broad shell access.

Evidence:

- `claude-code/.claude/settings.json:2`
- `claude-code/channels/file-ops.ts:3`
- `claude-code/CLAUDE.md:5`

### 3.6 `checker-mcp` is a good bounded context

Keeping matching and P&L outside the intake worker is correct. It is a separate domain with its own rules, failure modes, and UI needs.

Evidence:

- `checker-mcp/server.py:23`
- `checker-mcp/match_invoices.py:598`
- `checker-mcp/match_invoices.py:958`

## 4. Main Technical Debt And Architectural Pressure Points

### 4.1 `invoice-worker.ts` is the main monolith

`invoice-worker.ts` now carries too many responsibilities:

- workflow orchestration
- classification parking/resume
- email and scan branching
- multiple download strategies
- Paperless correspondence/tag/type/storage logic
- duplicate detection
- custom-field post-processing
- GDrive move logic
- notification handling

Evidence:

- `claude-code/channels/invoice-worker.ts:177`
- `claude-code/channels/invoice-worker.ts:511`
- `claude-code/channels/invoice-worker.ts:769`
- `claude-code/channels/invoice-worker.ts:813`
- `claude-code/channels/invoice-worker.ts:1033`
- `claude-code/channels/invoice-worker.ts:1132`
- `claude-code/channels/invoice-worker.ts:1462`
- `claude-code/channels/invoice-worker.ts:1581`

This file is the clearest signal that the architecture needs simplification, not expansion.

### 4.2 Paperless integration boundary is inconsistent

The stack currently uses Paperless in two different ways:

- via MCP for correspondents, tags, and some lookup operations
- via direct HTTP for dedup search, storage paths, upload, task polling, and PATCHing custom fields

Evidence:

- MCP path: `claude-code/channels/invoice-worker.ts:778`, `claude-code/channels/invoice-worker.ts:905`, `claude-code/channels/invoice-worker.ts:937`
- direct HTTP path: `claude-code/channels/invoice-worker.ts:843`, `claude-code/channels/invoice-worker.ts:993`, `claude-code/channels/invoice-worker.ts:1105`, `claude-code/channels/invoice-worker.ts:1488`, `claude-code/channels/invoice-worker.ts:1532`

The direct API calls are understandable - they work around real MCP limitations - but the current boundary is blurry. That makes behavior harder to reason about and harder to reuse.

### 4.3 Watchers duplicate each other structurally

`email-watcher.ts` and `gdrive-watcher.ts` share the same shape:

- config/env parsing
- metrics server
- health check / stale poll logic
- MCP client lifecycle
- poll loop
- dedup against local DB
- create workflow job
- trace job creation

Evidence:

- `claude-code/channels/email-watcher.ts:94`
- `claude-code/channels/email-watcher.ts:167`
- `claude-code/channels/email-watcher.ts:393`
- `claude-code/channels/email-watcher.ts:454`
- `claude-code/channels/gdrive-watcher.ts:104`
- `claude-code/channels/gdrive-watcher.ts:231`
- `claude-code/channels/gdrive-watcher.ts:362`
- `claude-code/channels/gdrive-watcher.ts:406`

The duplication is not catastrophic today, but it will slow every future change.

### 4.4 Workflow contracts are weakly typed at the boundary that matters most

The workflow system stores arbitrary JSON and then casts it back into expected shapes later. That is flexible, but it means the most important cross-process contract - classification result shape - is only weakly enforced.

Evidence:

- `claude-code/channels/workflow-db.ts:358`
- `claude-code/channels/workflow-db.ts:393`
- `claude-code/channels/invoice-worker.ts:233`
- `claude-code/channels/invoice-worker.ts:325`

This is a good place for explicit schema validation.

### 4.5 `checker-mcp` core is strong but too monolithic

The matching engine is valuable and clearly battle-tested, but `collect_month()` and `collect_pl()` are too large and mix data fetch, business logic, and rendering-friendly shaping.

Evidence:

- `checker-mcp/match_invoices.py:598`
- `checker-mcp/match_invoices.py:958`
- `checker-mcp/webapp.py:35`
- `checker-mcp/webapp.py:141`
- `checker-mcp/webapp.py:238`

This is not urgent platform risk, but it is the main maintainability risk on the matching side.

### 4.6 Documentation drift is now operational debt

Several docs no longer describe the current system accurately.

Examples:

- `docs/uc1-invoice-processing.md:123` still documents `update_email_status`, but `emails.db` no longer has workflow status fields (`claude-code/channels/db.ts:35`).
- `docs/uc1-invoice-processing.md:184` and `docs/uc1-invoice-processing.md:191` still describe upload via `post_document`, but current code uploads directly to the Paperless API (`claude-code/channels/invoice-worker.ts:1033`).
- `docs/uc1-invoice-processing.md:111` says the worker deletes the local file after upload, but no such cleanup exists in current worker code.
- `docs/uc1-invoice-processing.md:197` describes scan tags as path-segment driven (`techlab/invoicing`, `techlab/documents`), but current scan code uses `buildTagNames()` with only the level-1 owner plus doc-type-driven tags (`claude-code/channels/invoice-worker.ts:1276`, `claude-code/channels/invoice-pipeline.ts:84`).
- `docs/uc1a-observability.md:93`, `docs/uc1a-observability.md:114`, and `docs/observability.md:31` still reference dead metrics such as `email_watcher_actions_total` and `email_watcher_confidence_total`, while current metrics come from `email-watcher.ts:94`.
- `tests/README.md:64` still says tests poll SQLite until email reaches a target status, but status was removed from the email DB schema (`claude-code/channels/db.ts:35`).

This matters because the project depends heavily on docs for operation and for coding-agent behavior.

### 4.7 Operational rough edges and likely correctness bugs

There are a few small but important correctness / operations issues worth fixing immediately:

- Local downloads still accumulate; this is already called out in `_tasks/_TECH_DEBT/02-download-directory-cleanup.md:7`.
- Gmail MCP behavior is patched at runtime with `sed` in `docker-compose.yml:160`, which is brittle and hard to reason about.
- `workflow-mcp` naming/transport is confusing: `.mcp.json` configures it as stdio (`claude-code/.mcp.json:19`), `workflow-mcp.ts` also opens an HTTP health endpoint (`claude-code/channels/workflow-mcp.ts:390`), and `CHANGELOG.md:16` says it was converted to HTTP.
- There appears to be a real bug in scan download sizing: `downloadFromGdrive()` returns `size: fileBuffer.length`, but `fileBuffer` is not defined in that scope (`claude-code/channels/invoice-worker.ts:1451`).
- There also appears to be an Outlook attachment bug in multi-attachment cases: the returned size uses `parsed.size` instead of `dlParsed.size` (`claude-code/channels/invoice-worker.ts:594`).

## 5. Recommended V2 Simplifications

### Priority 0 - Harden the current system first

#### 5.1 Fix correctness and contract gaps

Do this before any bigger refactor:

- fix the two likely download bugs in `invoice-worker.ts`
- add schema validation for `submit_classification()` inputs/results
- add regression tests around those exact cases
- make the docs match the real upload/tagging/status model

Suggested implementation:

- validate `classify_email` and `classify_document` payloads in `workflow-db.ts` before writing `step_completed`
- keep the event ledger generic, but make the boundary strict

#### 5.2 Implement a real local-download lifecycle

Right now downloaded files are useful for resume, but they are not cleaned up after success or terminal failure.

Recommendation:

- keep downloaded files during active retries and approvals
- delete them after `completed`, `failed`, or `cancelled`
- add a periodic safety cleanup for old leftovers as a backup, not as the primary mechanism

This aligns with `_tasks/_TECH_DEBT/02-download-directory-cleanup.md:22`.

#### 5.3 Refresh and simplify docs that are too precise to stay correct

The most drifted docs (`docs/uc1-invoice-processing.md`, `docs/uc1a-observability.md`, `docs/observability.md`, `tests/README.md`) should be simplified where necessary instead of keeping brittle step-by-step descriptions that go stale quickly.

## Priority 1 - Simplify code boundaries

#### 5.4 Split `invoice-worker.ts` into explicit modules

I would not keep growing this file. I would split it into service-level modules while keeping the same job model.

Suggested target structure:

```text
claude-code/channels/
  workflow/
    workflow-mcp.ts
    workflow-db.ts
    workflow-core.ts
    workflow-types.ts
  intake/
    email-watcher.ts
    gdrive-watcher.ts
    watcher-base.ts
  invoice/
    intake-worker.ts
    classification.ts
    download-service.ts
    paperless-service.ts
    dedup-service.ts
    gdrive-service.ts
    policy.ts
    invoice-pipeline.ts
  common/
    mcp-client.ts
    tracing.ts
```

Concretely:

- keep orchestration in `executeInvoiceIntake()` / `executeScanIntake()`
- move download logic out of the worker
- move all Paperless interactions into one service
- move approval reason building into small dedicated helpers

#### 5.5 Create a single Paperless adapter

Add one local module that owns all Paperless behavior for the intake pipeline.

The point is not to force everything through MCP. The point is to make the boundary explicit.

One adapter should own:

- correspondent lookup/create
- tag lookup/create
- document type / storage path resolution
- duplicate lookup
- upload
- task polling
- custom-field patching

That gives you one place to test, one place to trace, and one place to swap MCP vs direct HTTP behavior when needed.

#### 5.6 Extract shared watcher infrastructure

Create a small `watcher-base.ts` or a couple of shared helpers for:

- health and metrics server bootstrapping
- poll loop timing / stale detection
- trace-linked job creation
- MCP client reset/reconnect patterns

Do not over-abstract. Just remove repeated operational scaffolding.

#### 5.7 Rename confusing files and concepts

The names should match what the code actually does.

Examples:

- `invoice-worker.ts` handles invoice and scan intake; either split it or rename it.
- `workflow-mcp.ts` is a stdio MCP server with an HTTP health side server; document this clearly or rename it to reflect that dual role.
- The product name in docs should stay close to current scope: AI document/invoice assistant first, broader personal assistant later.

## Priority 2 - Productize the current domain before adding new domains

#### 5.8 Make the accountant workflow the next feature on the same job system

The right next step is not vehicle logbook or attendance. The right next step is to complete the partially planned invoice/accountant domain:

- monthly matching package
- ZIP export
- draft email
- explicit approval before send
- optional scheduling later

Why this is the right next move:

- same data domain
- same users
- same systems of record
- directly exercises the workflow model in a more complete way

It is the cleanest way to validate that the job platform can support a second real workflow without introducing a new business domain.

#### 5.9 Refactor `checker-mcp` into engine + adapters

Keep the matching algorithm. Do not rewrite the domain logic casually.

But split it into:

```text
checker-mcp/
  engine/
    models.py
    parsing.py
    matching.py
    pairing.py
    pl.py
  server.py
  webapp.py
```

This will make it much easier to:

- add structured result models
- test the engine without the web UI
- expose a richer MCP surface later

### Priority 3 - Only then widen scope

Do not add UC-3 / UC-4 / UC-5 until the invoice/accountant path is boring to maintain.

The v2 planning docs were right to insist on stable execution boundaries before expanding domains. That advice still holds.

## 6. What I Would Not Do Yet

### 6.1 Do not replace Claude Code with Agent SDK yet

The current architecture already removed Claude from the most dangerous execution paths. There is no evidence yet that the system needs a new agent runtime.

### 6.2 Do not add parallel workers yet

The single-worker model is still the right trade-off at this scale.

Evidence:

- `claude-code/channels/workflow-mcp.ts:59`
- `docs/architecture.md:117`

Parallelism would add locking, race conditions, and more complex failure handling before the codebase is ready for it.

### 6.3 Do not expand to new domains before finishing the invoice platform

The broad March vision is still attractive, but the system is not yet simple enough for safe expansion.

### 6.4 Do not move more business rules into prompts

The history in `_tasks/_done/36-invoice-link-pipeline/02-architecture.md` is clear: logic encoded in prose is not a stable orchestrator.

## 7. Suggested Roadmap

### Phase 0 - Hardening (small, immediate)

- fix the likely download bugs
- validate classification schemas
- implement download cleanup
- clean stale docs
- add tests for these exact changes

### Phase 1 - Simplification (one refactor sprint)

- split `invoice-worker.ts` into smaller modules
- add one explicit Paperless adapter
- extract shared watcher scaffolding
- rename confusing files / modules

### Phase 2 - Complete the current product slice

- implement accountant package workflow on top of existing jobs
- keep explicit approval state for send behavior
- add structured outputs from matching for easier UI / Claude explanation

### Phase 3 - Re-evaluate expansion

Only after the above:

- decide whether UC-3 / UC-4 still fit this repository
- define systems of record before adding write paths
- choose whether new domains belong as first-class workflow types or separate bounded contexts

## 8. Concrete Follow-Up List

| Priority | Item | Why |
|---|---|---|
| P0 | Fix `downloadFromGdrive()` size bug in `claude-code/channels/invoice-worker.ts:1451` | likely correctness bug |
| P0 | Fix Outlook attachment size bug in `claude-code/channels/invoice-worker.ts:594` | likely correctness bug |
| P0 | Validate classification payloads in `claude-code/channels/workflow-db.ts:393` | tighten workflow boundary |
| P0 | Implement download cleanup from `_tasks/_TECH_DEBT/02-download-directory-cleanup.md` | prevent long-term operational mess |
| P0 | Refresh `docs/uc1-invoice-processing.md` and observability docs | reduce operator / agent confusion |
| P1 | Extract `paperless-service.ts` from `invoice-worker.ts` | unify one core boundary |
| P1 | Extract `watcher-base.ts` shared logic | reduce duplicate ingestion scaffolding |
| P1 | Split `checker-mcp/match_invoices.py` into smaller engine modules | improve maintainability without rewriting logic |
| P2 | Implement accountant package workflow using the existing job model | best next product milestone |
| P3 | Reassess new domains after the above is stable | avoid premature scope expansion |

## Closing View

This is a good codebase with a clear direction. The foundational architecture choices are stronger than the name of the project currently suggests. The stack has already crossed the line from prototype into maintainable system design for the invoice/document domain.

That is exactly why the next move should be disciplined simplification.

Do less, but do it more cleanly:

- finish the current workflow platform
- complete the accountant path
- tighten the boundaries
- then expand

That path gives the project the best chance of becoming a real long-lived automation platform instead of a smart but fragile pile of special cases.
