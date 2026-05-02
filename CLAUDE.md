# Personal Assistant Stack

Event-driven personal assistant using Claude Code Channels + MCP tool servers.

**Use-case index**: `docs/USE_CASES.md` — **keep this up to date** (see below)
**Detailed pipeline docs**: `docs/uc1-invoice-processing.md`, `docs/infrastructure.md`
**Original design docs** (historical): `_tasks/_done/10-personal-assistant/`

## Public Placeholder Conventions

Public docs use realistic placeholders instead of site-specific values.

Examples:

- `documents.lan`, `invoices.lan`
- `/mnt/shared_configs/<stack>/...`
- `YOUR_DOCKER_HOST`, `YOUR_OTEL_ENDPOINT`

Keep examples concrete enough that contributors and coding agents can still map them back to a real deployment.

## Use-Case Index

`docs/USE_CASES.md` is the single source of truth for what this project delivers.

**MANDATORY: After ANY implementation work in this stack, update all affected documentation before considering the task done.** This is not optional. Documentation drift is a recurring problem — treat doc updates as part of the implementation, not a follow-up.

1. Update the status column in `docs/USE_CASES.md`
2. Update detailed docs in `docs/` (pipeline flow, code links, line numbers, architecture diagrams, span names, config references, etc.)
3. Update this `CLAUDE.md` if key files, architecture, metrics, spans, or observability setup changed
4. Add new use cases if scope expands
5. Remove references to deleted files, renamed functions, or changed behavior

## Testing

**When asked to verify, review, or test this stack — run tests. All of them. Do not skip.**

### Unit + integration tests (always run first)

```bash
# pollers workspace (200 tests)
cd compose.stacks/infra/personal-assistant/pollers && bun test

# claude-code channels (390 tests)
cd compose.stacks/infra/personal-assistant/claude-code && bun test
```

### E2E tests (spin up the stack, then run)

The E2E pytest suite requires a running local stack. **Spin it up — do not declare it "unavailable" without trying.**

```bash
# Start the full local stack (builds images if needed)
cd compose.stacks/infra/personal-assistant
docker compose --profile local up -d --build

# Wait for claude-code to become healthy (~90s), then:
python -m pytest tests/test_gdrive_scan.py -v           # gdrive pipeline
python -m pytest tests/ -v -m "not link" --timeout=300 # all except SSH-dependent link test
```

The `.env` file is present locally and has valid credentials. `gmail-mcp` and `outlook-mcp` retain their OAuth tokens across restarts — they do not need re-authentication. **Just bring the stack up and run the tests.**

## Architecture

```
claude-code container (node:20-slim, user: node, --model sonnet)
├── Claude Code interactive session in tmux (--remote-control)
├── telegram channel (official plugin, cloned at build, two-way)
├── file-ops tool server (stdio, scoped file downloads/deletes/decrypt/base64/env)
├── workflow-mcp channel+tools (stdio, durable job queue MCP surface + 2s classification push loop)
│   ├── exposes 4 read-only debug tools that read emails.db / gdrive.db via the shared volume
│   ├── get_recent_emails, get_email_stats, get_gdrive_scan_status, get_gdrive_scan_stats
├── subagents: email-classifier (haiku), document-classifier (haiku, returns owner field)
└── connects to MCP tool servers via Streamable HTTP

email-poller container (oven/bun:1-alpine)
├── polls Gmail + Outlook every POLL_INTERVAL_MS (default 30s)
├── writes emails.db (audit trail) + workflow.db (creates invoice_intake jobs)
├── exposes /health on :9465
└── INITIAL_LOOKBACK seeds last_checked on first run; over-cap windows fail loud

gdrive-poller container (oven/bun:1-alpine)
├── polls Google Drive folders (GDRIVE_LEVEL1 × GDRIVE_LEVEL2) every 30s via gmail-mcp
├── writes gdrive.db (audit trail) + workflow.db (creates scan_intake jobs)
└── exposes /health on :9466

pa-worker container (oven/bun:1-alpine)
├── runs /app/channels/worker.ts (extracted from workflow-mcp by task 64)
├── workerTick on WORKFLOW_POLL_MS — reclaim stale + executeNextJob
├── sweepStaleGuidance on 60s (reminder at 24h, fail at 72h)
├── sweepOrphanedDownloads once on boot
├── notifyTelegram (outbound — uploaded/failed/refreshed/guidance reminders)
└── exposes /health on :8003

paperless-mcp container (ghcr.io/baruchiro/paperless-mcp:latest)
└── 20 Paperless-ngx CRUD tools on :3000/mcp

checker-mcp container (python:3.12-slim, two-process)
├── 4 invoice matching/P&L tools on :8001/mcp (wraps match_invoices.py)
└── Flask web UI on :5000 (`invoices.lan` in public docs)

gmail-mcp container (ghcr.io/taylorwilsdon/google_workspace_mcp)
├── Gmail tools on :8000/mcp (community, OAuth via start_google_auth)
└── Google Drive tools (list, download, move files)

outlook-mcp container (python:3.12-slim)
└── 4 Outlook read-only tools on :8002/mcp (custom, MSAL device code auth)
```

Pollers are pure data-path containers — they write directly into `workflow.db`. They are independent of Claude Code's lifecycle, so an MCP-spawn race can never break ingest. Only `telegram`, `file-ops`, and `workflow-mcp` remain as Claude Code stdio channels (they each need access to the live Claude session). MCP tool servers run as separate containers via Streamable HTTP (`"type": "http"` in `.mcp.json`).

The workflow executor runs in a separate `pa-worker` Docker container — `workflow-mcp` writes a `classification_request_meta` job event when the worker parks a job for classification, and a 2s push loop in `workflow-mcp` (running inside `claude-code` with the live Claude session) drains those breadcrumbs into channel notifications. Net latency cost: one `WORKFLOW_POLL_MS` tick (~2s) before Claude sees the request.

## Robustness & Health

### Health Checks

All services have Docker health checks. `claude-code` depends on all MCPs via `depends_on: service_healthy` — it won't start until all MCPs are ready.

