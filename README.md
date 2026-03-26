# Personal Assistant Stack

Event-driven personal assistant: Claude Code (Sonnet) + Haiku subagents + MCP tool servers + channels (email-watcher, Telegram).

## Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| claude-code | local build | — | Claude Code + channels + subagents + remote control |
| paperless-mcp | ghcr.io/baruchiro/paperless-mcp | 3000 | Paperless-ngx CRUD (20 tools) |
| checker-mcp | local build | 8001 | Invoice matching + P&L (4 tools) |
| gmail-mcp | ghcr.io/taylorwilsdon/google_workspace_mcp | 8000 | Gmail read-only |
| outlook-mcp | local build | 8002 | Outlook read-only (device code auth) |

## Deployment (new environment)

This stack is designed to be deployed by an agent (Claude Code). The agent handles all file operations, docker commands, and configuration. The user only needs to complete browser-based OAuth flows and Telegram pairing.

### Prerequisites (user provides these)

- Docker + Docker Compose on the target host
- Claude MAX subscription (logged in: `claude login` on host)
- Google Cloud project with Gmail API + OAuth Desktop Client ID
- Azure AD app registration with delegated `Mail.Read` permission
- Telegram bot token from @BotFather
- Paperless-ngx instance URL + API token

### Step 1: Configure .env (agent)

```bash
cp .env.example .env
```

Agent fills in credentials provided by user. See `.env.example` for all required values.

### Step 2: Build and start (agent)

```bash
docker compose up -d --build
```

The build handles everything: Claude Code CLI, Bun, Telegram plugin (cloned from GitHub), channel wiring, subagent definitions.

### Step 3: Outlook auth (user action required)

Agent reads the device code from logs and tells the user what to do.

```bash
docker compose logs outlook-mcp | grep -A2 "OUTLOOK AUTH"
# Output:
#   1. Open:  https://www.microsoft.com/link
#   2. Enter: XXXXXXXX
```

User opens the URL in a browser, enters the code, signs in. Token is cached automatically.

### Step 4: Gmail auth (user action required)

Agent triggers auth via the Claude session, then tells the user to open the URL.

```bash
# Agent attaches to Claude session and triggers:
docker exec personal-assistant-claude bash -c "tmux send-keys -t claude \
  'use gmail start_google_auth with service_name gmail and user_google_email USER@gmail.com' Enter"
```

Claude calls `start_google_auth` → returns a URL. User opens it in browser, approves Gmail access. Callback hits `localhost:8000` on the host → token saved.

### Step 5: Telegram pairing (user action required)

1. User sends any message to the bot in Telegram (e.g., "hello")
2. Bot replies with a pairing code
3. Agent reads the pending pairing and writes the allowlist:

```bash
# Agent reads the pending entry to get the user's Telegram ID:
docker exec personal-assistant-claude bash -c \
  "cat /home/node/.claude/channels/telegram/access.json"
# Look for "senderId" in the "pending" section

# Agent writes the allowlist with the user's ID:
docker exec personal-assistant-claude bash -c 'cat > /home/node/.claude/channels/telegram/access.json << EOF
{
  "dmPolicy": "allowlist",
  "allowFrom": ["USER_TELEGRAM_ID"],
  "groups": {},
  "pending": {}
}
EOF'
```

The user's Telegram ID is a numeric string (e.g., `"7628063924"`). Also available via `@userinfobot` in Telegram.

### Step 6: Verify (agent)

```bash
# All containers running
docker compose ps

# Auth successful
docker compose logs outlook-mcp | grep "authenticated"
docker compose logs gmail-mcp | grep "Stored credentials"

# Claude session listening on both channels
docker exec personal-assistant-claude bash -c "tmux capture-pane -t claude -p -S -10"
# Expected: "Listening for channel messages from: server:email-watcher, server:telegram"

# Telegram two-way test
docker exec personal-assistant-claude bash -c "tmux send-keys -t claude \
  'Send a Telegram message to chat_id CHAT_ID saying: Deployment complete, assistant is online.' Enter"
```

## Volume mounts (persist across restarts)

| Path (container) | Content | .env override |
|------------------|---------|---------------|
| `/home/node/.claude/` | Claude OAuth, Telegram access.json | `CLAUDE_CONFIG_DIR` |
| `/app/store_creds/` (gmail) | Gmail OAuth tokens | `GMAIL_CREDS_DIR` |
| `/data/` (outlook) | Outlook MSAL token cache | `OUTLOOK_DATA_DIR` |
| `/workspace/downloads/` | Downloaded invoices | `DOWNLOADS_DIR` |

## Windows local dev

```bash
# Add to .env:
CLAUDE_CONFIG_DIR=C:/Users/YourUser/.claude

docker compose up -d --build
```

## Monitoring

```bash
# View Claude session live
docker exec -it personal-assistant-claude tmux attach -t claude

# Capture last 30 lines without attaching
docker exec personal-assistant-claude bash -c "tmux capture-pane -t claude -p -S -30"

# Check MCP server health
docker exec personal-assistant-claude bash -c "curl -s http://checker-mcp:8001/mcp"
docker exec personal-assistant-claude bash -c "curl -s http://paperless-mcp:3000/mcp"
```
