# Changelog

All notable changes to this project, generated from 186 commits (2026-03-25 to 2026-04-01).

This project was developed as part of a private monorepo. This changelog was generated from the original commit history when the project was extracted for open-source release.

## 2026-04-17 — Awaiting-User-Guidance Flow (Classifier Pause)

### Added
- **Worker pauses on unclear or unreadable documents and asks the operator for guidance via Telegram instead of guessing** — previously the classifier would silently hallucinate values when faced with zero-quality inputs (e.g. a password-protected bank statement ran through OCR yielded empty text and got misfiled to the wrong owner). New `awaiting_user_guidance` job state fires on two triggers: (A) classifier returned `"unknown"` for a required field, (B) PDF still encrypted after `tryDecrypt`.
- **Email intake path now calls `tryDecrypt` immediately after download** (previously only the GDrive scan path did), so encrypted attachments surface at Trigger B instead of slipping through to the classifier.
- **`provide_guidance(job_id, guidance)` MCP tool** with actions `skip | retry | fail | patch` plus optional `decrypt_password` (stored in a separate `guidance_password` job event — never co-mingled with the normal audit trail). Telegram replies route through `claude-code/CLAUDE.md` → `provide_guidance` using a stack-discipline rule (one paused job → next reply targets it).
- **72h auto-cancel + 24h Telegram reminder sweep** for jobs stuck in `awaiting_user_guidance`.
- **Observability for the pause flow** — new `personal_assistant_guidance_requests_total{reason}` counter, Loki events `guidance.requested` / `guidance.received` / `guidance.applied`, and a stacked-bar Grafana panel for pause volume by reason.

## 2026-04-15 — Scan Notification Owner Mismatch

### Fixed
- **Telegram notification showed classifier's `owner` instead of watch_folder owner for scan intake** — when a scanned document in `techlab/accounting` was classified as `owner: "personal"` by the document-classifier (e.g. fuel receipt without business identifiers), Paperless correctly received `techlab` tags (derived from the watch folder), but the Telegram notification used the raw classifier output and displayed "personal". The notification now uses `scanTagOwner` (from `watch_folder.split("/")[0]`) consistently with the tag derivation. Added regression test.

## 2026-04-14 — Checker Web UI: One-Click Accounting ZIP

### Added
- **`GET /zip?month=YYYY-MM` on the checker web UI** — downloads all Paperless documents tagged with the `accounting` tag **and** the requested `YYYY-MM` month tag as a single ZIP. Resolves both tag IDs, queries `/api/documents/?tags__id__all=<acc>,<month>` for the ID list, then POSTs `/api/documents/bulk_download/` (`content=archive`, `compression=deflated`) and streams the ZIP back to the browser as `YYYY-MM-accounting.zip`. Rendered as a `[zip]` link next to every month header on the matching view.

## 2026-04-14 — Parking-Ticket Classification

### Fixed
- **HOPINTAXI parking receipts misclassified as non-invoices** — email-classifier read subject "Your parking ticket" from `noreply@hopin.sk` as a municipal infringement notice and returned `is_invoice: false, action: ignore`, so the PDF never reached Paperless. Added a "Disambiguating the word 'ticket' / 'lístok'" section to `email-classifier.md` that distinguishes paid-service receipts (parking/transit/taxi/toll — `is_invoice: true`) from penalty/fine notices (`is_invoice: true` + `requires_review: true`) from support/helpdesk tickets (`is_invoice: false`). Added HOPINTAXI (`noreply@hopin.sk`) to the known-vendors table.

## 2026-04-12 — Payslip Classification

