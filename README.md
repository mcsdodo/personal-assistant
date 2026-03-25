# Personal Assistant POC

Validates Claude Code Channels pattern: event-driven processing via MCP channels + tool servers.

## Architecture

```
claude-code container:
  ├── Claude Code (remote-control mode)
  ├── email-watcher channel (stdio subprocess, mock emails every 60s)
  └── .mcp.json (connects to mock-paperless via HTTP)

mock-paperless-tool container:
  └── FastMCP server (Streamable HTTP on :8000)
```

## Prerequisites

- Docker + Docker Compose
- Claude Code CLI authenticated on host (`claude login` via claude.ai)

## Setup

### 1. Authenticate Claude Code (one-time, on host)

```bash
claude login
```

This creates OAuth credentials in `~/.claude/`. The Docker volume mounts these into the container.

### 2. Start the stack

```bash
docker compose up -d
```

### 3. Connect from mobile

Check logs for Remote Control session info:

```bash
docker compose logs claude-code
```

Open the session URL in claude.ai/code from your phone or browser.

### 4. Observe channel events

The email-watcher pushes a mock invoice email every 60 seconds. Claude should:
1. Receive the `<channel source="email-watcher">` event
2. Classify the email
3. Call `mock_upload` on the mock-paperless server
4. Log the result

### 5. Test manual queries

In the connected session, type:
- "search for invoices from March 2026"
- "match invoices for 2026-03"

## Development

### Test mock tool locally

```bash
cd mock-tool
pip install -r requirements.txt
python -m pytest test_server.py -v
```

### Test email-watcher channel locally

```bash
cd claude-code/channels
bun install
claude --dangerously-load-development-channels server:email-watcher
```

## What this validates

- [ ] Claude Code runs in Docker with Remote Control
- [ ] Custom channel pushes events into session
- [ ] Claude reasons about events and calls MCP tools
- [ ] Streamable HTTP MCP tool server works from separate container
- [ ] Mobile access via claude.ai/code works
