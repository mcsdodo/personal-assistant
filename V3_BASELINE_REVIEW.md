# Personal Assistant - V3 Baseline Review

Date: 2026-04-06
Scope: `compose.stacks/infra/personal-assistant/`

This document treats the current implementation as the baseline for V3.

Historical task docs in `_tasks/`, including older V2 planning, are useful design history only. They are not the target state for this review. The source of truth here is the current code, current docs, and current runtime shape.

## 1. Baseline Summary

The project is already a capable invoice/document automation platform with four real pillars:

1. intake from Gmail, Outlook, and Google Drive
2. deterministic workflow execution with durable state
3. Paperless filing with metadata enrichment and duplicate control
4. statement matching / P&L via a separate checker service

The implemented product is narrower than the repository name suggests. It is not yet a general "personal assistant." It is currently a specialized AI-assisted document operations system.

That is the right baseline for V3.

The V3 opportunity is not to reinvent the system. It is to:

- simplify the code structure
- harden integration boundaries
- reduce operational ambiguity
- complete the accountant-facing workflow on top of the existing platform
- make future expansion possible without another architectural reset

## 2. Current Product Baseline

### Implemented use cases

Current implemented scope from `docs/USE_CASES.md`:

- Gmail invoice intake (`docs/USE_CASES.md:34`)
- Outlook invoice intake (`docs/USE_CASES.md:35`)
- classification and upload to Paperless (`docs/USE_CASES.md:36`, `docs/USE_CASES.md:37`)
- Telegram notification / approval flows (`docs/USE_CASES.md:38`, `docs/USE_CASES.md:39`)
- Google Drive scan ingestion (`docs/USE_CASES.md:41`)
- invoice matching and P&L summary (`docs/USE_CASES.md:62`, `docs/USE_CASES.md:63`, `docs/USE_CASES.md:68`)

### Not implemented yet

Still explicitly not implemented:

- accountant ZIP generation (`docs/USE_CASES.md:64`)
- accountant draft email (`docs/USE_CASES.md:65`)
- send-after-approval flow (`docs/USE_CASES.md:66`)
- month-end scheduled run (`docs/USE_CASES.md:67`)

### Product interpretation

`README.md` currently describes the project as an AI document assistant that:

- picks up invoices from Gmail, Outlook, and Google Drive (`README.md:7`)
- matches bank statement movements (`README.md:11`)
- exposes observability and workflow health (`README.md:12`)

That is accurate.

For V3 planning, the most useful framing is:

"AI-assisted document intake and accounting support for self-hosted Paperless workflows."

That framing is clearer than "personal assistant," and it matches what the system actually does.

## 3. Current Architecture Baseline

### Runtime model

The system currently has a sound runtime split:

- `email-watcher.ts` polls Gmail and Outlook, writes audit data, and creates workflow jobs directly (`claude-code/channels/email-watcher.ts:393`)
- `gdrive-watcher.ts` polls Drive folders, writes audit data, and creates workflow jobs directly (`claude-code/channels/gdrive-watcher.ts:406`)
- `workflow-mcp.ts` exposes job tools and runs the worker loop (`claude-code/channels/workflow-mcp.ts:62`, `claude-code/channels/workflow-mcp.ts:379`)
- `invoice-worker.ts` executes deterministic side effects for both `invoice_intake` and `scan_intake` (`claude-code/channels/invoice-worker.ts:177`, `claude-code/channels/invoice-worker.ts:1132`)
- `checker-mcp` is a separate bounded context for matching and P&L (`checker-mcp/server.py:61`, `checker-mcp/match_invoices.py:598`, `checker-mcp/match_invoices.py:958`)

### State model

The current state model is simple and good:

- email audit DB: `claude-code/channels/db.ts:35`
- workflow DB with `jobs` and `job_events`: `claude-code/channels/workflow-db.ts:52`
- GDrive audit DB: `claude-code/channels/gdrive-db.ts`
- downloaded file workspace: mounted from `docker-compose.yml:34`

