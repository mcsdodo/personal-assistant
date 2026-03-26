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

## Prerequisites

- Docker + Docker Compose
- Claude MAX subscription
- Google Cloud project with Gmail API enabled
- Azure AD app registration with `Mail.Read` permission
- Telegram bot (create via @BotFather)

## Deployment (new environment)

### Automated (handled by docker compose build)

- Claude Code CLI installation
- Bun runtime installation
- Telegram plugin cloned from `anthropics/claude-plugins-official`
- Channel and MCP server wiring
- Subagent definitions copied to `.claude/agents/`

### Manual steps (one-time per environment)

#### 1. Configure secrets

```bash
cp .env.example .env
# Fill in all credentials (see .env.example for descriptions)
```

#### 2. Claude Code login

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

Tokens saved to `~/.claude/`, volume-mounted into container.

#### 3. Gmail OAuth setup

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → OAuth Client ID → Desktop App → Download JSON
2. Save as `data/gmail/client_secret.json`
3. OAuth consent screen → Add scope `gmail.readonly` → Add your email as test user
4. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in `.env`

#### 4. Outlook Azure app

1. [Azure Portal](https://portal.azure.com) → App registrations → New → Add delegated `Mail.Read` permission
2. Set `AZURE_CLIENT_ID` in `.env`

#### 5. Telegram bot

1. DM `@BotFather` in Telegram → `/newbot` → get token
2. Set `TELEGRAM_BOT_TOKEN` in `.env`
3. Set `TELEGRAM_CHAT_ID` to your personal Telegram user ID

#### 6. Start the stack

```bash
docker compose up -d --build
```

#### 7. Complete interactive auth (one-time per environment)

**Outlook** — device code flow, check logs:
```bash
docker compose logs outlook-mcp
# Shows: Open https://www.microsoft.com/link → Enter: XXXXXXXX
```

**Gmail** — ask Claude to authenticate (via tmux):
```bash
docker exec -it personal-assistant-claude tmux attach -t claude
# Type: use gmail start_google_auth with service_name gmail and user_google_email you@gmail.com
```

**Telegram** — pair your account:
1. DM your bot in Telegram (send any message, e.g., "hello")
2. Bot replies: `Pairing required — run in Claude Code: /telegram:access pair XXXXXX`
3. Note the 6-character code (e.g., `ee78fa`)
4. Write `access.json` directly — this is easier than using the skill command (which doesn't work with development channels):
```bash
# Get your Telegram user ID from the container logs:
docker exec personal-assistant-claude bash -c "cat /home/node/.claude/channels/telegram/access.json"
# Look for your ID in the "pending" section, then write the allowlist:

mkdir -p data/telegram  # or wherever your CLAUDE_CONFIG_DIR points
cat > ~/.claude/channels/telegram/access.json << 'EOF'
{
  "dmPolicy": "allowlist",
  "allowFrom": ["YOUR_TELEGRAM_USER_ID"],
  "groups": {},
  "pending": {}
}
EOF
```
Your Telegram user ID is a numeric string (e.g., `"7628063924"`). You can also get it by DMing `@userinfobot` on Telegram.

#### 8. Verify

```bash
docker compose ps                    # all containers up
docker compose logs outlook-mcp      # "authenticated successfully"
docker compose logs gmail-mcp        # "Stored credentials for..."

# Check Claude session:
docker exec personal-assistant-claude bash -c "tmux capture-pane -t claude -p -S -10"
# Should show: Listening for channel messages from: server:email-watcher, server:telegram
```

### What persists across restarts (via volume mounts)

| Path | Content | Volume |
|------|---------|--------|
| `~/.claude/` | Claude OAuth tokens, plugin data | `CLAUDE_CONFIG_DIR` |
| `~/.claude/channels/telegram/access.json` | Telegram allowlist (survives rebuild) | same volume |
| `data/gmail/` | Gmail OAuth tokens + client_secret.json | `GMAIL_CREDS_DIR` |
| `data/outlook/token_cache.json` | Outlook MSAL token cache | `OUTLOOK_DATA_DIR` |
| `data/downloads/` | Downloaded invoices (for inspection) | `DOWNLOADS_DIR` |

## Windows local dev

```bash
# Set Claude config path in .env:
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