| Service | Health check | Interval | Start period |
|---|---|---|---|
| `claude-code` | tmux session alive + pgrep workflow-mcp | 30s | 90s |
| `pa-worker` | HTTP `/health` (port 8003) | 30s | 30s |
| `email-poller` | HTTP `/health` (port 9465) — staleness check on `lastSuccessfulPollAt` | 30s | 30s |
| `gdrive-poller` | HTTP `/health` (port 9466) — staleness check on `lastSuccessfulPollAt` | 30s | 30s |
| `checker-mcp` | TCP socket check (ports 8001 + 5000) | 30s | 15s |
| `outlook-mcp` | TCP socket check (port 8002) | 30s | 30s |
| `paperless-mcp` | TCP port 3000 check via Node | 30s | 15s |
| `gmail-mcp` | TCP port 8000 check via Python | 30s | 15s |

The email-poller and gdrive-poller `/health` endpoints also track poll staleness — return 503 if no successful poll within the staleness window. This detects both MCP connectivity loss and poller hangs.

When the tmux session dies, the entrypoint exits with code 1, triggering Docker's `restart: unless-stopped` policy.

### Stateless MCP Sessions

Custom MCP servers (`checker-mcp`, `outlook-mcp`) run with `FASTMCP_STATELESS_HTTP=true`. This means:
- No MCP session IDs are assigned
- Server restarts are transparent to Claude Code (no session to lose)
- Works around Claude Code bug [#27142](https://github.com/anthropics/claude-code/issues/27142) where cached session IDs cause permanent tool failures after server restart

Community servers (`paperless-mcp`, `gmail-mcp`) may still use stateful sessions. If they restart and Claude's tool calls fail, restart the `claude-code` container.

### Watchtower

All services have `com.centurylinklabs.watchtower.enable: "false"` — no mid-session auto-updates. Update community images intentionally through your deployment workflow.

### Version Pinning

| Image | Pin strategy |
|-------|-------------|
| `checker-mcp`, `outlook-mcp`, `claude-code` | Local builds, tagged by git commit |
| `gmail-mcp` | Pinned to `1.16.2` (semver available on GHCR). HTML body truncation patched from 20k→100k via sed in compose entrypoint |
| `paperless-mcp` | `:latest` (no semver tags; Watchtower excluded, `auto_pull=false`) |

### Troubleshooting: HTTP MCPs show "△ needs authentication"

**Symptom.** In Claude's `/mcp` UI, one or more HTTP MCPs (paperless, checker, gmail) show as `△ needs authentication`. Asking Claude to call those tools returns an `authenticate` placeholder instead of executing the tool. The pipeline silently stalls — invoice jobs accumulate in `awaiting_classification` because Claude can't fetch email bodies. Watchers and stdio channels keep working (they have their own MCP clients), so the failure looks partial.

**Root cause.** Claude Code's MCP SDK persistently caches OAuth Dynamic Client Registration discovery state under `mcpOAuth` in `~/.claude/.credentials.json`. Once an entry exists with a non-empty `discoveryState`, the SDK treats that server as OAuth-protected on every startup — even when `accessToken` is empty and the server returns plain 404s on `/register`. The state survives container restarts because `data/claude-config/` is a host bind-mount. Upstream tracking: [anthropics/claude-code#34008](https://github.com/anthropics/claude-code/issues/34008). Full post-mortem: [`_tasks/46-mcp-oauth-state-cleanup/`](../../../_tasks/46-mcp-oauth-state-cleanup/).

**Defensive fix (in place).** `claude-code/entrypoint.sh` strips the entire `mcpOAuth` block from `.credentials.json` on every container start, before launching Claude. Logs `Cleared stale mcpOAuth entries: ...` when it cleans something, silent no-op otherwise. We never use OAuth on any HTTP MCP in this stack, so the block is always safe to wipe.

**Manual recovery** (if you ever roll back the entrypoint fix or hit the same symptom on a stack without it):

```bash
# Inspect the cache (look for entries other than `outlook` — outlook never gets one)
docker exec personal-assistant-claude bun -e \
  'console.log(Object.keys(JSON.parse(require("fs").readFileSync("/home/node/.claude/.credentials.json","utf8")).mcpOAuth || {}))'

# Wipe it (preserves claudeAiOauth and all other top-level fields)
docker exec personal-assistant-claude bun -e '
  const fs = require("fs")
  const p = "/home/node/.claude/.credentials.json"
  const j = JSON.parse(fs.readFileSync(p, "utf8"))
  j.mcpOAuth = {}
  fs.writeFileSync(p, JSON.stringify(j))
'

# Restart so Claude Code re-initializes the HTTP MCPs from a clean cache
docker restart personal-assistant-claude
```

After restart, `docker exec personal-assistant-claude tmux send-keys -t claude /mcp Enter && sleep 3 && docker exec personal-assistant-claude tmux capture-pane -t claude -p` should show all 4 HTTP MCPs as `✓ connected`. **Do NOT** automate this check from within `entrypoint.sh` — keystroke-based MCP menu navigation against the live session races with workflow channel notification delivery and silently interrupts in-progress jobs. The reconnect script that used to do this was removed in task 46 for exactly that reason.

## Key Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Full stack with `local` profile for dev |
| `.env` / `.env.example` | Local dev configuration and secrets |
| `claude-code/Dockerfile` | node:20 + bun + claude-code CLI, non-root user |
| `claude-code/.mcp.json` | MCP server config (channels + HTTP tools) |
| `claude-code/.claude/settings.json` | Permission allowlist (dontAsk mode) |
| `claude-code/CLAUDE.md` | Instructions for the Claude session |
| `claude-code/entrypoint.sh` | tmux wrapper, prompt detection, health monitor |
| `claude-code/channels/file-ops.ts` | File-ops MCP tool server (download, delete, list, decrypt, base64, env) |
| `pollers/email-poller/src/main.ts` | Email poller (Gmail+Outlook → workflow.db). INITIAL_LOOKBACK seeding, fail-loud overflow. |
| `pollers/email-poller/cli/skip-catchup.ts` | Operator escape hatch to advance `last_checked = now`. |
| `pollers/gdrive-poller/src/main.ts` | Google Drive poller (LEVEL1 × LEVEL2 → workflow.db) |
| `pollers/lib/email-db.ts` | emails + source_state SQLite schema (was `claude-code/channels/db.ts`) |
| `pollers/lib/gdrive-db.ts` | gdrive_files SQLite schema |
| `pollers/lib/watcher-runtime.ts` | Shared health server / managed MCP client / poll loop helpers |
| `pollers/lib/workflow-db.ts` | Shared duplicate of the workflow.db schema (Komodo pins the same git commit across builds) |
| `claude-code/channels/download-helper.ts` | File utility functions (readFileAsDownload, tryDecrypt) used by file-ops + invoice/intake-worker |
| `claude-code/channels/invoice-links.ts` | Shared invoice link extraction from HTML (vendor rules, used by email-poller + invoice/download-service) |
| `claude-code/channels/mcp-client.ts` | HTTP MCP client with retry logic (exponential backoff for transient network errors) + `McpToolError` thrown on `isError: true` tool responses so error payloads don't silently leak into callers as if they were valid output (task 48) |
| `claude-code/channels/workflow-mcp.ts` | Durable job queue channel (stdio) — MCP tool surface (create/get/list/approve/cancel jobs, submit_classification, provide_guidance) + 2s classification push loop that drains `classification_request_meta` breadcrumbs into Claude channel notifications. |
| `claude-code/channels/worker.ts` | Standalone executor module (task 64): workerTick, sweepStaleGuidance, sweepOrphanedDownloads (boot), notifyTelegram, /health on :8003. Runs in pa-worker container. |
| `worker/Dockerfile` | Bun-based image for the pa-worker container. Build context is ./claude-code so it shares the channels/ source tree with workflow-mcp. |
| `claude-code/channels/workflow-db.ts` | jobs + job_events SQLite schema, lifecycle helpers, schema validation gateway, file-cleanup helpers, indexed `paperless_doc_id` column for multi-stage refresh lookups |
| `claude-code/channels/workflow-schemas.ts` | Runtime validation for InvoiceIntakeInput, ScanIntakeInput, EmailClassificationResult, DocumentClassificationResult |
| `claude-code/channels/paperless-adapter.ts` | Unified Paperless boundary (MCP + REST). Owns correspondent/tag/doc-type/storage CRUD, dedup search, upload, PATCH, task polling, custom fields. |
| `claude-code/channels/invoice-pipeline.ts` | Pure pipeline functions (mergeClassifications, resolveMonthTag, validMonthTag, parseServicePeriodStart, buildTagNames, generateTitle, getCompletedSteps) |
| `claude-code/channels/invoice/intake-worker.ts` | Invoice + scan intake orchestrator (executeInvoiceIntake, executeScanIntake) |
| `claude-code/channels/invoice/download-service.ts` | Download strategies: Outlook/Gmail attachments, link extraction, direct HTTP, GDrive |
| `claude-code/channels/invoice/dedup-service.ts` | Duplicate detection (order_id + correspondent + amount comparison). Returns `force_refresh` outcome when an exact-amount duplicate is found AND the new email is strictly newer than the existing doc's source email (multi-stage vendor refresh, task 59). Date-aware comparison via `Date.parse` to tolerate the heterogeneous RFC 2822 / ISO 8601 timestamp formats the watchers store. |
| `claude-code/channels/invoice/classification-state.ts` | parkForClassification helper — transitions the job to `awaiting_classification` and writes the `classification_request_meta` breadcrumb that workflow-mcp's push loop drains into a channel notification |
| `claude-code/channels/invoice/postprocess-service.ts` | resolveCorrespondent, resolveTagIds, resolveDocumentTypeId, resolveStoragePathId, uploadToPaperless, setDocumentCustomFields, patchExistingDocument, moveGdriveFile, buildScanTitle |
| `claude-code/channels/fuzzy-match.ts` | Jaro-Winkler fuzzy correspondent matching |
| `claude-code/agents/` | Haiku subagents (email-classifier, document-classifier — classifier returns `owner` field for personal/business tag routing) |
| `checker-mcp/server.py` | FastMCP wrapping the engine (4 tools), imports from `engine.*` |
| `checker-mcp/webapp.py` | Flask web UI (matching view + P&L view), imports from `engine.*` |
| `checker-mcp/entrypoint.sh` | Two-process entrypoint (MCP background + Flask PID 1) |
| `checker-mcp/match_invoices.py` | CLI entry point + shared configuration constants (~235 lines after Phase 5 split) |
| `checker-mcp/engine/` | Layered matching engine: `models.py`, `parsing.py`, `matching.py`, `client.py`, `collection.py` |
| `outlook-mcp/server.py` | Outlook MCP (MSAL device code auth) |
| `observability/` | Local dev Alloy, Prometheus, Loki, Grafana configs |

## Source Code Guide

Navigational guide to the largest source files. Line numbers are approximate.

### checker-mcp/engine/ (~1240 lines split across 5 modules)

The matching engine is a layered package. Strict layering: `models` has no dependencies; `parsing`, `matching`, `client` depend only on `models`; `collection` depends on all four.

| Module | Lines | Key contents |
|--------|-------|--------------|
| `engine/models.py` | ~85 | `PLCategory`, `SkipReason`, `SkipRule`, `SkipResult`, `SKIP_RULES`, `SKIP_ACCOUNT_RULES` (loaded from `SKIP_PAYROLL_ACCOUNTS` env var) |
| `engine/parsing.py` | ~215 | Statement parsing regexes (`RE_STATEMENT_AMOUNT`, `RE_PAGE_BREAK`, `RE_OPENING_BALANCE`, `RE_ORIG_AMOUNT`), `parse_statement_amount()`, `parse_movements()` (Tatra Banka format), invoice amount extraction (`RE_AMOUNT`, `RE_TOTAL_AMOUNT`, `RE_CURRENCY_AMOUNT`), `normalize_amount()`, `extract_invoice_amounts()` |
| `engine/matching.py` | ~225 | `MONTH_WINDOW`, `month_offset()`, `get_month_window()`, `skip_reason()`, `extract_prefix()`, `_pair_keys()`, `build_pair_index()` (filename prefix + title prefix + cross-sign pairing), `find_matching_invoice()` (4-pass: primary+sign, primary, secondary+sign, secondary) |
| `engine/client.py` | ~70 | `PaperlessClient` — paginated REST wrapper for documents, tags, custom fields, document types |
| `engine/collection.py` | ~640 | `collect_month()` (308 lines: fetch + match + skip + alt-amount + cancelled-pair detection + pair enrichment), `filter_resolved_unmatched()`, `collect_pl()` (236 lines: full-year orchestration with VAT deduction + cross-sign cancellation + income-prefix matching), `_detail_to_pl_category()` |

### checker-mcp/match_invoices.py (~235 lines)

CLI entry point only. Owns argparse, terminal-color rendering (`print_results`), the high-level command flow (`main`), and the configuration constants (`PAPERLESS_URL`, `ACCOUNTING_TAG_NAME`, `ACCOUNT_STATEMENT_TAG_NAME`, `INVOICE_TYPE_NAME`, `TOTAL_AMOUNT_FIELD_NAME`, `TOTAL_AMOUNT_ALT_FIELD_NAME`) which are also imported by `server.py` and `webapp.py` so they don't need their own copy.

### checker-mcp/webapp.py (~520 lines)

Flask app on `:5000`. Matching view (terminal-style, status codes: ok/missing/manual/info) and P&L view (annual summary, income/expense). Query params: `?month=2026-03`, `?all`, `?year=2026`. Paperless links for drill-down.

### checker-mcp/server.py (~235 lines)

FastMCP wrapping `match_invoices.py`. 4 tools via HTTP. Lazy-init `PaperlessClient` singleton + field ID resolution. Host header rewrite for DNS rebinding protection (Docker networking).

### outlook-mcp/server.py (~310 lines)

MSAL device code auth with singleton caching (`_msal_lock`). `get_access_token()` does silent acquisition then falls back to device code flow. Background auth thread (daemon) doesn't block server startup. 4 tools: `list_emails`, `get_email`, `get_attachments`, `download_attachment`.

### pollers/email-poller/src/main.ts

Standalone Bun service that polls Gmail + Outlook every `POLL_INTERVAL_MS` (default 30s) via Streamable HTTP MCP clients. Creates `invoice_intake` jobs directly in `workflow.db`. SQLite audit trail (`emails.db`). Health endpoint `/health` on `:9465` with staleness detection. On first run for a source, seeds `last_checked` from `INITIAL_LOOKBACK` (default `3d`) instead of asking Claude. If a poll cycle sees more emails than `MAX_CATCHUP_EMAILS` (default 200), logs `ERROR: catchup overflow`, emits `email_watcher.catchup_overflow{source=...}` OTel counter, and does NOT advance `last_checked`.

### pollers/gdrive-poller/src/main.ts

Standalone Bun service that polls Google Drive folders (`GDRIVE_LEVEL1` × `GDRIVE_LEVEL2`) every 30s via the gmail-mcp Drive tools. Creates `scan_intake` jobs directly in `workflow.db`. SQLite audit trail (`gdrive.db`). Health endpoint `/health` on `:9466`. Uses `pollers/lib/watcher-runtime.ts` for the health server, MCP client lifecycle, and poll loop.

### pollers/lib/watcher-runtime.ts (~155 lines)

Shared operational scaffolding for both pollers. Three pieces:
- `startHealthServer({port, db, getStaleMs, maxStaleMs, ...})` — Bun.serve `/health` with staleness check
- `createManagedMcpClient({name, version, url, ...})` — singleton MCP client wrapper with `.get()` and `.reset()`
- `startPollLoop({name, intervalMs, poll, runFirstCycleImmediately, ...})` — setInterval poll loop with try/catch logging

Domain logic stays in each poller (Gmail/Outlook polling, Drive folder logic, audit DB schemas, OTel gauges).

### claude-code/channels/invoice/intake-worker.ts (~1110 lines)

Deterministic job worker and pipeline orchestrator. Owns `executeInvoiceIntake` and `executeScanIntake`. Drives the full pipeline:

1. validate `input_json` via `workflow-schemas.ts` (fails fast with `schema_validation_failed` on bad rows)
2. request email classification via channel (`invoice/classification-state.ts:parkForClassification`)
3. download via `invoice/download-service.ts` (Outlook attachment, Gmail attachment, link extraction, GDrive)
4. record file path with `recordDownloadedFile()` so cleanup runs at terminal state
5. request document classification via channel
6. merge classifications, resolve month_tag (LLM `accounting_period` first, deterministic chain as safety net)
7. resolve correspondent, dedup, tags, doc type, storage path — all via `invoice/postprocess-service.ts` which delegates to `paperless-adapter.ts`
8. upload to Paperless directly OR PATCH the existing doc in place (force-refresh path)
9. set custom fields after consumption (poll task → PATCH → verify)
10. send Telegram notification

Step-level resume via `getCompletedSteps` — on retry, the worker skips already-completed steps. Approval gates for `browser_required` / `manual_review` / `duplicate_likely`. **Force reprocess:** when the job input has `force: true`, dedup hits do NOT short-circuit — the worker re-runs the full pipeline and PATCHes the existing Paperless doc in place (preserves doc id, PDF, OCR), producing the `refreshed` outcome. **Multi-stage vendor refresh (task 59):** the email pipeline also passes a `RefreshDecisionContext` to `dedup-service.checkDuplicate` carrying the new email's `received_at` plus a `getLatestReceivedAtForDoc` lookup against `workflow.db`. When dedup hits AND the new email is strictly newer than the existing doc's source email, dedup returns `outcome: "force_refresh"` and the same PATCH path fires — automatically, no operator interaction. Scan pipeline left unchanged; multi-stage refresh is email-driven only.

### claude-code/channels/paperless-adapter.ts (~485 lines)

Unified Paperless boundary. Owns every operation that hits Paperless, regardless of transport. MCP for `list_correspondents`, `create_correspondent`, `list_tags`, `create_tag`, `list_document_types`. Direct HTTP for storage paths, dedup search, multipart upload (`/api/documents/post_document/`), task polling, document PATCH, custom field PATCH. The split is hidden from callers — they see one interface (`findCorrespondent`, `createCorrespondent`, `resolveTagIds`, `findDocumentTypeId`, `findStoragePathId`, `searchDocumentsByCustomFieldAndCorrespondent`, `uploadDocument`, `patchDocument`, `waitForConsumption`, `setCustomFields`).

All `list_*` MCP calls go through a private `listAllPages` helper that walks the `next` link until exhausted (page_size=100, max 50 pages). Before task 48 the adapter only ever saw page 1 of Paperless's paginated responses — which silently corrupted 17 production documents with `correspondent: null` because the fuzzy matcher couldn't see the correspondent past entry 25. `createCorrespondent` / `createTag` also runtime-validate the parsed response shape instead of relying on `as` type assertions, so an unexpected MCP response is a clear thrown error instead of silently producing `{id: undefined}`.

### claude-code/channels/workflow-schemas.ts (~430 lines)

Hand-rolled runtime validators (no zod) for the four boundary contracts: `InvoiceIntakeInput`, `ScanIntakeInput`, `EmailClassificationResult`, `DocumentClassificationResult`. Each validator throws `WorkflowSchemaError` with schema name, field, expected type, and actual value. `submitClassification` validates payloads on write (rejects malformed Claude outputs); both watchers validate job input before `createJob`; the worker validates `input_json` on every run.

### claude-code/channels/workflow-mcp.ts (~440 lines)

Durable job queue backed by SQLite (`workflow.db`). Stdio channel with health endpoint on :8003. Job states: queued → running → awaiting_classification → awaiting_approval → awaiting_user_guidance → completed/failed. Tools: `create_invoice_intake_job(email_source, message_id, force?)` (manual/force reprocessing only — watchers create jobs directly), `create_scan_intake_job()`, `get_job()`, `list_jobs()`, `approve_job()`, `cancel_job()`, `submit_classification(job_id, step, result)`, `provide_guidance(job_id, guidance)` (resumes a job paused in `awaiting_user_guidance`; `guidance.action` is `skip | retry | fail | patch`, optional `decrypt_password` routed to a separate `guidance_password` event so password material never lands in the normal audit trail — see task 57 / "Guidance routing for paused jobs" in `claude-code/CLAUDE.md`). On boot, runs `sweepOrphanedDownloads()` to delete files > 7d old that aren't tied to an active job (defense-in-depth for download cleanup; per-job cleanup is automatic via `completeJob` / `failJob` / `cancelJob`). A separate 60s `setInterval` runs `sweepStaleGuidance` which nudges operators at 24h (rate-limited per job to one Telegram message per 6h via `last_reminder_at`) and auto-fails `awaiting_user_guidance` jobs at 72h.

**Guidance pause triggers (both intake paths):** Trigger A — classifier returned `"unknown"` for a required field; Trigger B — PDF still encrypted after `tryDecrypt`. See `docs/uc1-invoice-processing.md#uc-16b-when-the-classifier-doesnt-know-guidance-pause`.

### claude-code/agents/

Two Haiku subagents:
- **email-classifier.md** — classifies email metadata → vendor, amount, download_strategy, action, confidence
- **document-classifier.md** — visually inspects PDF → vendor, amount, doc_type, owner (personal/business tag routing)

## Claude Code in Docker — Reference

### Authentication
- **Claude**: `docker exec -it personal-assistant-claude claude login` (one-time)
- **Gmail**: trigger `start_google_auth` from Claude session -> `gmail-mcp-auth` sidecar passes callback through, protects `/mcp*` with bearer token
- **Outlook**: restart container, get device code from `docker logs personal-assistant-outlook-mcp 2>&1 | grep -A3 "OUTLOOK AUTH"`
- **Telegram**: DM the bot, access.json in volume handles pairing
- Tokens persist in `/mnt/shared_configs/<stack>/` or your configured persistent volume
- After auth, restart Claude to reconnect MCPs: `docker restart personal-assistant-claude`

### Settings
`claude-code/.claude/settings.json` is committed to the repo with `permissions.allow` and `permissions.deny` lists.

Permission model: `--permission-mode dontAsk` auto-denies any tool not in the allowlist.

- **No permission needed** (always available): `Read`, `Glob`, `Grep`, `Agent`, `ToolSearch`
- **Allowed via settings**: MCP tools (wildcards for our servers, individual for gmail), `Bash(sleep *)`, `Edit`/`Write` for memory dir only
- **Denied**: gmail write/browse tools, all file-manipulating Bash commands (`curl`, `rm`, `mkdir`, `cp`, `find`, `base64`, `qpdf`, `echo`, `cat`, `env`, `node`) — file operations are handled by the `file-ops` MCP instead

See [README.md#permission-model](README.md#permission-model) for the design rationale.

### Flags
```bash
claude \
  --permission-mode dontAsk \              # auto-deny tools not in allowlist
  --dangerously-load-development-channels server:name \  # load custom channel from .mcp.json
  --mcp-config /workspace/.mcp.json       # explicit MCP config path
```

- `--permission-mode dontAsk`: replaces `--dangerously-skip-permissions`. Denies anything not in `permissions.allow` (settings.json).
- `--dangerously-load-development-channels`: has unskippable TUI prompt — entrypoint polls for it and sends Enter (replaces old blind `sleep 5`)
- `--channels plugin:name@marketplace`: loads approved channel plugins without prompt
- `--mcp-config`: needed because `-p` mode doesn't auto-discover workspace `.mcp.json`
- `--remote-control`: flag (not subcommand) for remote access, composable with `--channels`
- `claude remote-control`: subcommand, does NOT accept `--channels`

### MCP Config Format
```json
{
  "mcpServers": {
    "channel-name": {
      "command": "bun",
      "args": ["run", "/path/to/channel.ts"]
    },
    "tool-server": {
      "type": "http",
      "url": "http://service:8000/mcp"
    }
  }
}
```
- Use `"type": "http"` for Streamable HTTP (NOT `"type": "url"`)
- Channel servers use `command`/`args` (stdio subprocess)
- HTTP servers need DNS rebinding protection disabled or Host header rewrite for Docker networking

### Channels API (TypeScript)

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const mcp = new Server(
  { name: 'my-channel', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions: 'Events arrive as <channel source="my-channel">.',
  },
)

await mcp.connect(new StdioServerTransport())

// Push event:
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: 'event body text',
    meta: { key: 'value' },  // becomes attributes on <channel> tag
  },
})
```

Events arrive in Claude's session as:
```
<channel source="my-channel" key="value">event body text</channel>
```

Two-way channels expose MCP tools (e.g. `reply`) via standard `ListToolsRequestSchema`/`CallToolRequestSchema`.

### FastMCP Tool Server (Python)

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("my-server")

@mcp.tool()
def my_tool(param: str) -> str:
    """Tool description."""
    return f"Result: {param}"

if __name__ == "__main__":
    import uvicorn
    app = mcp.streamable_http_app()

    # Docker networking: rewrite Host header to pass DNS rebinding protection
    async def passthrough(scope, receive, send):
        if scope["type"] == "http":
            headers = list(scope.get("headers", []))
            scope["headers"] = [
                (k, b"localhost:8000") if k == b"host" else (k, v)
                for k, v in headers
            ]
        await app(scope, receive, send)

    uvicorn.run(passthrough, host="0.0.0.0", port=8000)
```