Workflow behavior is durable because classification and execution progress are recorded in `job_events`, and retries resume from completed steps (`claude-code/channels/workflow-db.ts:371`, `claude-code/channels/workflow-db.ts:393`, `claude-code/channels/invoice-pipeline.ts:135`).

### Claude's current role

Claude is not the transaction engine. Claude is currently used for:

- email classification
- document classification
- approval interaction
- operator-facing conversation

Deterministic code owns download, dedup, upload, tagging, custom fields, and post-processing. That is one of the strongest decisions in the system and should remain a V3 invariant.

### Operational model

The worker is intentionally single-threaded (`claude-code/channels/workflow-mcp.ts:59`).

At current scale, that is reasonable. V3 should not start by parallelizing workers. V3 should start by making the single-worker model easier to understand and change.

## 4. What V3 Should Preserve

These are the baseline architectural choices worth keeping.

### 4.1 Deterministic side effects

Keep external writes in code, not in prompts.

Evidence:

- `docs/architecture.md:79`
- `claude-code/channels/invoice-worker.ts:177`

Why preserve it:

- reproducibility
- testability
- safe retries
- better failure handling

### 4.2 Watchers create jobs directly

This already removed Claude from the critical ingestion path.

Evidence:

- `claude-code/channels/email-watcher.ts:417`
- `claude-code/channels/gdrive-watcher.ts:444`

V3 should build on this, not backslide into more agent-mediated orchestration.

### 4.3 Job/event ledger with step resume

This is the current platform core.

Evidence:

- `claude-code/channels/workflow-db.ts:52`
- `claude-code/channels/workflow-db.ts:131`
- `claude-code/channels/workflow-db.ts:371`
- `claude-code/channels/workflow-db.ts:393`

V3 should strengthen this with better schemas and clearer payload contracts, not replace it.

### 4.4 Security model around tool permissions and local file access

The allowlist-based Claude tool model and the dedicated file sandbox are good patterns.

Evidence:

- `claude-code/.claude/settings.json:2`
- `claude-code/channels/file-ops.ts:1`

V3 should preserve the security posture while making the boundaries easier to reason about.

### 4.5 Separate checker bounded context

Matching and P&L should remain separate from intake orchestration.

Evidence:

- `checker-mcp/server.py:23`
- `checker-mcp/webapp.py:35`

V3 should improve this boundary, not collapse it back into the intake worker.

## 5. Main Constraints In The Current Baseline

### 5.1 The invoice worker is doing too much

`invoice-worker.ts` is the biggest V3 constraint.

It currently mixes:

- orchestration
- classification parking/resume
- email and scan branching
- download strategy execution
- Paperless integration details
- duplicate detection
- custom field task polling
- GDrive post-move behavior
- notification behavior

Evidence:

- `claude-code/channels/invoice-worker.ts:177`
- `claude-code/channels/invoice-worker.ts:511`
- `claude-code/channels/invoice-worker.ts:769`
- `claude-code/channels/invoice-worker.ts:813`
- `claude-code/channels/invoice-worker.ts:1033`
- `claude-code/channels/invoice-worker.ts:1462`
- `claude-code/channels/invoice-worker.ts:1581`

V3 should treat this file as the primary decomposition target.

### 5.2 Paperless boundary is functionally correct but architecturally blurry

The system currently uses Paperless through both MCP and direct HTTP.

Current split:

- MCP for correspondents, tags, document types (`claude-code/channels/invoice-worker.ts:778`, `claude-code/channels/invoice-worker.ts:905`, `claude-code/channels/invoice-worker.ts:937`)
- direct HTTP for dedup search, storage path lookup, upload, task polling, and custom field PATCHing (`claude-code/channels/invoice-worker.ts:843`, `claude-code/channels/invoice-worker.ts:993`, `claude-code/channels/invoice-worker.ts:1105`, `claude-code/channels/invoice-worker.ts:1488`, `claude-code/channels/invoice-worker.ts:1532`)

This is understandable because of real MCP limitations, but the current shape makes it hard to explain where Paperless behavior actually lives.

