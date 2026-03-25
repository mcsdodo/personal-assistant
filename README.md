# Personal Assistant POC

Validates Claude Code Channels pattern: event-driven processing via MCP channels + tool servers.

## Architecture

```
claude-code container:
  ├── Claude Code (with --dangerously-load-development-channels)
  ├── email-watcher channel (stdio subprocess, mock emails every 60s)
  └── .mcp.json (connects to mock-paperless via HTTP)

mock-paperless-tool container:
  └── FastMCP server (Streamable HTTP on :8000)
```

## Prerequisites

- Docker + Docker Compose on the target host
- Claude MAX subscription (claude.ai account)
- npm installed on the host (for `claude login` — one-time setup)

## Setup — Homelab

### 1. Install Claude Code CLI on the host (one-time)

SSH into the LXC/host where you'll run the stack:

```bash
ssh root@192.168.0.212  # or whichever LXC
npm install -g @anthropic-ai/claude-code
```

### 2. Authenticate Claude Code (one-time)

```bash
claude login
```

This opens an OAuth flow. On a headless server it prints a URL — open it in any browser (phone, laptop), complete the login, and the CLI receives the tokens.

Tokens are saved to `~/.claude/.credentials.json` and auto-refresh. You only need to do this once.

### 3. Verify auth works

```bash
claude -p "hello"
```

If you get a response, auth is working.

### 4. Start the stack

```bash
cd /path/to/compose.stacks/infra/personal-assistant
docker compose up -d
```

The docker-compose mounts `~/.claude/` from the host into the container, so the container reuses the host's OAuth tokens.

### 5. Verify

```bash
# Check both containers are running
docker compose ps

# Check mock-paperless is serving
docker compose logs mock-paperless-tool

# Test Claude + MCP tools inside the container
docker compose exec claude-code claude \
  --dangerously-load-development-channels server:email-watcher \
  --dangerously-skip-permissions \
  --mcp-config /workspace/.mcp.json \
  -p "Call mock_upload with document_name='test.pdf' and tags=['test']"
```

## Setup — Local Development (Windows)

### 1. Authenticate (if not already)

```bash
claude login
```

### 2. Start the stack

```bash
cd compose.stacks/infra/personal-assistant
CLAUDE_CONFIG_DIR="C:/Users/Dodo/.claude" docker compose up -d
```

### 3. Test

```bash
docker compose exec claude-code claude \
  --dangerously-load-development-channels server:email-watcher \
  --dangerously-skip-permissions \
  --mcp-config /workspace/.mcp.json \
  -p "Call mock_upload with document_name='test.pdf' and tags=['test']"
```

## How auth works

```
Host: ~/.claude/.credentials.json (OAuth refresh token from `claude login`)
  ↓ volume mount
Container: /home/node/.claude/.credentials.json
  ↓ Claude Code reads on startup
Claude API (api.anthropic.com) ← outbound HTTPS
```

- Tokens auto-refresh — no manual intervention needed after initial `claude login`
- Channels require claude.ai OAuth (API keys don't work for channels)
- The container also has a baked-in `.claude.json` with project trust settings (no Windows paths)

## docker-compose environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Path to host's Claude config dir (contains `.credentials.json`) |

## Known issues

- `--channels` flag doesn't work with `claude remote-control` subcommand — use `claude --remote-control` flag on interactive mode instead (not yet validated in Docker)
- FastMCP DNS rebinding protection blocks Docker hostnames — ASGI wrapper rewrites Host header (see `mock-tool/server.py`)
- No headless remote-control daemon yet ([#30447](https://github.com/anthropics/claude-code/issues/30447))