## Windows: TypeScript LSP Fix

Claude Code's `typescript-lsp` plugin fails on Windows with `ENOENT: uv_spawn 'typescript-language-server'` because Node.js `spawn()` can't resolve npm's `.cmd` wrappers without `shell: true` ([#16751](https://github.com/anthropics/claude-code/issues/16751)).

**Fix:** In `~/.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json`, change:
```json
"command": "typescript-language-server"  →  "command": "typescript-language-server.cmd"
```

**After plugin updates:** This file gets overwritten — reapply the `.cmd` suffix.

**Why pyright works:** pip installs real `.exe` shims; npm only creates `.cmd` batch wrappers.

## First deploy of email/gdrive pollers

**First deploy of email/gdrive pollers.** On a fresh deploy where `emails.db` has no `source_state` rows, the email-poller seeds `last_checked` for each enabled source from `INITIAL_LOOKBACK` (default `3d`). To pick a different window, set `INITIAL_LOOKBACK=1w` (or `12h`, `24h`, etc.) in `.env` (or in the Komodo stack environment) **before** the first deploy. After the first poll cycle the row exists and the var is ignored.

**Catchup overflow.** If a poll cycle ever sees more than `MAX_CATCHUP_EMAILS` (default 200) new emails for a single source, the poller logs `ERROR: <source> catchup overflow` and bumps the OTel `email_watcher.catchup_overflow{source=...}` counter without advancing `last_checked`. Run the escape hatch:

