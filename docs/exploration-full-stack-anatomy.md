# Personal Assistant Stack — Full Anatomy

**Generated:** 2026-03-31
**Purpose:** Comprehensive exploration of the entire personal-assistant stack: structure, source code, testing, deployment, and architecture.

---

## 1. PROJECT STRUCTURE

```
personal-assistant/
├── CLAUDE.md                    # Main stack documentation
├── CHANGELOG.md                 # 166 commits, 7 days dev history
├── docker-compose.yml           # Production stack (5 services)
├── checker-mcp/                 # Invoice matching engine
│   ├── match_invoices.py       # 1300+ lines: statement parsing, invoice extraction, matching algo
│   ├── server.py               # FastMCP wrapping match_invoices
│   ├── webapp.py               # Flask web UI (invoices.lacny.me)
│   ├── test_matching.py        # 300+ tests with mocked Paperless
│   ├── test_golden.py          # Golden file regression test
│   └── Dockerfile              # python:3.12-slim
├── outlook-mcp/                 # Outlook read-only MCP server
│   ├── server.py               # MSAL device code auth, 4 tools
│   └── Dockerfile              # python:3.12-slim
├── claude-code/                 # Main Claude Code container
│   ├── Dockerfile              # node:20-slim, bun, Claude Code CLI
│   ├── .mcp.json               # MCP config (7 servers)
│   ├── CLAUDE.md               # Instructions for Claude session
│   ├── entrypoint.sh           # tmux wrapper + prompt detection
│   ├── channels/               # TypeScript/Bun
│   │   ├── email-watcher.ts   # Gmail + Outlook polling, SQLite audit trail
│   │   ├── gdrive-watcher.ts  # Google Drive polling
│   │   ├── invoice-worker.ts  # Durable job processor (68 unit tests)
│   │   ├── workflow-mcp.ts    # Job queue + state machine
│   │   ├── telegram/          # Official Telegram plugin
│   │   ├── db.ts              # SQLite schema + migrations
│   │   ├── download-helper.ts # Attachment download + PDF decryption
│   │   └── [test files]       # Comprehensive unit tests
│   └── agents/
│       ├── email-classifier.md      # Haiku: classify email vendor, strategy
│       └── document-classifier.md   # Haiku: extract vendor, amount, doc_type from PDF
├── .env.example                 # Local secrets template
├── observability/               # Local dev Alloy, Prometheus, Loki, Grafana configs
├── data/                        # Local dev data (gitignored)
├── docs/
│   ├── USE_CASES.md           # Implementation status index
│   ├── infrastructure.md       # Build, deploy, auth, health
│   ├── uc1-invoice-processing.md
│   ├── uc1a-observability.md
│   └── uc2-invoice-matching.md
└── tests/                      # End-to-end pytest suite
    ├── test_email_gmail.py     # 5 tests: attachment pipeline
    ├── test_email_outlook.py   # 5 tests: Outlook pipeline
    ├── test_email_link.py      # Download link strategy
    ├── helpers.py              # Gmail API, Paperless API, DB polling
    ├── conftest.py             # pytest fixtures
    └── test_data/              # Committed PDFs (invoice, fuel, refund, statement)
```

---

## 2. ARCHITECTURE AT A GLANCE

**5 Docker containers in one stack:**

1. **claude-code** (node:20-slim)
   - Claude Code Sonnet session with `--remote-control`
   - Runs 4 stdio channels (email-watcher, gdrive-watcher, telegram, workflow-mcp)
   - Connects to 4 HTTP MCP servers
   - Metrics endpoint `:9465`

2. **checker-mcp** (python:3.12-slim)
   - FastMCP on `:8001/mcp` + Flask web UI on `:5000`
   - Invoice matching against bank statements
   - 4 tools: `match_invoices`, `match_invoices_range`, `get_pl_summary`, `get_month_status`
   - Stateless HTTP (`FASTMCP_STATELESS_HTTP=true`)

3. **outlook-mcp** (python:3.12-slim)
   - FastMCP on `:8002/mcp`
   - MSAL device code auth (cached token)
   - 4 tools: `list_emails`, `get_email`, `get_attachments`, `download_attachment`
   - Read-only access to Outlook mailbox

4. **gmail-mcp** (ghcr.io/taylorwilsdon/google_workspace_mcp:1.16.2)
   - Pinned to 1.16.2 (semver available)
   - FastMCP on `:8000/mcp`
   - Gmail + Google Drive tools
   - OAuth via `gmail-mcp.lacny.me` Caddy route

