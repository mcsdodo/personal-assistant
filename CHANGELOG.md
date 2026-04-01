# Changelog

All notable changes to this project, generated from 186 commits (2026-03-25 to 2026-04-01).

This project was developed as part of a private monorepo. This changelog was generated from the original commit history when the project was extracted for open-source release.

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
- **Fuzzy correspondent matching** to prevent Paperless duplicates (Jaro-Winkler + normalization, threshold 0.92) `ced4159`
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
- **Checker-mcp web UI** (`webapp.py`) — Flask app for invoice matching view + P&L view, served at invoices.lacny.me `c103e26` `989973` `42d144d`
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
- Permanent Gmail OAuth via gmail-mcp.lacny.me `b3736cd` `bce67c5`
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
- Komodo deployment preparation `147b0c4`
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