```bash
docker exec personal-assistant-email-poller \
  bun /app/email-poller/cli/skip-catchup.ts gmail
```

This advances `last_checked = now` so the next poll cycle starts fresh.

## Development

Development runs locally on the Windows dev machine using Docker Desktop with the `local` profile.

### First-time local setup

On a fresh machine or VM, two things must happen before the stack will stay healthy:

**1. Fix `data/` directory ownership.**
Docker creates bind-mount directories as `root:root` on first run, but several containers run as UID 1000 (`node`/`app`). Without the ownership fix, `gmail-mcp` crashes with a permission error on its credentials dir and `claude-code` can't write `settings.json`:

```bash
# Run once before (or after) first `docker compose up`
sudo chown -R 1000:1000 data/claude-config data/downloads data/email-watcher data/gdrive-watcher data/gmail
```

Note: `data/outlook/` and `data/paperless/` can stay root-owned — those containers run as root.

**2. Log Claude in.**
A fresh `data/claude-config/` has no `.credentials.json`. Without credentials Claude exits immediately, killing all its stdio channels (`workflow-mcp.ts`, `telegram`, `file-ops`), and the container loops in a crash-restart cycle. Log in once with a temporary one-shot container (credentials persist in the bind-mounted volume):

```bash
docker run --rm -it -u node \
  -v $(pwd)/data/claude-config:/home/node/.claude \
  --entrypoint claude personal-assistant-claude-code:latest login
```