5. **paperless-mcp** (ghcr.io/baruchiro/paperless-mcp:latest)
   - Community image, no semver tags
   - `:3000/mcp` — 20 CRUD tools
   - Watchtower excluded, manually updated

---

## 3. CLAUDE.MD & PROJECT INSTRUCTIONS

The **CLAUDE.md** in the root is the master reference. Key directives:

### MCP Servers
- **paperless**: Full Paperless-ngx CRUD (search, post, bulk_edit, custom fields, tags)
- **checker**: Invoice matching (match_invoices, match_invoices_range, get_pl_summary, get_month_status)
- **gmail/outlook**: Email read + attachment download
- **email-watcher** (channel): Pushes events when emails arrive; tools for status recording
- **gdrive-watcher** (channel): Pushes events from Google Drive scans
- **workflow** (channel): Durable job creation and polling

### Email Processing Pipeline (high-level)
1. Email-watcher detects new email from Gmail/Outlook
2. **Classify** with `email-classifier` Haiku (vendor, strategy, action)
3. **Download** PDF (attachment or link extraction)
4. **Classify PDF** with `document-classifier` Haiku (vendor, amount, doc_type, owner)
5. **Create job** -> `create_invoice_intake_job` (workflow MCP)
6. **Monitor** -> poll `get_job()` until completed/failed/awaiting_approval
7. **Record** -> `update_email_status` with final status

### GDrive Processing Pipeline
- Similar: detect new file -> classify -> create `create_scan_intake_job` -> monitor -> record
- `month_tag` derived from file creation date (hard rule)
- Files moved to `processed/` or `errors/` folder after upload

### Key Actions
- `action: download_and_upload` -> create durable workflow job
- `action: notify_user` -> Telegram notification, wait for approval
- `action: ignore` -> silent, no notification

---

## 4. DOCKER COMPOSE FILES

### **docker-compose.yml** (Production)
- 5 services (claude-code, checker-mcp, gmail-mcp, outlook-mcp, paperless-mcp)
- All use `restart: unless-stopped`
- `claude-code` depends on all MCPs via `depends_on: service_healthy`
- Health checks on all services (tmux + curl for claude-code; TCP for others)
- Volumes mount to NAS at `/mnt/shared_configs/personal-assistant/`
- OpenTelemetry config (OTEL_EXPORTER_OTLP_* env vars)
- All labeled `com.centurylinklabs.watchtower.monitor: "false"` (no auto-updates)
- Caddy labels on checker-mcp (invoices.lacny.me) and gmail-mcp

### **docker-compose.yml** — `local` Profile Services
- Adds `build:` contexts for claude-code, checker-mcp, outlook-mcp
- Overrides volumes to local `./data/` directories
- Adds observability: Alloy, Prometheus, Loki, Tempo, Grafana
- Runs local Paperless (postgres + redis + paperless-ngx container)
- Faster polling: `POLL_INTERVAL_MS=10000` (10s instead of 30s)

---

## 5. TESTING SETUP

### E2E Pipeline Tests (`tests/`)

**Structure:**
- `conftest.py`: Fixtures for pipeline reset (stops claude-code, wipes DBs, restarts, seeds)
- `helpers.py`: Gmail API, Paperless API, email-watcher DB polling
- `test_email_gmail.py`: 5 tests (invoice, fuel, credit note, bank statement, non-invoice)
- `test_email_outlook.py`: 5 tests (same scenarios via Outlook)
- `test_email_link.py`: Download link strategy (HTML email extraction)
- `test_data/`: Committed PDFs (invoice.pdf, fuel_invoice.pdf, refund.pdf, account_statement_locked.pdf, personal.pdf)

**What's Tested:**
- Full pipeline: email send -> detection -> classification -> download -> upload -> Paperless verification
- Both Gmail and Outlook sources
- Attachment downloads, encrypted PDF decryption, duplicate detection
- Tag routing (invoicing, fuel, personal, techlab)
- Correspondent normalization (Alza.sk s.r.o., Slovnaft, Tatra banka)
- Order ID extraction and custom field population

**Prerequisites:**
- Local compose stack running (both personal-assistant and separate Paperless)
- Gmail OAuth token (`C:\_dev\invoice-automation\config/token.json`)
- Outlook auth active (device code flow)
- Python deps: pytest, requests, google-auth, google-api-python-client

**Run:**
```bash
python -m pytest tests/ -v --timeout=300
python -m pytest tests/test_email_gmail.py -v -x --timeout=300
```

### Unit Tests (Invoice Worker)

**Location:** `claude-code/channels/*.test.ts`

