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
| `docker-compose.yml` | Stack definition, volume mounts |
| `.env` / `.env.example` | Secrets (PAPERLESS_API_TOKEN, PAPERLESS_URL) |
| `claude-code/Dockerfile` | node:20 + bun + claude-code CLI, non-root user |
| `claude-code/.mcp.json` | MCP server config (channels + HTTP tools) |
| `claude-code/.claude.json` | Project trust settings (no Windows paths) |
| `claude-code/CLAUDE.md` | Instructions for the Claude session |
| `claude-code/entrypoint.sh` | tmux wrapper for persistent interactive session |
| `claude-code/channels/email-watcher.ts` | Email-watcher channel (polls Gmail+Outlook, pushes events, SQLite audit) |
| `claude-code/channels/db.ts` | Email-watcher SQLite module (schema, insert, update, query) |
| `claude-code/channels/telegram/` | Official telegram plugin (cloned at build from GitHub) |
| `claude-code/agents/email-classifier.md` | Haiku subagent: classify emails as invoice/not |
| `claude-code/agents/invoice-processor.md` | Haiku subagent: download + upload to Paperless |
| `checker-mcp/server.py` | FastMCP wrapping match_invoices.py (4 tools) |
| `checker-mcp/match_invoices.py` | Copied from checker source at build time |
| `checker-mcp/build.sh` | Pre-build: copies match_invoices.py from checker |

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
docker compose -f docker-compose.yml -f docker-compose.local.yml up

# Rebuild after code changes
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build

# Check status
docker compose -f docker-compose.yml -f docker-compose.local.yml ps

# View Claude session
docker exec personal-assistant-claude tmux capture-pane -t claude -p -S -30

# Attach interactively
docker exec -it personal-assistant-claude tmux attach -t claude

# Check Claude env vars
docker exec personal-assistant-claude sh -c "env | grep -E 'OTEL|TELEMETRY'"
```

## Observability

Claude Code exports native OpenTelemetry metrics and events via OTLP to an Alloy instance, which forwards to Prometheus (metrics) and Loki (logs/events).

### Local Dev

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up
```

This starts a local Alloy + Prometheus + Loki + Grafana alongside the main stack.

| Service | Local URL |
|---------|-----------|
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9091 |
| Loki | http://localhost:3101 |
| Alloy UI | http://localhost:12345 |

### Production

On the deploy host, add the OTLP receiver blocks from `observability/alloy-config.alloy` to the host's shared Alloy config. Set `OTEL_ENDPOINT` in `.env` if the host Alloy isn't reachable at `http://alloy:4317`.

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
| `docker-compose.local.yml` | Local dev observability stack (Alloy + Prometheus + Loki + Grafana) |
| `observability/alloy-config.alloy` | Alloy OTLP receiver config (used locally, merge into host config for prod) |
| `observability/dashboards/claude-code.json` | Grafana dashboard: token usage, cost, API latency, tool stats, errors |
| `observability/prometheus-config.yml` | Minimal Prometheus config for local dev |
| `observability/loki-config.yml` | Minimal Loki config for local dev |