After login completes, start (or restart) the main stack as normal.

**3. Bootstrap the local Paperless instance.**
The local Paperless container starts empty (no admin user, no API token). `workflow-mcp.ts` calls `fieldRegistry.init()` on startup which hits the Paperless API — without a valid token it retries for ~62s then crashes, keeping the container unhealthy. Create the admin and token before starting `claude-code`:

```bash
# Create admin superuser (non-interactive)
docker exec personal-assistant-paperless \
  python3 manage.py createsuperuser --username admin --email admin@local.com --noinput

# Generate API token (copy the token value from output)
docker exec personal-assistant-paperless \
  python3 manage.py drf_create_token admin

# Put the token in .env
sed -i 's/^PAPERLESS_API_TOKEN=.*/PAPERLESS_API_TOKEN=<paste-token-here>/' .env

# Recreate services that use the token
docker compose --profile local up -d checker-mcp paperless-mcp claude-code

# Pre-create the two storage paths the worker uses (postprocess-service.ts:43,48).
# Without them the worker logs "Storage path not found: ..." and uploads docs
# with storage_path=null — most E2E tests assert on storage_path_name and fail.
TOKEN=$(grep ^PAPERLESS_API_TOKEN .env | cut -d= -f2)
for sp in "Personal Documents:Personal/{created_year}" \
          "Techlab Invoices:Techlab/{correspondent}/{created_year}-{created_month}"; do
  curl -s -X POST http://localhost:8010/api/storage_paths/ \
    -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"${sp%%:*}\",\"path\":\"${sp##*:}\",\"matching_algorithm\":0}"
done
```