### Added
- **`doc_type: "payslip"`** — the document-classifier now recognizes Slovak *výplatný lístok / výplatná páska / mzdový list / vyúčtovanie mzdy / odmena konateľa* and English *payslip / pay stub / wage slip* as a first-class document kind, distinct from invoice/receipt/document `e681e88`
- **`resolveOwner(rawOwner, docType)`** in `invoice-pipeline.ts` — doc_type-aware owner resolver for the **email intake path**. Enforces "payslip → personal" regardless of what the classifier's business-identifier check produced. Applied once in `intake-worker.ts` before both `buildTagNames` and `resolveStoragePathId`, so tags and storage path always agree on the authoritative owner. The GDrive scan path is intentionally not touched — folder choice remains authoritative there `19dacab` `1c582a9`
- **`payslip → Document`** mapping in `DOC_TYPE_TO_PAPERLESS` so payslips get the generic Paperless document type and land in the `Personal Documents` storage path `99a5ee6`

### Fixed
- **Doc #416 misfiled as techlab business expense** — payslip email from the external bookkeeper (`cervenakova@dst.sk`, subject "vyúčtovanie odmeny konateľa za 03/2026") was classified as a regular invoice and tagged `[techlab, 2026-03]` because the classifier's business-identifier check matched on the Techlab s.r.o. header. Post-fix classifier returns `doc_type: payslip`, the resolver forces `owner: personal`, and tags resolve to `[personal, 2026-03]`. Doc #416 was patched directly via Paperless API (force-reprocess uploaded a duplicate that Paperless's content dedup silently dropped). Audit trail in `_tasks/_done/55-payslip-classification/04-trace.md`.
- **Telegram notification used raw classifier owner instead of resolved owner** — the notification at `intake-worker.ts:634` was passing `merged.owner` (the raw value) instead of the post-`resolveOwner` resolved value. For payslips where the classifier returns `techlab`, the notification would misleadingly show `techlab` while the document was correctly filed as `personal` `3fc8ae5`

### Changed
- **`document-classifier.md` vendor rule** no longer lists "internal payroll" as a techlab-internal doc example — that was misleading. Individual payslips are now `doc_type: payslip` with the employer as vendor `e681e88`

### Tests
- 8 new unit tests in `invoice-pipeline.test.ts` (7 for `resolveOwner`, 1 for `buildTagNames` payslip pin). Total bun channels suite: 484/484 green (1103 expect() calls).

## 2026-04-11 — Stale Job Reclamation Fix

### Fixed
- **`reclaimStaleJobs` string-comparison format bug** — the query compared `updated_at` (written by `nowIso()` in ISO `T...Z` format) against `datetime('now','-N minutes')` (space-separated format). ASCII `'T'` > `' '` made same-date ISO timestamps always sort greater than cutoffs, so the query matched zero rows and stuck `awaiting_classification` jobs never drained, even after upstream issues were resolved. Wrapped `updated_at` in `datetime()` to normalize both formats before comparison `2f68f50`
- **Test fixtures for stale reclamation** — the 5 existing `reclaimStaleJobs` tests were false-green because they used the same `datetime('now','-10 minutes')` shortcut that hid the production bug. Switched to `new Date(Date.now() - N*60*1000).toISOString()` fixtures so they match production writers, and added a test-authoring rule in `claude-code/channels/CLAUDE.md` requiring fixtures to match `nowIso()` output for columns production writes via `nowIso()` `2f68f50`

## 2026-04-07 — Pipeline Hardening

### Refactored
- **Paperless adapter unified boundary** — every Paperless operation (CRUD, upload, PATCH, custom fields, task polling) now goes through `paperless-adapter.ts`. Hides the MCP-vs-REST split from callers and adds a private `listAllPages` helper that walks every page of paginated responses — fixes a silent bug where only page 1 was seen, causing documents to end up with `correspondent: null` `6e1e60b` `9a08300`
- **Worker decomposition** — `intake-worker.ts` split into `invoice/download-service.ts`, `invoice/dedup-service.ts`, `invoice/classification-state.ts`, `invoice/postprocess-service.ts` `15e8ca8` `489d343`
- **`watcher-runtime.ts`** — shared operational scaffolding for both watchers (health server, MCP client lifecycle, poll loop) `665fcca`
- **checker-mcp `engine/` package** — `match_invoices.py` split into `models`, `parsing`, `matching`, `client`, `collection` for strict layering and testability `003df8e`

