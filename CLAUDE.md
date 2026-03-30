# Personal Assistant Stack

Event-driven personal assistant using Claude Code Channels + MCP tool servers.

**Use-case index**: `docs/USE_CASES.md` — **keep this up to date** (see below)
**Detailed pipeline docs**: `docs/uc1-invoice-processing.md`, `docs/infrastructure.md`
**Original design docs** (historical): `_tasks/_done/10-personal-assistant/`

## Use-Case Index

`docs/USE_CASES.md` is the single source of truth for what this project delivers.

**After any implementation work in this stack:**
1. Update the status column in `docs/USE_CASES.md`
2. Update detailed docs in `docs/` (pipeline flow, code links, etc.)
3. Add new use cases if scope expands

## Architecture

```
claude-code container (node:20-slim, user: node, --model sonnet)
├── Claude Code interactive session in tmux (--remote-control)
├── email-watcher channel+tools (stdio, polls gmail+outlook every 30s, SQLite audit trail)
├── gdrive-watcher channel+tools (stdio, polls GDrive LEVEL1×LEVEL2 folders every 30s, SQLite audit trail)
├── telegram channel (official plugin, cloned at build, two-way)
├── subagents: email-classifier (haiku), document-classifier (haiku, returns owner field)
└── connects to MCP tool servers via Streamable HTTP

paperless-mcp container (ghcr.io/baruchiro/paperless-mcp:latest)
└── 20 Paperless-ngx CRUD tools on :3000/mcp

checker-mcp container (python:3.12-slim, two-process)
├── 4 invoice matching/P&L tools on :8001/mcp (wraps match_invoices.py)
└── Flask web UI on :5000 (invoices.lacny.me — matching view + P&L view)

gmail-mcp container (ghcr.io/taylorwilsdon/google_workspace_mcp)
├── Gmail tools on :8000/mcp (community, OAuth via start_google_auth)
└── Google Drive tools (list, download, move files)

outlook-mcp container (python:3.12-slim)
└── 4 Outlook read-only tools on :8002/mcp (custom, MSAL device code auth)
```

Channels are stdio subprocesses of Claude Code — they MUST run inside the same container. MCP tool servers CAN be separate containers via Streamable HTTP (`"type": "http"` in `.mcp.json`).

## Robustness & Health

### Health Checks

All 5 services have Docker health checks. `claude-code` depends on all MCPs via `depends_on: service_healthy` — it won't start until all MCPs are ready.

| Service | Health check | Interval | Start period |
|---------|-------------|----------|--------------|
| `claude-code` | tmux session alive + email-watcher `/health` (port 9465) | 30s | 90s |
| `checker-mcp` | `/health` endpoint (port 8001) | 30s | 15s |
| `outlook-mcp` | `/health` endpoint (port 8002) | 30s | 30s |
| `paperless-mcp` | TCP port 3000 check via Node | 30s | 15s |
| `gmail-mcp` | TCP port 8000 check via Python | 30s | 15s |

The email-watcher `/health` also tracks poll staleness — returns 503 if no successful poll in `POLL_INTERVAL_MS * 5` (default: 2.5 minutes). This detects both MCP connectivity loss and email-watcher hangs.

When the tmux session dies, the entrypoint exits with code 1, triggering Docker's `restart: unless-stopped` policy.

### Stateless MCP Sessions