The superuser password isn't set by default — set it if you need Paperless UI access (`manage.py changepassword admin`).

**Typical first-deploy sequence:**

```bash
# 1. Build images and start all services except claude-code (which needs credentials)
docker compose --profile local up -d --build

# 2. Wait for gmail-mcp to become healthy, then fix ownership
sudo chown -R 1000:1000 data/claude-config data/downloads data/email-watcher data/gdrive-watcher data/gmail

# 3. Log Claude in (one-time)
docker run --rm -it -u node \
  -v $(pwd)/data/claude-config:/home/node/.claude \
  --entrypoint claude personal-assistant-claude-code:latest login

# 4. Bootstrap local Paperless (see step 3 above for commands)

# 5. Recreate services with valid token, Claude comes up healthy
docker compose --profile local up -d
```

```bash
# Start the full stack (from compose.stacks/infra/personal-assistant/)
docker compose --profile local --env-file .env up

# Rebuild after code changes
docker compose --profile local --env-file .env up --build

# Check status
docker compose --profile local --env-file .env ps

# View Claude session
docker exec personal-assistant-claude tmux capture-pane -t claude -p -S -30

# Attach interactively
docker exec -it personal-assistant-claude tmux attach -t claude

# Check Claude env vars
docker exec personal-assistant-claude sh -c "env | grep -E 'OTEL|TELEMETRY'"
```