### Added
- **Typed workflow contract schemas** with runtime validation — `InvoiceIntakeInput`, `ScanIntakeInput`, `EmailClassificationResult`, `DocumentClassificationResult`. Watchers validate on job creation, worker validates on execution, submit_classification validates on write. Throws `WorkflowSchemaError` with schema/field/expected/actual `164676e`
- **Download cleanup at terminal job states** — files tracked per-job in workflow.db and auto-deleted on `completeJob` / `failJob` / `cancelJob`. Boot-time safety sweep removes orphaned files older than 7 days `e4b1c47`
- **Continuous channel liveness check** — entrypoint verifies channels stay registered throughout the session, not just at startup; healthcheck uses `pgrep` on channel processes `0d9697d` `da7b29b`
- **Explicit MCP server attachment for subagents** — the `email-classifier` subagent declares `mcpServers: [gmail, outlook]` in its frontmatter because Claude Code v2.1.92 does not inherit parent MCP tools to subagents by default. Classifier also fetches the email body itself now instead of receiving it pre-parsed `f4b6b55` `4a5a76b`

### Fixed
- **Strip stale `mcpOAuth` state on container start** — entrypoint wipes `mcpOAuth` from `.credentials.json` every boot. Workaround for [anthropics/claude-code#34008](https://github.com/anthropics/claude-code/issues/34008) where cached OAuth discovery state survives restarts and makes HTTP MCPs show `△ needs authentication` with no real recovery path `11a00eb`
- **Remove tmux-keystroke MCP reconnect script** — the old reconnect flow used `tmux send-keys` to navigate the `/mcp` menu; it raced with workflow channel notification delivery and silently interrupted in-progress jobs. Replaced by the entrypoint credentials cleanup above `0d5ab28`
- **Require `sender` in `classify_email`** — watcher must pass sender/subject/received_at in `input_json`; worker injects them from there instead of re-fetching. Real `submit_classification` errors now bubble up instead of being swallowed `03d798d`
- **Allow null `vendor` and `strategy_confidence` on `action: ignore`** — schema was previously rejecting valid ignore outputs `0fcc5bb`
- **Watcher-inject classification metadata** — removes a duplicated classification path between watcher and worker `a633c41`
- **Post-review polish** — dead exports removed, span attrs enriched, error chain tightened `a3575ae`

## 2026-04-06 — Gmail MCP Auth Sidecar & Force Reprocess

### Added
- **Caddy auth sidecar for gmail-mcp (v2 — internal too)** — Claude's own gmail MCP now goes through the same bearer-token sidecar as any external caller. The sidecar passes `/oauth2callback` through unauthenticated so the Google OAuth flow still works `91a88bb` `cb93ecf`
- **`force=true` reprocessing now PATCHes existing Paperless docs in place** — under `force: true`, the worker re-runs the full pipeline and PATCHes the existing doc with fresh metadata instead of rejecting on dedup hit. Preserves doc id, PDF, OCR, and thumbnail; emits `outcome: refreshed` and sends a dedicated Telegram notification `0fae894`
- **LLM-driven invoice accounting period** — `accounting_period` resolution uses the document classifier's `YYYY-MM` output first and falls back to the deterministic chain only when unavailable or invalid. Prometheus counter `invoice_worker_missing_month_tag_total` surfaces fall-through cases for manual tagging `f4843ce`
- **Claude Code 2.1.92 pinning + self-heal** — entrypoint pins the CLI version, detects missing channels on boot, and disables the claude.ai-hosted MCPs (gmail/gcal proxies) that aren't used by this stack `88dfed2`
- **Automated HTTP MCP reconnect in entrypoint** — boot-time logic detects HTTP MCPs stuck in "needs authentication" and recovers them without keystroke races `2680406` `994a72f` `d10257a` `64e7203`

### Fixed
- **Outlook attachment + GDrive download size caps** — both download paths now enforce hard size limits to prevent runaway reads `569ad30`
- **email-watcher zero backlog emission** — both workflow types always emit a fresh zero when empty, so Prometheus sees live samples instead of stale values `5405d75`
- **Dashboard metric names** — updated to OTLP canonical form (dropped `_total` suffix after push migration) `7e4bc20`

## 2026-04-05 — OTLP Metric Migration & Test Infra Cleanup

### Changed
- **email-watcher and gdrive-watcher push metrics via OTLP** instead of exposing a scrape endpoint. Custom workflow metrics (`backlog`, `jobs{state,type}`, `attachments`, `recent_discovered`) flow through the same OTel pipeline as traces `218ffdb` `af1cb59`
- **Drop `status` field from `emails.db` and `gdrive.db`** — workflow job state in `workflow.db` is now the single source of truth. Watcher tables are a pure audit trail `c0d4364` `7d8b0d4` `2dc8692`
- **Grafana dashboards rewritten around job-based metrics** — panels use `email_watcher_jobs{state,type}` and `email_watcher_backlog{type}` instead of dead status-based queries `31069ac`
- **Constant OTel span names** for dashboard TraceQL search (no more interpolated values breaking saved queries) `3febd6c`

### Added
- **Enriched upload + `set_fields` OTel spans** with correspondent, doc type, storage path, tag IDs, and outcome `c76e12e`
- **Public docs: design decisions, data contracts, traces, scan flow** for open-source readers `2db27f7`

### Fixed
- **Link E2E tests** — diacritics in HTML template, dynamic title assertion, unskipped after repairs `9b15f04` `0082de9`
- **CI test isolation** — `mock.module('./db')` was polluting `db.test.ts`; switched to real SQLite, inlined `openDb` in the test to bypass, fixed `DOWNLOAD_DIR` propagation `a299e28` `ffdbe82` `2a1f4f6`
- **Replaced SSH-based PDF server with a local Docker container** in E2E fixtures — removes the SSH dependency that broke CI `df3d68e`
- **outlook-mcp JSON array handling** — return arrays as strings to avoid FastMCP single-element flattening; handle single-element unwrap in attachment paths `5593cbc` `ca53b29`
- **Remove `retryStuck` paths** in both watchers — workflow jobs handle stuck items now `1e0ffed` `ac1942b`

## 2026-04-04 — Pipeline V2: Worker-as-Orchestrator

Largest architectural change in the public repo to date. Worker now owns the entire invoice/scan pipeline end-to-end; watchers just create jobs; classification is non-blocking via channel roundtrip.

### Added
- **`awaiting_classification` state + `submit_classification` tool** — worker parks a job and sends a channel notification; Claude runs the haiku subagent and submits the result back via the workflow MCP. Worker resumes on the next poll tick without blocking on Claude `2431dab`
- **Worker owns classification** — `classify_email` and `classify_document` are driven by the worker via channel notifications instead of happening eagerly in the watcher or orchestrator `e7f8dbb` `b670887`
- **Step-level resume** — `getCompletedSteps` lets the worker skip already-completed steps on retry, making re-runs idempotent `aa64206`
- **Paperless storage paths + taxonomy redesign** — invoices and scans routed to storage paths by `owner` (techlab vs personal) and document type. Three-part filter (accounting tag + `Invoice` type + NOT `account-statement`) replaces brittle legacy queries `f903112` `2966ddd`
- **`force=true` flag for job creation** — replaces the old `create_job` / `retry_job` tools. Reprocessing always follows the same pipeline as automatic processing, no manual inspection path `0b9980c` `cd2070b` `df8377c`
- **Invoice link persistence** — shared `invoice-links.ts` module used by both email-watcher and `invoice/download-service`. Gmail MCP HTML truncation raised from 20k → 100k to recover links from long HTML emails `3ce12be` `794f0c0`
- **Stale job detection primitives** — DB-level stale tracking and a 3-tick channel roundtrip E2E test `c217fd3`
- **Trace context propagation from watchers through jobs to worker** — each job gets its own root span so multi-file incidents don't collapse into a single trace in Tempo `688e0b9`
- **email-watcher creates `invoice_intake` jobs directly in `workflow.db`** — no round-trip through Claude for new-email detection. Channel notifications are now only used for startup events (`first_start`, `catchup_required`) `7d3519d`
- **Scan intake migrated to worker-as-orchestrator** — same pattern as email `1302b52`

### Refactored
- **workflow-mcp converted from HTTP to stdio channel** — channels are subprocesses of Claude Code, so stdio is a natural fit and removes the need for a separate HTTP server `43be7ac`
- **Pure pipeline functions extracted** to `invoice-pipeline.ts` — `mergeClassifications`, `resolveMonthTag`, `buildTagNames`, `generateTitle`, `getCompletedSteps` — all testable without mocks `760c853`
- **Simplified job creation API** — `create_invoice_intake_job(email_source, message_id, force?)` replaces the old multi-param constructor `5da8f36`
- **Removed backward-compat classification path** — only V2 (worker-driven) remains `4ab7487` `068e4f3`

### Fixed
- **Scan `month_tag` inferred from `doc_date`** (document classifier output) instead of the hard scan date. Classifier's `accounting_period` wins when present `5d3d180`
- **email-watcher cursor advancement** — don't advance `last_checked` when a poll fails with auth error, preventing silent email loss during outages `86c376f`
- **email-watcher poll errors reported via OTel span status** (not just logs) so failures are visible in Tempo `a6aa67a`
- **Download resume + strategy handling** + production flow tests `0d28521` `0afd17b`
- **Pipeline: fail on missing `owner`** (previously silently accepted null); fuzzy threshold lowered to 0.85 to catch EN/SK vendor variants; retry instructions clarified `aa2e087`

### Tests
- **E2E tests poll `workflow.db` instead of email status** — matches the new architecture where workflow.db is the source of truth `60331ac`
- **Direct watcher job creation + idempotency tests** for both email-watcher and gdrive-watcher `1833185` `686e22d`

## 2026-04-03 — Security Hardening & `file-ops` MCP

### Added
- **`file-ops` MCP** — scoped file operations for `/workspace/downloads/` replace dangerous Bash wildcards in Claude's allowlist. Exposes `download_file`, `delete_file`, `list_files`, `decrypt_pdf`, `read_base64`, `get_env` behind a strict path prefix `9201046`
- **Caddy auth sidecar for gmail-mcp (initial)** — removes direct LAN exposure; the upstream MCP is now only reachable through Caddy with a bearer token on `/mcp*`, while `/oauth2callback` stays public for the Google OAuth flow `5e7b3cc` `bb4e0f2`
- **Zero-fill metric gauges** — `emitWithDefaults` helper ensures `recent_discovered_total`, `backlog`, etc. always emit samples for every source/type, even when zero, preventing stale Prometheus values during idle periods `a95dbe5` `cc20743` `b52861d`

### Fixed
- **Watchtower exclusion label** — use the correct `com.centurylinklabs.watchtower.enable: "false"` form, increase poll interval to 6h `7bd18a6`
- **`file-ops` startup guard** — `import.meta.main` guard prevents the MCP from running when imported as a library `43a69e1`
- **Bash(ls) allow rule removed** — `list_files` MCP tool covers the legitimate use case `b2feb63`

### Docs
- **Public docs use `.lan` placeholders** — matches the infrastructure the stack is actually designed for `55f9eef`

## 2026-04-02 — Classification Tracing & Setup Guide

### Added
- **Classification step tracing** — `classify_email` and `classify_document` get their own OTel spans, merged into the email workflow dashboard `263fd5d` `336512c`
- **Vendor + outcome on trace span names** — final upload spans carry vendor and outcome attributes so Tempo can filter by them without TraceQL interpolation `bd93468`
- **Comprehensive setup guide** — covers OAuth, Telegram bot pairing, HA token, deployment, and local dev with the `local` profile `1b41a31` `ff460a5`
- **Rate-limit watchdog in entrypoint** — detects Anthropic API rate limits and restarts the session before the channel state goes dead `bd7f402`

### Fixed
- **Pipeline: fail on missing owner**, lower fuzzy threshold to 0.85, tighten retry instructions `aa2e087`
- **Tempo datasource UID** in observability config (was pointing at the local-dev UID in production) `792abac`

### Docs
- **Mandatory documentation updates after implementation** — CLAUDE.md policy `a15c4a3`

## 2026-04-01 — Testing, Retry Logic & Architecture Cleanup

### Added
- **MCP client retry logic** — exponential backoff (1s→2s→4s, 3 retries) for transient network errors (DNS, connection refused) in invoice-worker HTTP calls `979dea4`
- **Integration test suite** — email-watcher, workflow lifecycle, gdrive-watcher integration tests `0391263`
- **147 unit tests** covering email-watcher, gdrive-watcher, scan intake, tryDecrypt `1b85de1`
- **CI pipeline** — GitHub Actions running Bun tests (15 files) + pytest (113 tests) on push `cc19c78`

### Refactored
- Convert workflow-mcp from stdio to HTTP server on :8003 `0f73fa0`
- Extract pure functions to `email-watcher-utils.ts` for testability `1a03c52`
- Merge compose overlay into single file with `local` profile, eliminate `local/` directory `a6de93e`

### Fixed
- Process all catchup emails instead of silently dropping after first batch `f14099d`
- Resolve all test failures — remove poisoning mock, fix stale db imports `61460a8`
- Resolve bun executable cross-platform in tryDecrypt tests `116de14`
- Use env-derived folder names in gdrive-watcher integration tests `a6b0e8a`
- Provide 4 fetch handlers for retry test (1 initial + 3 retries) `e9b9c78`
- Slim E2E to 3 smoke tests, fix isolation issues `1157996`

## 2026-03-31 — Catchup Model & Open-Source Prep

### Added
- **Checkpoint-based polling** — replace per-source `seed` status with `source_state.last_checked` timestamps, `first_start` and `catchup_required` startup events `a84550a` `46ac90b`
- **Catchup tools** — `init_source`, `approve_catchup`, `skip_catchup` for user-controlled startup behavior `a84550a`
- Open-source preparation — audit, changelog, gitignore `ce3527b`

### Fixed
- Preseed source_state before container start, handle single-email Outlook response `e84701d`
- Preseed both sources in all test fixtures to prevent Telegram blocking `a5f3e2a`
- Skip polling for sources with pending catchup approval `8da1d3f`
- Restore paperless volume paths to `./local/data/` in local compose `817de99`

### Refactored
- Move app source dirs out of `local/` in personal-assistant `774bcc3`

### Chores
- Remove mail reader POC files and configuration `6e0655a`
- Anonymize PII in test data PDFs `d5b7359`

## 2026-03-31

### Fixed
- Skip Gmail emails that return error instead of content (404 ghosts) `e39c8c1`
- Deduplicate Prometheus metrics, enable admin API, fix dashboard queries `161f070`
- Replace confidence bar gauge with pie chart, remove latency panel `dce33b9`

### Added
- `claude_download` strategy for email attachments — allows Claude to download attachments directly when MCP tools fail `15a8bec` `4d59acd`

### Improved
- Document-classifier now uses doc_type based on actual document content, not just buyer credentials `5143451`
- Use counter with DB seeding instead of observable gauge for correspondents metric `7027429`
- Add OTel metrics to personal-assistant, replace scraped vendor metric with OTLP gauge `e888636`

## 2026-03-29

### Added
- **Fuzzy correspondent matching** to prevent Paperless duplicates (Jaro-Winkler + normalization, threshold 0.85, lowered from 0.92 to catch EN/SK vendor name variants) `ced4159` `aa2e087`
- **Gmail invoice link extraction** — shared `invoice-links.ts` module for extracting download links from HTML emails (Alza, generic patterns) `ac7a506` `9a9e1ff`
- **Owner-aware tag derivation** — `document-classifier` returns `owner` field (techlab|personal), invoice-worker routes tags accordingly `7aa5761` `53f5a05` `5321500`
- **Owner field** in document-classifier prompt for business vs personal document routing `532150`
- Subtitle field in classifier output, improved invoice/receipt classification rules `733a09e`
- Expanded Paperless document types, removed redundant `doc_type` from email-classifier `7df966e`
- Multi-folder GDrive watcher with level-based tags `4f0ae3b`
- Checker-mcp test suite restored with CI workflow `4e5a1a7`

### Fixed
- Skip Gmail API calls for known emails, add local-blocks to Tempo `4d497a5`
- Update invoice-worker tests to match current code paths `79535ef`
- Update Account Statement type name in checker, harden classifier rules `9b7255f`
- Improve document-classifier prompt for parking tickets and license plates `138616b`
- Verify Gmail link e2e test checks Paperless directly `32d9df6`
- Lowercase GDrive folder names (techlab/invoices/processed/errors) `c7639fa`

### Removed
- `suggested_tags` from types, workflow-mcp, tests, and email-classifier prompt `3a5fbd4` `9fe78be`
- Dead paperless checker copy `c010d82`

## 2026-03-28 — Unified Document Classifier & E2E Tests

### Added
- **E2E pytest test suite** for the full email pipeline (Gmail, Outlook, download link flows) `d1caded`
- **Download helper** for email attachment download + encrypted PDF decryption via qpdf `1e00bc2` `564c813`
- **Durable workflow MCP** with synthetic worker for processing pipeline `345f675` `c854325`
- **PaperlessFieldRegistry** for dynamic custom field resolution by name `77d3004` `7bea86a`
- Auto-create Processed/Errors folders on GDrive `f9cd3c0`
- Local file cleanup step to scan pipeline `11135fc`
- `BANK_PDF_PASSWORD` env var + local OAuth redirect `d6c88dc`

### Fixed
- Outlook MCP: match invoice link rules by subject, add toRecipients for recipient filtering `782fd1b` `4b68136`
- Email-classifier: use `has_attachments` to pick download strategy `9d1f967`
- Email-watcher: Gmail poll missed new emails due to sparse search parsing `5475b52`
- Invoice-worker: dedup uses direct Paperless API instead of MCP search `e68e74d`
- Invoice-worker: handle paginated Paperless MCP responses `64e6e1c`
- Upload directly to Paperless API, bypass MCP size limit `4058ae8`
- Download GDrive files as binary for Paperless upload `78bd200`
- Deterministic tags, custom fields via Paperless API `dc69148`
- Enforce classifier schema, auto-create GDrive subfolders `b0ac212`
- Handle missing `suggested_tags` in scan classification `f13b794`
- Fix `post_document` field names for Paperless MCP `38c30f6`
- Fix scan classification and approval gates `6b6bb83`
- Parse human-readable text output from Drive MCP tools `bab1ce3`
- Add `user_google_email` to all Drive API calls `3629854`
- Document-classifier: prefer document's own number for `order_id` `c941c0a`
- Add order_id custom field (ID 4) to Paperless uploads `617254f`
- Health check timeout, retry stuck emails `887db9c`

### Refactored
- Renamed `scan-classifier` → `document-classifier` `34885158`
- Renamed `invoice-processor` → `document-processor` `3e60333`
- Thread PaperlessFieldRegistry through worker pipeline `7bea86a`
- Improved classifier prompts and removed dead document-processor `8b1a3cf`
- Aligned doc_type taxonomy across scan-classifier, document-processor, and worker `04cf733`

## 2026-03-27 — GDrive Watcher & Checker Web UI

### Added
- **GDrive watcher channel** — polls Google Drive folders, classifies scanned documents, uploads to Paperless with tag routing `9142f1c` `30ebb01`
- **Checker-mcp web UI** (`webapp.py`) — Flask app for invoice matching view + P&L view, served behind a reverse proxy such as `invoices.lan` `c103e26` `989973` `42d144d`
- Invoice intake worker with MCP client and unit tests `82b8ba3`
- Phase 0 boundaries and reintroduce workflow MCP `c854325`
- Caddy labels and Flask port for checker-mcp `77487a1`

### Fixed
- `notify_user` failure must record status=failed `26225121`
- Health check timeout, retry stuck emails `887db9c`
- Remove metadata-less fallback, retry stuck emails `cd38dd9`
- Remove seeding logic from gdrive-watcher `3e97620`
- Add gdrive-watcher to channel loading in entrypoint `49d5885`
- Lower gdrive-watcher poll interval to 30s `e573a39`

## 2026-03-26 — Core Pipeline & Deployment

### Added
- **Email-watcher channel** — real Gmail + Outlook polling with SQLite audit trail `07a90db` `63158f4` `59c1393`
- **Observability stack** — Alloy + Prometheus + Loki + Grafana for Claude Code telemetry and email workflow metrics `683ec1f` `bb87194`
- **Telegram two-way channel** (Phase 1.3) `ed68392`
- **Gmail-mcp + Outlook-mcp** integration (Phase 1.2) `e96d5a0`
- **Paperless-mcp + Checker-mcp** integration (Phase 1.1) `bdcf537`
- Permanent Gmail OAuth via a callback domain such as `gmail-mcp.lan` `b3736cd` `bce67c5`
- Email recipient filtering (whitelist/blacklist) `506b20a`
- Alza invoice patterns + defensive download + downloads volume `b2ef45f`
- Model optimization — Sonnet main + Haiku subagents `d77dde5`
- Fuel tag instead of custom field for fuel invoices `8ebf459`
- Remote control alongside channels in Docker `7bd1897`
- Use-case index for project documentation `a1c8688`

### Fixed
- Per-source seeding to prevent false notifications `d2a30cc`
- Auto-accept dev channels prompt for headless Docker operation `20272bf`
- POC validated — channels + MCP tools working in Docker `13c9eda`
- Generalize email-classifier beyond Alza-specific patterns `3ac05f5`
- Replace generic category with `is_fuel` flag in classifier `50064b3`

### Deployment
- deployment workflow preparation `147b0c4`
- Reorganize into `local/` folder structure `a927412`
- Health checks for all services, version pinning, stateless MCP `d2705ce`
- Revert paperless-mcp to `:latest` (pinned SHA was broken) `52e959d`
- Disable watchtower for locally-built images `d285aa4`

### Refactored
- Move agent definitions from `.claude/` to `agents/` (copy on build) `63bd2a8`
- Align agents with existing Paperless taxonomy `e10075a`

## 2026-03-25 — Project Inception

### Added
- **Initial POC scaffold** — Claude Code Channels + mock MCP architecture validated in Docker `ab24e12`

---

## Architecture Evolution

| Date | Milestone |
|------|-----------|
| Mar 25 | POC: Claude Code + Channels + MCP tools in Docker |
| Mar 26 | Phase 1.1–1.3: Paperless, Gmail/Outlook, Telegram integration |
| Mar 26 | Email-watcher with SQLite audit trail, observability stack |
| Mar 27 | GDrive watcher, checker web UI, invoice intake worker |
| Mar 28 | Unified document-classifier, E2E test suite, PDF decryption |
| Mar 29 | Fuzzy matching, owner-aware tags, Gmail link extraction |
| Mar 31 | OTel metrics, claude_download strategy, dashboard fixes |
| Mar 31 | Checkpoint-based polling (replaces seed model), open-source prep |
| Apr 1  | MCP retry logic, 300+ unit/integration tests, CI pipeline, workflow-mcp HTTP |

## Stats

- **186 commits** over 8 days
- **5 containers**: claude-code, checker-mcp, gmail-mcp, outlook-mcp, paperless-mcp
- **3 channels**: email-watcher, gdrive-watcher, telegram
- **2 subagents**: email-classifier (Haiku), document-classifier (Haiku)
- **~300 unit/integration tests** across 15 test files + 113 pytest tests (CI via GitHub Actions)
- **Full observability**: Prometheus metrics, Loki logs, Grafana dashboards