Custom MCP servers (`checker-mcp`, `outlook-mcp`) run with `FASTMCP_STATELESS_HTTP=true`. This means:
- No MCP session IDs are assigned
- Server restarts are transparent to Claude Code (no session to lose)
- Works around Claude Code bug [#27142](https://github.com/anthropics/claude-code/issues/27142) where cached session IDs cause permanent tool failures after server restart

Community servers (`paperless-mcp`, `gmail-mcp`) may still use stateful sessions. If they restart and Claude's tool calls fail, restart the `claude-code` container.

### Watchtower

All services have `com.centurylinklabs.watchtower.monitor: "false"` — no mid-session auto-updates. Update community images intentionally via Komodo procedure.

### Version Pinning

| Image | Pin strategy |
|-------|-------------|
| `checker-mcp`, `outlook-mcp`, `claude-code` | Local builds via Komodo, tagged by git commit |
| `gmail-mcp` | Pinned to `1.16.2` (semver available on GHCR) |
| `paperless-mcp` | `:latest` (no semver tags; Watchtower excluded, `auto_pull=false`) |

## Key Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Production stack (Komodo deploys this) |
| `local/docker-compose.yml` | Local dev overlay (build contexts + observability sidecar) |
| `local/.env` / `local/.env.example` | Local dev secrets (Komodo manages prod secrets) |
| `local/claude-code/Dockerfile` | node:20 + bun + claude-code CLI, non-root user |
| `local/claude-code/.mcp.json` | MCP server config (channels + HTTP tools) |
| `local/claude-code/CLAUDE.md` | Instructions for the Claude session |
| `local/claude-code/entrypoint.sh` | tmux wrapper, prompt detection, health monitor |
| `local/claude-code/channels/email-watcher.ts` | Email-watcher channel (polls Gmail+Outlook, SQLite audit) |
| `local/claude-code/channels/db.ts` | Email-watcher SQLite module |
| `local/claude-code/channels/gdrive-watcher.ts` | GDrive-watcher channel (polls Google Drive, SQLite audit) |
| `local/claude-code/channels/gdrive-db.ts` | GDrive-watcher SQLite module |
| `local/claude-code/channels/invoice-links.ts` | Shared invoice link extraction from HTML (vendor rules, used by email-watcher + invoice-worker) |
| `local/claude-code/agents/` | Haiku subagents (email-classifier, document-classifier — classifier returns `owner` field for personal/business tag routing) |
| `local/checker-mcp/server.py` | FastMCP wrapping match_invoices.py (4 tools) |
| `local/checker-mcp/webapp.py` | Flask web UI (matching view + P&L view) |
| `local/checker-mcp/entrypoint.sh` | Two-process entrypoint (MCP background + Flask PID 1) |
| `local/checker-mcp/match_invoices.py` | Invoice matching engine |
| `local/outlook-mcp/server.py` | Outlook MCP (MSAL device code auth) |
| `local/observability/` | Local dev Alloy, Prometheus, Loki, Grafana configs |

## Claude Code in Docker — Reference

### Authentication
- **Claude**: `docker exec -it personal-assistant-claude claude login` (one-time)
- **Gmail**: trigger `start_google_auth` from Claude session → callback via `https://gmail-mcp.lacny.me/oauth2callback`
- **Outlook**: restart container, get device code from `docker logs personal-assistant-outlook-mcp 2>&1 | grep -A3 "OUTLOOK AUTH"`
- **Telegram**: DM the bot, access.json in volume handles pairing
- Tokens persist in `/mnt/shared_configs/personal-assistant/` (NAS-backed)
- After auth, restart Claude to reconnect MCPs: `docker restart personal-assistant-claude`

### Settings
`entrypoint.sh` creates `settings.json` on first boot if missing (no manual setup needed).

Required settings (auto-created):
```json
{
  "skipDangerousModePermissionPrompt": true
}
```

### Flags
```bash
claude \
  --dangerously-skip-permissions \        # bypass tool approval prompts
  --dangerously-load-development-channels server:name \  # load custom channel from .mcp.json
  --mcp-config /workspace/.mcp.json       # explicit MCP config path
```

- `--dangerously-skip-permissions`: can't run as root (use non-root user)
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

## Development

Development runs locally on the Windows dev machine using Docker Desktop with the local compose override:

```bash
# Start the full stack (from compose.stacks/infra/personal-assistant/)
docker compose -f docker-compose.yml -f local/docker-compose.yml --env-file local/.env up

# Rebuild after code changes
docker compose -f docker-compose.yml -f local/docker-compose.yml --env-file local/.env up --build

# Check status
docker compose -f docker-compose.yml -f local/docker-compose.yml --env-file local/.env ps

# View Claude session
docker exec personal-assistant-claude tmux capture-pane -t claude -p -S -30

# Attach interactively
docker exec -it personal-assistant-claude tmux attach -t claude

# Check Claude env vars
docker exec personal-assistant-claude sh -c "env | grep -E 'OTEL|TELEMETRY'"
```

## Testing

### E2E Pipeline Tests

`tests/` contains a pytest suite that exercises the full email processing pipeline end-to-end (Gmail, Outlook, download link flows). Tests send real emails, wait for the pipeline to process them, and verify results in Paperless.

**Location:** `compose.stacks/infra/personal-assistant/tests/`

| File | Purpose |
|------|---------|
| `test_email_gmail.py` | Gmail attachment pipeline (invoice, fuel, credit note, bank statement, ignore) |
| `test_email_outlook.py` | Outlook attachment pipeline (same set) |
| `test_email_link.py` | Outlook download link pipeline (Alza-style HTML email with invoice URL) |
| `helpers.py` | Gmail sending, Paperless API verification, email-watcher DB polling |
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

### Unit Tests (invoice-worker)

The invoice-worker has 68 unit tests with mocked MCP calls:
```bash
cd local/claude-code
bun test
```

## Observability

Claude Code exports native OpenTelemetry metrics and events via OTLP to an Alloy instance, which forwards to Prometheus (metrics) and Loki (logs/events).

The local observability stack also scrapes an `email-watcher` Prometheus endpoint from inside the `claude-code` container. This provides workflow metrics that are more useful for this project than generic Claude activity counters.

### Local Dev

```bash
docker compose -f docker-compose.yml -f local/docker-compose.yml --env-file local/.env up
```

This starts a local Alloy + Prometheus + Loki + Grafana alongside the main stack.

| Service | Local URL |
|---------|-----------|
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9091 |
| Loki | http://localhost:3101 |
| Alloy UI | http://localhost:12345 |

### Production

Production OTLP support now belongs in the shared host Alloy config at `compose.stacks/_shared-infra/alloy/config.alloy`.

Set `OTEL_ENDPOINT` in `.env` if the host Alloy isn't reachable at `http://alloy:4317` from the `claude-code` container.

Notes:
- local dev still uses `observability/alloy-config.alloy` via `docker-compose.local.yml`
- production host config reuses the existing shared `prometheus.remote_write.prometheus_endpoint` and `loki.write.loki_endpoint` outputs
- after syncing the shared config to `/mnt/shared_configs/grafana/config.alloy`, restart the host Alloy container

### Updating Grafana Dashboards

Dashboard JSON files live in `local/observability/dashboards/`. Production Grafana mounts dashboards read-only from `/mnt/shared_configs/grafana/dashboards/` on the infra host.

**After editing a dashboard JSON:**
```bash
# Copy to production Grafana (provisioner picks up changes automatically)
scp local/observability/dashboards/claude-code.json root@192.168.0.112:/mnt/shared_configs/grafana/dashboards/claude-code.json
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

### Email Workflow Metrics (Prometheus scrape from `claude-code:9465`)

| Metric | Meaning |
|--------|---------|
| `email_watcher_emails_total` | Total tracked emails by `source` and `status` |
| `email_watcher_backlog_total` | Emails still waiting for processing (`status="new"`) by `source` |
| `email_watcher_attachments_total` | Emails with attachments by `source` and `status` |
| `email_watcher_recent_discovered_total` | Emails discovered in the last 24h by `source` and `status` |
| `email_watcher_actions_total` | Classified actions such as `download_and_upload`, `notify_user`, `ignore` |
| `email_watcher_confidence_total` | Classified emails grouped by confidence (`high`, `medium`, `low`) |
| `email_watcher_vendors_total` | Raw vendor names from email classifier (legacy, still scraped) |
| `email_watcher_processed_results_total` | Processed email counts grouped by final `status` |
| `email_watcher_latency_seconds` | Average workflow latency from discovery to classification / processing |

### Invoice Worker Metrics (OTLP push from `workflow-mcp`)

| Metric | Meaning |
|--------|---------|
| `invoice_worker_correspondents_total` | Completed invoices by normalized Paperless correspondent. Counter seeded from DB at startup, incremented on each upload. Used by "Top Correspondents" dashboard panel. |

### Events (Loki, via OTel logs)

| Event | Key attributes |
|-------|---------------|
| `claude_code.api_request` | model, cost_usd, duration_ms, input/output/cache tokens |
| `claude_code.api_error` | model, error, status_code, attempt |
| `claude_code.tool_result` | tool_name, success, duration_ms, mcp_server_scope |
| `claude_code.tool_decision` | tool_name, decision, source |
| `claude_code.user_prompt` | prompt length |

### Key Files

| File | Purpose |
|------|---------|
| `local/docker-compose.yml` | Local dev overlay (build contexts + Alloy + Prometheus + Loki + Grafana) |
| `local/observability/alloy-config.alloy` | Alloy OTLP receiver config (local dev) |
| `compose.stacks/_shared-infra/alloy/config.alloy` | Shared host Alloy config with production OTLP + email-watcher scrape |
| `local/observability/dashboards/claude-code.json` | Grafana dashboard |
| `local/observability/prometheus-config.yml` | Minimal Prometheus config for local dev |
| `local/observability/loki-config.yml` | Minimal Loki config for local dev |
