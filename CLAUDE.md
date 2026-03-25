# Personal Assistant Stack

Event-driven personal assistant using Claude Code Channels + MCP tool servers.

**Design doc**: `_tasks/10-personal-assistant/02-design.md`
**Implementation plan**: `_tasks/10-personal-assistant/03-plan.md`
**Channels research**: `_tasks/10-personal-assistant/04-channels-research.md`

## Architecture

```
claude-code container (node:20-slim, user: node)
├── Claude Code interactive session in tmux
├── email-watcher channel (stdio subprocess via MCP)
└── connects to remote MCP tool servers via Streamable HTTP

mock-paperless-tool container (python:3.12-slim)
└── FastMCP server on :8000/mcp
```

Channels are stdio subprocesses of Claude Code — they MUST run inside the same container. MCP tool servers CAN be separate containers via Streamable HTTP (`"type": "http"` in `.mcp.json`).

## Key Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Stack definition, volume mounts |
| `claude-code/Dockerfile` | node:20 + bun + claude-code CLI, non-root user |
| `claude-code/.mcp.json` | MCP server config (channels + HTTP tools) |
| `claude-code/.claude.json` | Project trust settings (no Windows paths) |
| `claude-code/CLAUDE.md` | Instructions for the Claude session |
| `claude-code/entrypoint.sh` | tmux wrapper for persistent interactive session |
| `claude-code/channels/email-watcher.ts` | Mock channel (TypeScript, MCP SDK) |
| `mock-tool/server.py` | Mock Paperless MCP tool server (FastMCP) |

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

## Test Hosts

POC is deployed to test host1 at `192.168.0.96` (`/opt/personal-assistant/`).

```bash
# Check status
ssh root@192.168.0.96 "cd /opt/personal-assistant && docker compose ps"

# View Claude session
ssh root@192.168.0.96 "docker exec personal-assistant-claude tmux capture-pane -t claude -p -S -30"

# Attach interactively
ssh -t root@192.168.0.96 "docker exec -it personal-assistant-claude tmux attach -t claude"

# Rebuild and deploy
ssh root@192.168.0.96 "cd /opt/personal-assistant && docker compose build && docker compose up -d"
```