**Coverage:**
- `email-watcher.test.ts`: Poll logic, status tracking, metrics
- `invoice-worker.test.ts`: 68 tests covering invoice classification, vendor matching, tag derivation, Paperless upload
- `db.test.ts`: SQLite migrations, state transitions
- `download-helper.test.ts`: PDF download, encryption detection, qpdf wrapping
- `fuzzy-match.test.ts`: Jaro-Winkler matching for fuzzy correspondent matching
- `paperless-fields.test.ts`: Dynamic custom field resolution
- `workflow-core.test.ts`: Job state machine

**Mocking Strategy:**
- MCP calls mocked via `test-preload.ts` (dependency injection)
- Real database operations (SQLite in-memory or temp files)
- Paperless API calls mocked

**Run:**
```bash
cd claude-code
bun test
```

### Unit Tests (Invoice Matching)

**Location:** `checker-mcp/test_matching.py`

**Coverage:**
- Pure function tests: amount parsing, normalization (comma/dot decimals, space thousands)
- Month arithmetic (month_offset, get_month_window)
- Filename prefix extraction
- Amount extraction from invoice text (regex patterns for different formats)
- Statement parsing (Tatra Banka format: date, description, amount, original currency)
- Skip rules (bank fees, loan principal, taxes, dividends, insurance, payroll)
- Invoice pairing (by filename prefix or title similarity, cross-sign pairing)
- Month collection logic (movement-to-invoice matching with +/-1 month window)
- Global matched ID tracking across months

**Golden File Test:**
- `test_golden.py`: Regression test comparing current matching results against `test_golden.json`
- Run against real Paperless instance (production data validation)

**Mocking:**
- PaperlessClient mocked with tag/field ID mappings
- Documents created via helper functions (_make_invoice, _make_statement)
- No real API calls in unit tests

---

## 6. SOURCE CODE ORGANIZATION

### **checker-mcp/match_invoices.py** (1300+ lines)

**Sections:**
1. **Configuration** (lines 30-101)
   - Document type: "Account Statement"
   - Skip rules (bank fees, loans, taxes, dividends, insurance, payroll)
   - Paperless config

2. **Paperless API client** (lines 110-169)
   - `_get_paginated()`: Handle pagination
   - `get_document_type_id()`, `get_custom_field_id()`, `get_tag_id()`
   - Tag caching

3. **Statement parsing** (lines 172-283)
   - Regex for Tatra Banka format (date.amount, debit/credit sign)
   - Page break handling
   - Opening balance detection
   - Foreign currency original amount extraction
   - Returns: `{date, description, amount, orig_amount, raw_block}`

4. **Amount extraction** (lines 299-387)
   - Multiple regex patterns (base amounts, space-thousands near keywords, currency symbols)
   - Normalization for comma/dot decimals, space/comma thousands
   - Handles OCR artifacts

5. **Month arithmetic** (lines 391-407)
   - `month_offset()`: Add/subtract months
   - `get_month_window()`: +/-1 month window

6. **Invoice pairing** (lines 410-518)
   - Filename prefix matching (first 8 digits/letters)
   - Title similarity (prefix matching + Jaro-Winkler fuzzy match)
   - Cross-sign pairing (invoice + dobropis/refund)
   - Bidirectional mapping

7. **Main logic** (collect_month, collect_pl, filter_resolved_unmatched)
   - Fetch statement + invoices for month
   - Match movements to invoices
   - Rank by same month (preferred), then window months
   - Handle ambiguities (multiple matches -> manual review)
   - P&L categorization for skip rules

### **checker-mcp/webapp.py** (200+ lines)

**Features:**
- Flask app on `:5000`
- Matching view: terminal-style, status codes (ok, missing, manual, info)
- P&L view: annual summary, income/expense breakdown
- Query params: `?month=2026-03`, `?all` (all months)
- Paperless links for drill-down

### **checker-mcp/server.py** (200 lines)

**FastMCP server:**
- 4 tools exposed via HTTP
- Lazy-init PaperlessClient singleton + field ID resolution
- Health endpoint `/health`
- Host header rewrite for DNS rebinding protection (Docker networking)

### **outlook-mcp/server.py** (260 lines)

**MSAL implementation:**
- `get_access_token()`: Silent token acquisition -> device code flow
- Device code URL + code printed to logs (visible in docker logs)
- Token cached at `TOKEN_CACHE_PATH` (default `/data/token_cache.json`)
- 4 tools: list_emails, get_email, get_attachments, download_attachment
- Background auth thread (daemon) — doesn't block server startup
- Health endpoint `/health`