V3 should unify this behind one explicit adapter boundary.

### 5.3 Watcher infrastructure is duplicated

The email and Drive watchers repeat the same operational pattern:

- env/config parsing
- startup delay
- health server
- OTel gauges
- remote MCP client lifecycle
- dedup against audit DB
- workflow job creation

Evidence:

- `claude-code/channels/email-watcher.ts:93`
- `claude-code/channels/email-watcher.ts:156`
- `claude-code/channels/email-watcher.ts:227`
- `claude-code/channels/email-watcher.ts:393`
- `claude-code/channels/gdrive-watcher.ts:88`
- `claude-code/channels/gdrive-watcher.ts:103`
- `claude-code/channels/gdrive-watcher.ts:133`
- `claude-code/channels/gdrive-watcher.ts:406`

V3 should reduce repeated infrastructure without over-abstracting the domain logic.

### 5.4 The workflow contracts are not strict enough

`submitClassification()` stores arbitrary JSON and later the worker casts it back into expected types.

Evidence:

- `claude-code/channels/workflow-db.ts:393`
- `claude-code/channels/invoice-worker.ts:233`
- `claude-code/channels/invoice-worker.ts:325`

This is the single most important place to add stronger contracts in V3.

V3 should introduce explicit schemas for:

- `invoice_intake` input
- `scan_intake` input
- email classification result
- document classification result
- step result payloads
- final workflow output payloads

### 5.5 Documentation is no longer aligned to the actual system

There is meaningful drift between current code and detailed docs.

Examples:

- `docs/uc1-invoice-processing.md:123` still documents `update_email_status`, but the current email DB schema has no workflow status columns (`claude-code/channels/db.ts:35`)
- `docs/uc1-invoice-processing.md:184` still describes upload through `post_document`, but upload is direct HTTP in current worker code (`claude-code/channels/invoice-worker.ts:1033`)
- `docs/uc1-invoice-processing.md:111` says the worker deletes local files after upload, but that cleanup is not currently implemented
- `docs/uc1a-observability.md:93` and `docs/observability.md:31` still reference old watcher metrics that no longer exist in current instrumentation
- `tests/README.md:64` still describes polling email status in SQLite, but status is no longer the processing source of truth

This matters because this repository is heavily documentation-driven for both humans and coding agents.

### 5.6 The transport story is confusing

`workflow-mcp` is configured as stdio in `.mcp.json` (`claude-code/.mcp.json:19`), but it also serves an HTTP health endpoint (`claude-code/channels/workflow-mcp.ts:390`), while `CHANGELOG.md:16` says it was converted to HTTP.

This is not necessarily a runtime bug, but it is an architectural comprehension problem.

V3 should make this naming and transport model explicit and boring.

### 5.7 There are still operator-maintained hacks in runtime setup

Two notable examples:

- Gmail MCP body truncation is patched with `sed` in `docker-compose.yml:167`
- Gmail MCP internal URL handling depends on `WORKSPACE_EXTERNAL_URL` in `docker-compose.yml:157`

These may be practical, but they are fragile enough that V3 should either encapsulate them better or own a local wrapper image explicitly.

### 5.8 There are likely correctness issues in the current baseline

Two code paths should be treated as likely bugs until verified:

- `downloadFromGdrive()` returns `size: fileBuffer.length`, but `fileBuffer` is not defined in that scope (`claude-code/channels/invoice-worker.ts:1451`)
- the Outlook attachment path appears to return `size: parsed.size` rather than `dlParsed.size` (`claude-code/channels/invoice-worker.ts:594`)

V3 planning should not ignore baseline correctness cleanup.

## 6. V3 Strategic Goal

V3 should make the current system feel like a small platform instead of a successful pile of tightly coupled flows.

A strong V3 outcome would be:

- current invoice/scan flows remain stable
- accountant workflow becomes a first-class supported path
- integration boundaries are explicit and typed
- documentation reflects reality
- adding a new workflow no longer means touching a single giant orchestrator file

