# Personal Assistant

An event-driven automation system that watches your email inboxes and Google Drive for invoices and documents, classifies them with AI, and uploads them to [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) with correct tags, correspondents, and custom fields.

Built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code) running inside Docker with [MCP](https://modelcontextprotocol.io/) tool servers, Channels for real-time event streaming, and Haiku subagents for fast classification.

## What It Does

- **Email monitoring** — polls Gmail and Outlook every 30 seconds for new emails with invoices
- **Google Drive scanning** — watches configured Drive folders for scanned documents
- **AI classification** — Haiku subagents extract vendor, amount, document type, and ownership from email metadata and PDF content
- **Automated upload** — downloads attachments, deduplicates against existing documents, uploads to Paperless-ngx with tags and custom fields
- **Invoice matching** — matches bank statement movements against uploaded invoices with fuzzy correspondent matching ([web UI](docs/uc2-invoice-matching.md))
- **Notifications** — Telegram alerts for processed invoices, errors, and approval requests
- **Observability** — Prometheus metrics, Grafana dashboards, OpenTelemetry traces ([details](docs/uc1a-observability.md))

See [docs/USE_CASES.md](docs/USE_CASES.md) for the full feature index with implementation status.

## Architecture

5 Docker containers in one Compose stack:

```
claude-code (node:20-slim)
├── Claude Code CLI session in tmux (Sonnet, --remote-control)
├── email-watcher channel (stdio, polls Gmail+Outlook, SQLite audit trail)
├── gdrive-watcher channel (stdio, polls Google Drive folders, SQLite audit trail)
├── telegram channel (official plugin, two-way notifications)
├── workflow-mcp (HTTP :8003, durable job queue + invoice worker)
└── subagents: email-classifier (Haiku), document-classifier (Haiku)

paperless-mcp (ghcr.io/baruchiro/paperless-mcp)
└── 20 Paperless-ngx CRUD tools on :3000/mcp

checker-mcp (python:3.12-slim)
├── 4 invoice matching tools on :8001/mcp
└── Flask web UI on :5000 (matching view + P&L view)

gmail-mcp (ghcr.io/taylorwilsdon/google_workspace_mcp)
├── Gmail tools on :8000/mcp (OAuth)
└── Google Drive tools (list, download, move)

outlook-mcp (python:3.12-slim)
└── 4 read-only Outlook tools on :8002/mcp (MSAL device code auth)
```

For detailed pipeline flows, see [docs/uc1-invoice-processing.md](docs/uc1-invoice-processing.md). For health checks, resilience, and deployment details, see [docs/infrastructure.md](docs/infrastructure.md).

### Permission Model

Claude Code runs with `--permission-mode dontAsk` — every tool call not in an explicit allowlist is silently denied. This is a deliberate least-privilege design:

- **Custom MCP servers** — allowed via wildcard (we control them)
- **Gmail MCP** — individually enumerated read-only tools; write/browse tools (send email, list Drive folders) are blocked
- **Bash** — scoped to specific commands (`curl -o`, `qpdf`, `rm /workspace/downloads/*`); POST requests, arbitrary `node`, `cat`, and `env` are denied
- **File writes** — limited to Claude's memory directory only

The allowlist lives in [`claude-code/.claude/settings.json`](claude-code/.claude/settings.json). See [CLAUDE.md#settings](CLAUDE.md#settings) for the full rationale.

## Prerequisites

- Docker and Docker Compose
- A running [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) instance with an API token
- An [Anthropic API key](https://console.anthropic.com/) (for Claude Code)
- At least one email source:
  - **Gmail**: Google Cloud OAuth 2.0 credentials (Desktop App type)
  - **Outlook**: Azure AD app registration with `Mail.Read` (set `OUTLOOK_ENABLED=false` to skip)
- Optional: Telegram bot token (for notifications), Google Drive access (for scan pipeline)

## Quick Start

```bash
# 1. Configure
cp .env.example .env
# Edit .env — see comments in .env.example for each variable

# 2. Start (local dev — includes Paperless, observability)
docker compose --profile local --env-file .env up --build

# 3. First-time Paperless setup (local profile only)
docker compose exec paperless python3 manage.py createsuperuser
# Log into http://localhost:8010 → Settings → API Tokens → copy to .env

# 4. Authenticate Claude
docker exec -it personal-assistant-claude claude login

# 5. Restart to connect with authenticated MCPs
docker restart personal-assistant-claude
```

For Gmail, Outlook, and Telegram auth flows, see [docs/infrastructure.md#authentication](docs/infrastructure.md#authentication).

## Configuration

All configuration is via environment variables in `.env`. See [`.env.example`](.env.example) for the full list with comments.

Key groups:

| Group | Variables | Notes |
|-------|-----------|-------|
| Paperless-ngx | `PAPERLESS_URL`, `PAPERLESS_API_TOKEN` | Required |
| Gmail | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GMAIL_EMAIL` | Required for email pipeline |
| Outlook | `AZURE_CLIENT_ID`, `OUTLOOK_ENABLED` | Set `OUTLOOK_ENABLED=false` to skip |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional notifications |
| Business identity | `BUSINESS_COMPANY_NAME`, `BUSINESS_TAX_IDS`, `BUSINESS_CRN` | For document classifier ownership detection |
| Google Drive | `GDRIVE_LEVEL1`, `GDRIVE_LEVEL2` | Folder paths to watch |
| Polling | `POLL_INTERVAL_MS`, `GDRIVE_POLL_INTERVAL_MS` | Defaults: 30s each |
| Email filtering | `GMAIL_SEARCH_BASE`, `EMAIL_FILTER_INCLUDE`, `EMAIL_FILTER_EXCLUDE` | Optional inbox scoping |

## Testing

```bash
# TypeScript channels (~300 tests, 15 files)
cd claude-code/channels && bun test

# Python invoice matching (116 tests)
cd checker-mcp && python -m pytest test_matching.py -v

# E2E pipeline (requires running local stack + Gmail/Outlook auth)
python -m pytest tests/ -v --timeout=300
```

See [CLAUDE.md](CLAUDE.md#testing) for the full test file index and CI details.

## Documentation

| Document | Contents |
|----------|----------|
| [CLAUDE.md](CLAUDE.md) | Developer reference — architecture, key files, source code guide, testing, observability, metrics |
| [docs/USE_CASES.md](docs/USE_CASES.md) | Feature index with implementation status |
| [docs/uc1-invoice-processing.md](docs/uc1-invoice-processing.md) | Email and scan pipeline flow |
| [docs/uc2-invoice-matching.md](docs/uc2-invoice-matching.md) | Bank statement matching and P&L |
| [docs/uc1a-observability.md](docs/uc1a-observability.md) | Metrics, events, dashboards |
| [docs/infrastructure.md](docs/infrastructure.md) | Build, deploy, auth, health checks, resilience |

## Tech Stack

**Runtime:** Node.js 20, Bun, Python 3.12 |
**AI:** Claude Code CLI (Sonnet), Haiku subagents, MCP protocol |
**MCP Servers:** [paperless-mcp](https://github.com/baruchiro/paperless-mcp), [google-workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp), checker-mcp (custom), outlook-mcp (custom) |
**Data:** SQLite (audit trails, job queue), Paperless-ngx (document store) |
**Observability:** OpenTelemetry, Prometheus, Grafana, Loki, Alloy |
**Testing:** Bun test, pytest, GitHub Actions CI

## License

[MIT](LICENSE)