### **claude-code/channels/** (TypeScript/Bun, ~2000 lines total)

**email-watcher.ts** (45KB)
- Polls Gmail + Outlook every 30s (configurable)
- SQLite audit trail (`emails.db`): id, source, message_id, status, classification, action, timestamp
- Metrics endpoint `:9465` (Prometheus format)
- Two channels:
  - Channel events: new email detected -> Claude processes
  - Tools: `update_email_status()`, `get_recent_emails()`, `get_email_stats()`
- Health endpoint `/health` with staleness detection
- Startup events: `first_start`, `catchup_required`

**gdrive-watcher.ts** (24KB)
- Polls Google Drive folders (LEVEL1/LEVEL2) every 30s
- SQLite audit trail (`gdrive.db`)
- Channel events + tools similar to email-watcher
- Creates `processed/` and `errors/` subfolders

**invoice-worker.ts** (51KB)
- Deterministic job worker
- Input: classification (vendor, amount, doc_type, owner, file_path)
- Process:
  1. Download file from workspace or Cloud (if not pre-downloaded)
  2. Dedup via Paperless search (title, correspondent, amount)
  3. Fuzzy correspondent matching (Jaro-Winkler 0.92 threshold)
  4. Upload to Paperless API (direct, bypasses MCP size limit)
  5. Set tags, custom fields (total_amount, order_id)
  6. Move GDrive file to processed/ folder
- Error handling: approval gates for unknown vendors, low confidence
- 68 unit tests with mocked Paperless

**workflow-mcp.ts**
- Durable job queue backed by SQLite (`workflow.db`)
- Job states: created, processing, awaiting_approval, completed, failed
- Tools: `create_job()`, `create_invoice_intake_job()`, `create_scan_intake_job()`, `get_job()`, `list_jobs()`, `approve_job()`, `cancel_job()`