## 7. Recommended V3 Workstreams

### Workstream A - Correctness, contracts, and cleanup

This is the V3 foundation and should happen first.

#### Goals

- verify and fix likely bugs in download paths
- add schema validation around workflow/classification boundaries
- implement deterministic local download cleanup
- remove stale docs that encode false behavior

#### Concrete targets

- `claude-code/channels/workflow-db.ts`
- `claude-code/channels/invoice-worker.ts`
- `docs/uc1-invoice-processing.md`
- `docs/uc1a-observability.md`
- `docs/observability.md`
- `tests/README.md`

### Workstream B - Split the invoice domain into explicit services

The current worker should become a small orchestrator over explicit modules.

Suggested decomposition:

```text
invoice/
  intake-worker.ts
  classification-service.ts
  download-service.ts
  paperless-service.ts
  dedup-service.ts
  gdrive-service.ts
  notification-service.ts
  policy.ts
```

#### Why this matters

- email and scan flows can share more code without sharing a monolith
- failures become easier to localize
- tests become smaller and more explicit
- integration boundaries become easier to mock and evolve

### Workstream C - Create a single Paperless adapter

V3 should define one internal Paperless boundary, even if the implementation still mixes MCP and direct HTTP under the hood.

That adapter should own:

- correspondent resolution
- tag resolution / creation
- document type resolution
- storage path resolution
- duplicate lookup
- upload
- task polling
- custom field update

This is one of the highest-leverage V3 simplifications.

### Workstream D - Consolidate watcher infrastructure

Do not unify business logic. Unify operational scaffolding.

Candidates for shared code:

- health server boot
- OTel metric registration patterns
- trace-linked job creation
- startup delay / poll loop wrapper
- remote MCP client reset/reconnect helpers

This should result in smaller watcher files without obscuring domain-specific logic.

### Workstream E - Finish the accountant workflow as the first V3 feature

The best V3 feature is not a new domain. It is the next workflow in the same domain.

Build on current implemented pieces:

- statement matching already exists (`checker-mcp/server.py:61`, `checker-mcp/server.py:125`)
- P&L already exists (`checker-mcp/server.py:125`)
- job model already supports approvals and retries (`claude-code/channels/workflow-db.ts:273`, `claude-code/channels/workflow-db.ts:334`)

V3 should add:

- generate accountant package job
- collect monthly artifacts
- produce ZIP
- draft email body
- require approval before send
- optionally schedule it later

This would validate the workflow platform without adding a new business domain.

### Workstream F - Refactor `checker-mcp` into engine plus delivery layers

`match_invoices.py` is valuable, but too much logic is concentrated in `collect_month()` and `collect_pl()`.

Recommended split:

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

This should be evolutionary, not a rewrite.

Keep the domain logic, but separate:

- domain models
- matching engine
- MCP transport
- Flask UI rendering

### Workstream G - Simplify observability and operational truth

The current observability stack is better than average, but the docs no longer reflect the real telemetry path.

Current implementation is OTLP-first:

- metrics exporter setup: `claude-code/channels/tracing.ts:72`
- email watcher OTel gauges: `claude-code/channels/email-watcher.ts:93`
- gdrive watcher OTel gauges: `claude-code/channels/gdrive-watcher.ts:88`
- Alloy OTLP receiver: `observability/alloy-config.alloy:11`
- Prometheus receives remote_write via Alloy: `observability/prometheus-config.yml:2`, `observability/alloy-config.alloy:71`

V3 should document that clearly and stop pretending there is a stable `/metrics` product story when the current code is actually health-only on watcher ports.

## 8. Technical Debt Register For V3 Planning

