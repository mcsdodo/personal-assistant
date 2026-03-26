# Personal Assistant Stack

Event-driven personal assistant using Claude Code Channels + MCP tool servers.

**Use-case index**: `_tasks/10-personal-assistant/USE-CASES.md` — **keep this up to date** (see below)
**Design doc**: `_tasks/10-personal-assistant/02-design.md`
**Implementation plan**: `_tasks/10-personal-assistant/03-plan.md`
**Channels research**: `_tasks/10-personal-assistant/04-channels-research.md`

## Use-Case Index

`_tasks/10-personal-assistant/USE-CASES.md` is the single source of truth for what this project delivers.

**After any implementation work in this stack:**
1. Update the status column (`--` -> `POC` -> `WIP` -> `DONE`) for affected use cases
2. Add new use cases if scope expands
3. Update the Infrastructure table if components change
4. Keep Notes column current (blockers, decisions, references)

## Architecture

```
claude-code container (node:20-slim, user: node, --model sonnet)
├── Claude Code interactive session in tmux (--remote-control)
├── email-watcher channel+tools (stdio, polls gmail+outlook every 30s, SQLite audit trail)
├── telegram channel (official plugin, cloned at build, two-way)
├── subagents: email-classifier (haiku), invoice-processor (haiku)
└── connects to MCP tool servers via Streamable HTTP

paperless-mcp container (ghcr.io/baruchiro/paperless-mcp:latest)
└── 20 Paperless-ngx CRUD tools on :3000/mcp

checker-mcp container (python:3.12-slim)
└── 4 invoice matching/P&L tools on :8001/mcp (wraps match_invoices.py)

gmail-mcp container (ghcr.io/taylorwilsdon/google_workspace_mcp)
└── Gmail read-only tools on :8000/mcp (community, OAuth via start_google_auth)

outlook-mcp container (python:3.12-slim)
└── 6 Outlook read-only tools on :8002/mcp (custom, MSAL device code auth)
```

Channels are stdio subprocesses of Claude Code — they MUST run inside the same container. MCP tool servers CAN be separate containers via Streamable HTTP (`"type": "http"` in `.mcp.json`).

## Key Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Production stack (Komodo deploys this) |
| `local/docker-compose.yml` | Local dev overlay (build contexts + observability sidecar) |
| `local/.env` / `local/.env.example` | Local dev secrets (Komodo manages prod secrets) |
| `local/claude-code/Dockerfile` | node:20 + bun + claude-code CLI, non-root user |
| `local/claude-code/.mcp.json` | MCP server config (channels + HTTP tools) |
| `local/claude-code/CLAUDE.md` | Instructions for the Claude session |
| `local/claude-code/entrypoint.sh` | tmux wrapper, first-run settings.json creation |
| `local/claude-code/channels/email-watcher.ts` | Email-watcher channel (polls Gmail+Outlook, SQLite audit) |
| `local/claude-code/channels/db.ts` | Email-watcher SQLite module |
| `local/claude-code/agents/` | Haiku subagents (email-classifier, invoice-processor) |
| `local/checker-mcp/server.py` | FastMCP wrapping match_invoices.py (4 tools) |
| `local/checker-mcp/match_invoices.py` | Invoice matching engine (copy from paperless checker) |
| `local/outlook-mcp/server.py` | Outlook MCP (MSAL device code auth) |
| `local/observability/` | Local dev Alloy, Prometheus, Loki, Grafana configs |

## Claude Code in Docker — Reference

### Authentication
- Run `claude login` on the host (one-time, interactive OAuth flow)
- Tokens saved to `~/.claude/.credentials.json`, auto-refresh
- Volume mount: `~/.claude:/home/node/.claude`
- Channels require claude.ai OAuth — API keys don't work

### Settings
Host `~/.claude/settings.json` is volume-mounted into container and overrides baked-in settings.

Required settings for headless operation:
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
- `--dangerously-load-development-channels`: has unskippable TUI prompt — must package as proper plugin for production
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
| `email_watcher_vendors_total` | Top detected vendors once classification starts recording them |
| `email_watcher_processed_results_total` | Processed email counts grouped by final `status` |
| `email_watcher_latency_seconds` | Average workflow latency from discovery to classification / processing |

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