**telegram/** (Official plugin)
- Two-way channel
- Tools: `reply()`, `request_approval()`, `request_user_input()`
- Access control via `access.json` allowlist

### Agents (Haiku subagents)

**email-classifier.md**
- Input: sender, subject, body excerpt, has_attachments
- Output: vendor, total_amount, order_id, download_strategy, action, confidence
- Strategies: `attachment` (MCP tools), `claude_download` (Claude downloads), `known_link`, `direct_url`
- Actions: `download_and_upload`, `notify_user`, `ignore`

**document-classifier.md**
- Input: PDF file path (visual inspection via Read tool)
- Output: vendor, total_amount, doc_type, order_id, is_fuel, currency, confidence, owner
- doc_types: invoice, credit_note, fuel, bank_statement, receipt, etc.
- owner: `techlab` or `personal` (for tag routing)

---

## 7. LOCAL DEV FILES

Local dev configuration lives at the project root (no separate `local/` directory). The `local` profile in `docker-compose.yml` activates dev services.

**Dev command:** `docker compose --profile local --env-file .env up --build`

**Config files (project root):**
- `.env` / `.env.example`: Local secrets (Gmail client_secret, Azure client_id, Paperless token)
- `docker-compose.yml`: Single file — `local` profile activates build contexts + observability stack

**`data/` (gitignored):**
- `claude-config/`: Local Claude credentials (replaces NAS mount)
- `downloads/`: Downloaded invoices
- `email-watcher/`: SQLite DBs (emails.db, workflow.db)
- `outlook/`: Outlook MSAL token cache
- `gmail/`: Gmail OAuth tokens
- `paperless/`: Local Paperless data (postgres, media, redis)

**`observability/` (committed):**
- `alloy-config.alloy`: Alloy OTLP receiver config
- `prometheus-config.yml`: Prometheus scrape config
- `loki-config.yml`: Loki push receiver
- `tempo-config.yml`: Tempo config
- `dashboards/`: Grafana dashboard JSON files

---

## 8. DOCUMENTATION (/docs)

**USE_CASES.md** — Master status index
- UC-1: Invoice Processing (7 items, all DONE)
- UC-1A: Observability (6 items, all DONE)
- UC-2: Invoice Matching (4 of 8 DONE; pending: ZIP export, accountant email, auto-check)
- UC-3, UC-4, UC-5: Not implemented

**infrastructure.md** — Build, deploy, auth, health
- Docker build (node:20, Bun, Claude Code CLI, channels, Telegram plugin)
- Komodo deployment (3 builds: claude-code, checker-mcp, outlook-mcp)
- Auth flows (Claude login, Gmail OAuth, Outlook device code, Telegram pairing)
- Health checks (tmux + curl for claude-code; TCP for others)
- Restart resilience (docker restart policy, entrypoint prompt detection, durable workflow DB)
- Stateless MCP (`FASTMCP_STATELESS_HTTP=true`)
- Persistence (NAS-backed at `/mnt/shared_configs/personal-assistant/`)
- Version management (Komodo builds pinned by git commit, community images pinned)

**uc1-invoice-processing.md** — Full email -> Paperless pipeline
- Polling details (30s cycle, source per-source checkpoint)
- Startup events (first_start, catchup_required)
- Classification flow (email-classifier -> document-classifier merge)
- Download strategies (attachment, claude_download, known_link, direct_url)
- Approval gates (unknown vendor, low confidence, browser-required)
- Telegram notifications (success, failure, user approval request)

**uc1a-observability.md** — Metrics + events
- Email-watcher Prometheus metrics (email_watcher_* counters)
- Claude Code OTLP metrics (token usage, cost, session count)
- Loki events (API requests, tool results, user prompts)

**uc2-invoice-matching.md** — Bank statement matching
- Monthly matching view (`?month=2026-03`)
- P&L annual summary (`?year=2026`)
- Cross-month matching window (+/-1 month)
- Fuzzy correspondent matching (Jaro-Winkler 0.92)
- Approval workflow (manual review for ambiguous matches)

---

## 9. PRODUCTION DEPLOYMENT (KOMODO)

**Komodo procedure:**
```powershell
cd compose.stacks/_komodo
.\komodo.ps1 -Stack personal-assistant
```

**What Komodo does:**
1. Reads secrets from `core.config.toml`
2. Builds 3 images (claude-code, checker-mcp, outlook-mcp) -> tag by git commit
3. Pushes to registry (if configured)
4. Deploys stack to infra LXC (192.168.0.112)
5. Creates bind mount dirs on `/mnt/shared_configs/personal-assistant/`

**Post-deploy auth:**
- Claude: `docker exec -it personal-assistant-claude claude login`
- Gmail: trigger `start_google_auth` from Claude session
- Outlook: restart container, read device code from logs
- Telegram: DM the bot (access.json handles pairing)
- Then restart claude-code: `docker restart personal-assistant-claude`

---

## 10. PRODUCTION vs LOCAL

| Aspect | Production | Local |
|--------|-----------|-------|
| Volumes | NAS at `/mnt/shared_configs/personal-assistant/` | Local `./data/` bind mounts |
| Polling | 30s intervals | 10s intervals (faster testing) |
| OTEL | Shared host Alloy at `:4317` | Local Alloy sidecar |
| Paperless | Managed separately (paperless.lacny.me) | Local container (postgres + redis) |
| Images | Komodo builds (git commit tagged) | Local Docker build |
| Secrets | Komodo-managed `core.config.toml` | Local `.env` file |

---

## 11. WHAT'S MOCKED vs REAL IN TESTS

| Component | E2E Tests | Unit Tests |
|-----------|-----------|------------|
| Email send | REAL (Gmail API) | Mocked |
| Email-watcher polling | REAL (Docker container) | Mocked |
| Claude classification | REAL (Claude API, Haiku) | Mocked |
| PDF download | REAL (from Google Drive / email) | Mocked |
| Paperless upload | REAL (Paperless API) | Mocked (mock client) |
| Invoice matching | REAL (checker-mcp service) | REAL (parse, match logic) |
| Database (SQLite) | REAL (container volume) | REAL (in-memory/temp files) |

---

## 12. KEY DEPENDENCIES & TECHNOLOGIES

**Backend:**
- Python 3.12: match_invoices, servers (checker, outlook)
- TypeScript/Bun: channels (email-watcher, gdrive-watcher, workflow-mcp)
- Node.js 20: Claude Code CLI, channels runtime
- FastMCP (Python/Node): MCP protocol implementation
- MSAL (Python): Outlook auth
- Uvicorn: FastMCP HTTP server
- Flask: Checker web UI

**Testing:**
- pytest: E2E pipeline tests
- bun test: Unit tests (TypeScript)
- unittest.mock: MCP client mocking

**Observability:**
- OpenTelemetry (OTLP): Claude Code native telemetry
- Prometheus: Metrics collection
- Loki: Log aggregation
- Tempo: Trace storage
- Grafana: Visualization
- Alloy: OTLP receiver + metric/log forwarding

**External Services:**
- Gmail API (OAuth, send, attachment download)
- Microsoft Graph (Outlook, device code auth)
- Google Drive API (file list, download)
- Paperless-ngx API (document CRUD, custom fields, tags)
- Caddy (reverse proxy, DNS routing)