| Area | Debt | Evidence | V3 action |
|---|---|---|---|
| Worker structure | monolithic `invoice-worker.ts` | `claude-code/channels/invoice-worker.ts:177` | split by responsibility |
| Integration boundary | mixed Paperless MCP/direct HTTP usage | `claude-code/channels/invoice-worker.ts:843`, `claude-code/channels/invoice-worker.ts:1033` | create one adapter |
| Workflow contracts | weakly typed classification payloads | `claude-code/channels/workflow-db.ts:393` | add schemas/versioning |
| Watchers | duplicate scaffolding | `claude-code/channels/email-watcher.ts:93`, `claude-code/channels/gdrive-watcher.ts:88` | share infrastructure helpers |
| File lifecycle | no reliable cleanup of local downloads | `_tasks/_TECH_DEBT/02-download-directory-cleanup.md:7` | cleanup on terminal state |
| Ops clarity | transport confusion around workflow-mcp | `claude-code/.mcp.json:19`, `claude-code/channels/workflow-mcp.ts:390`, `CHANGELOG.md:16` | rename / document clearly |
| Runtime hacks | patching Gmail MCP in compose | `docker-compose.yml:167` | own wrapper or explicit custom image |
| Matcher codebase | large engine functions + duplicated web route setup | `checker-mcp/match_invoices.py:598`, `checker-mcp/match_invoices.py:958`, `checker-mcp/webapp.py:35`, `checker-mcp/webapp.py:238` | split engine from delivery |
| Test harness leakage | synthetic workflow type lives in production dispatch | `claude-code/channels/workflow-core.ts:40`, `claude-code/channels/workflow-core.ts:120` | isolate test-only helper paths |
| Docs drift | detailed docs no longer match code | see Section 5.5 | do doc cleanup pass |

## 9. Things V3 Should Explicitly Not Do First

### 9.1 Do not replace Claude Code as the runtime yet

The biggest current problems are code structure and boundary clarity, not the agent runtime itself.

### 9.2 Do not expand into unrelated domains first

Vehicle logbook, attendance, and cross-app workflows may still be valid future directions, but they are not the right first V3 step.

V3 should prove the platform by completing the accountant workflow inside the current domain.

### 9.3 Do not parallelize workers yet

Parallelism adds locking and concurrency complexity before the code is modular enough.

### 9.4 Do not hide more logic in prompts

The current system is strongest where logic lives in code and Claude is used only for bounded reasoning. V3 should continue that direction.

## 10. Proposed V3 Sequence

### Phase 0 - Baseline hardening

- fix likely correctness bugs
- add schema validation
- implement download cleanup
- update stale docs

### Phase 1 - Structural simplification

- split worker responsibilities into service modules
- add explicit Paperless adapter
- reduce watcher scaffolding duplication
- isolate synthetic workflow test helpers from production runtime

### Phase 2 - V3 feature completion in the current domain

- implement accountant package workflow
- add ZIP generation and draft email support
- make approval path explicit and auditable

### Phase 3 - Product/architecture review

After the above, decide whether the next V3 step is:

- scheduler / month-end automation
- more accounting workflows
- broader assistant capabilities
- new domains

## 11. Success Criteria For V3

V3 should be considered successful if the following are true:

### Architecture

- `invoice-worker.ts` is no longer the central monolith
- Paperless behavior is behind one explicit internal boundary
- watcher infrastructure is simpler and less repetitive
- workflow payloads have explicit schemas

### Product

- accountant workflow exists end-to-end
- operator can understand job state, approval state, and outcome without code archaeology
- documentation matches current runtime behavior

### Reliability

- no hidden operator-only cleanup steps
- download and upload paths are regression-tested
- telemetry and health model are documented the way the code actually works

## 12. Closing Assessment

The current system is good enough to serve as a serious V3 baseline.

That is the key point.

V3 does not need a new foundational idea. It needs a cleaner expression of the idea that already works:

- deterministic workflow runtime
- bounded use of Claude
- explicit state
- strong operational visibility
- domain-specific accounting/document automation

If V3 focuses on simplification, stronger contracts, and completing the accountant workflow before widening scope, this codebase can evolve from a powerful specialized automation stack into a durable platform.

If V3 instead jumps straight to new domains or another architectural rewrite, it will likely increase surface area faster than maintainability.

The right V3 move is disciplined consolidation.