### Production vs Local

| Aspect | Production | Local |
|--------|-----------|-------|
| Volumes | Mounted persistent storage at `/mnt/shared_configs/<stack>/` | Local `./data/` bind mounts |
| Polling | 30s intervals | 10s intervals (faster testing) |
| OTEL | Shared host Alloy at `:4317` | Local Alloy sidecar |
| Paperless | Managed separately (external instance) | Local container (postgres + redis) |
| Images | Deployment-managed builds (git commit tagged) | Local Docker build |
| Secrets | External secret management or env injection | Local `.env` file |

## Testing

Unit test rules for bun tests live in `claude-code/channels/CLAUDE.md`. E2E pytest rules for the `tests/` folder live alongside them in `tests/README.md`.

### E2E Pipeline Tests

`tests/` contains a pytest suite that exercises the full email processing pipeline end-to-end (Gmail, Outlook, download link flows). Tests send real emails, wait for the pipeline to process them, and verify results in Paperless.

**Location:** `compose.stacks/infra/personal-assistant/tests/`

| File | Purpose |
|------|---------|
| `test_email_gmail.py` | Gmail attachment pipeline (invoice, fuel, credit note, bank statement, ignore) |
| `test_email_outlook.py` | Outlook attachment pipeline (same set) |
| `test_email_link.py` | Outlook download link pipeline (Alza-style HTML email with invoice URL) |
| `helpers.py` | Gmail sending, Drive helpers (DriveTestClient), Paperless API verification, email-poller / gdrive-poller DB polling |
| `conftest.py` | Fixtures for pipeline reset (stop claude-code, wipe DBs + Paperless, restart, seed) |
| `test_data/` | Committed test PDFs: invoice.pdf, fuel_invoice.pdf, refund.pdf, account_statement_locked.pdf |

**Running:**
```bash
cd compose.stacks/infra/personal-assistant

# All tests (11 tests, ~5-10 min total)
python -m pytest tests/ -v --timeout=300

# Single module
python -m pytest tests/test_email_gmail.py -v -x --timeout=300

# By marker
python -m pytest tests/ -v -m gmail --timeout=300
```

**Prerequisites:** Local compose stack running (personal-assistant + Paperless), Gmail OAuth token, Outlook auth active. See `tests/README.md` for full setup.

### Unit & Integration Tests

~370 tests across 20 test files covering all channels, workers, and DB modules. Run with Bun:
```bash
cd claude-code/channels
bun test
```

| Test file | Scope |
|-----------|-------|
| `claude-code/channels/invoice-worker.test.ts` | Invoice/scan intake with mocked MCP calls |
| `claude-code/channels/workflow-lifecycle.integration.test.ts` | Full job lifecycle (create → execute → complete/fail) |
| `claude-code/channels/workflow-mcp.test.ts` | Read-only debug tools (`get_recent_emails`, `get_email_stats`, `get_gdrive_scan_*`) |
| `claude-code/channels/download-helper.test.ts` | File reading, PDF decryption |
| `claude-code/channels/invoice-links.test.ts` | Invoice link extraction from HTML |
| `claude-code/channels/workflow-db.test.ts` | Job queue SQLite operations (legacy copy; canonical lives in `pollers/lib/`) |
| `claude-code/channels/fuzzy-match.test.ts` | Correspondent fuzzy matching |
| `claude-code/channels/paperless-fields.test.ts` | Paperless custom field registry |
| `claude-code/channels/workflow-core.test.ts` | Job dispatch logic |
| `claude-code/channels/workflow-classification.test.ts` | Classification state transitions, submit_classification idempotency |
| `claude-code/channels/workflow-resume.test.ts` | Step-level resume via getCompletedSteps |
| `claude-code/channels/invoice-pipeline.test.ts` | Pure pipeline functions (merge, tags, title, month_tag) |
| `pollers/lib/email-db.test.ts` | Email SQLite operations (audit DB) |
| `pollers/lib/gdrive-db.test.ts` | GDrive SQLite operations |
| `pollers/lib/email-watcher-utils.test.ts` | Pure parsing functions (Gmail IDs, duration, metrics) |
| `pollers/lib/watcher-runtime.test.ts` | Health server / managed MCP client / poll loop helpers |
| `pollers/lib/workflow-db.test.ts` | Job queue schema (canonical) |
| `pollers/lib/workflow-schemas.test.ts` | Runtime validators |
| `pollers/email-poller/src/main.test.ts` | INITIAL_LOOKBACK seeding + fail-loud overflow guard |
| `pollers/email-poller/src/main.integration.test.ts` | Email polling, dedup, direct job creation |
| `pollers/email-poller/cli/skip-catchup.test.ts` | Operator escape hatch CLI |
| `pollers/gdrive-poller/src/main.test.ts` | scan_intake job creation, MAX_NEW_PER_CYCLE cap |
| `pollers/gdrive-poller/src/main.integration.test.ts` | GDrive polling, multi-folder resolution |

### CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push to main when relevant paths change:
- **channels (Bun)** — runs `bun test` for all 15 test files
- **checker-mcp (Python)** — runs `pytest test_matching.py` (116 tests)

### What's Mocked vs Real

| Component | E2E Tests | Unit/Integration Tests |
|-----------|-----------|------------------------|
| Email send | Real (Gmail API) | Mocked |
| Email-watcher polling | Real (Docker container) | Mocked |
| Claude classification | Real (Claude API, Haiku) | Mocked |
| PDF download | Real (from Google Drive / email) | Mocked |
| Paperless upload | Real (Paperless API) | Mocked (mock client) |
| Invoice matching | Real (checker-mcp service) | Real (parse + match logic) |
| Database (SQLite) | Real (container volume) | Real (in-memory / temp files) |

## Observability

Claude Code exports native OpenTelemetry metrics and events via OTLP to an Alloy instance, which forwards to Prometheus (metrics) and Loki (logs/events).

The email-poller and gdrive-poller services also push custom workflow metrics via OTLP (same pipeline as traces). These provide workflow-level visibility beyond generic Claude activity counters.

### Local Dev

```bash
docker compose --profile local --env-file .env up
```

This starts a local Alloy + Prometheus + Loki + Grafana alongside the main stack.

| Service | Local URL |
|---------|-----------|
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9091 |
| Loki | http://localhost:3101 |
| Alloy UI | http://localhost:12345 |

### Production

Production OTLP support belongs in your shared monitoring stack or OTLP receiver configuration.

Set `OTEL_ENDPOINT` in `.env` if the host Alloy isn't reachable at `http://alloy:4317` from the `claude-code` container.

Notes:
- local dev still uses `observability/alloy-config.alloy` via the `local` profile in `docker-compose.yml`
- production host config reuses the existing shared `prometheus.remote_write.prometheus_endpoint` and `loki.write.loki_endpoint` outputs
- after syncing your shared config, restart the Alloy container if needed

### Updating Grafana Dashboards

Dashboard JSON files live in `observability/dashboards/`. In a production-style deployment, mount them from your persistent Grafana dashboards path.

**After editing a dashboard JSON:**
```bash
# Copy to production Grafana (provisioner picks up changes automatically)
scp observability/dashboards/claude-code.json root@YOUR_DOCKER_HOST:/mnt/shared_configs/grafana/dashboards/claude-code.json
```

No Grafana restart needed — the file provisioner detects changes and reloads.

### Metrics (Prometheus, meter: `com.anthropic.claude_code`)

| Metric | Unit | Attributes |
|--------|------|------------|
| `claude_code_token_usage_tokens_total` | tokens | `type` (input/output/cacheRead/cacheCreation), `model` |
| `claude_code_cost_usage_USD_total` | USD | `model` |
| `claude_code_session_count_total` | count | — |
| `claude_code_lines_of_code_count_total` | count | `type` (added/removed) |
| `claude_code_active_time_seconds_total` | seconds | `type` (user/cli) |
| `claude_code_commit_count_total` | count | — |
| `claude_code_pull_request_count_total` | count | — |
| `claude_code_code_edit_tool_decision_count_total` | count | `tool_name`, `decision`, `source` |

### Email Workflow Metrics (OTLP push from `email-poller` service)

| Metric | Meaning |
|--------|---------|
| `email_watcher_emails` | Total tracked emails by `source` |
| `email_watcher_backlog` | Non-terminal jobs (queued/running/awaiting) by `type` |
| `email_watcher_attachments` | Emails with attachments by `source` |
| `email_watcher_recent_discovered` | Emails discovered in the last 24h by `source` |
| `email_watcher_jobs` | Jobs by `type` (workflow_type) and `state` |

### Invoice Worker Metrics (OTLP push from `workflow-mcp` on :8003)

| Metric | Meaning |
|--------|---------|
| `invoice_worker_correspondents_total` | Completed invoices by normalized Paperless correspondent. Counter seeded from DB at startup, incremented on each upload. Used by "Top Correspondents" dashboard panel. |
| `invoice_worker_missing_month_tag_total` | Documents uploaded without a valid YYYY-MM accounting period. Labelled by `workflow_type` (invoice_intake / scan_intake). Non-zero indicates the LLM-driven `accounting_period` resolution chain fully fell through and the document needs manual tagging in Paperless. |
| `personal_assistant_guidance_requests_total` | Jobs paused in `awaiting_user_guidance`, labelled by `reason` (`classifier_unknown`, `encrypted_pdf`, ...). Rendered as a stacked bar in Grafana panel id 41. Pairs with the `email_watcher_jobs{state="awaiting_user_guidance"}` gauge for current backlog. |

### Events (Loki, via OTel logs)

| Event | Key attributes |
|-------|---------------|
| `claude_code.api_request` | model, cost_usd, duration_ms, input/output/cache tokens |
| `claude_code.api_error` | model, error, status_code, attempt |
| `claude_code.tool_result` | tool_name, success, duration_ms, mcp_server_scope |
| `claude_code.tool_decision` | tool_name, decision, source |
| `claude_code.user_prompt` | prompt length |
| `guidance.requested` | `job_id`, `reason` — worker parked a job in `awaiting_user_guidance` |
| `guidance.received` | `job_id`, `action` — user called `provide_guidance` |
| `guidance.applied` | `job_id`, `action` — worker consumed the guidance on resume |

### Key Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` (services with `local` profile) | Local dev services (build contexts + Alloy + Prometheus + Loki + Grafana) |
| `observability/alloy-config.alloy` | Alloy OTLP receiver config (local dev) |
| your shared Alloy or OTLP config | Production telemetry receiver and scrape configuration |
| `observability/dashboards/claude-code.json` | Grafana dashboard |
| `observability/prometheus-config.yml` | Minimal Prometheus config for local dev |
| `observability/loki-config.yml` | Minimal Loki config for local dev |
