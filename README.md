# Personal Assistant Stack

Event-driven personal assistant: Claude Code + MCP tool servers + channels.

## Prerequisites

- Docker + Docker Compose
- Claude MAX subscription (`claude login` on host)
- Google Cloud project with Gmail API enabled (for Gmail)
- Azure AD app registration with `Mail.Read` permission (for Outlook)

## Setup

### 1. Configure

```bash
cp .env.example .env
# Fill in your credentials
```

### 2. Claude Code auth (one-time)

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

Tokens saved to `~/.claude/`, volume-mounted into container.

### 3. Gmail auth

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → OAuth Client ID → Desktop App → Download JSON
2. Save as `data/gmail/client_secret.json`
3. OAuth consent screen → Add scope `gmail.readonly` → Add your email as test user
4. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in `.env`

### 4. Outlook auth

1. [Azure Portal](https://portal.azure.com) → App registrations → New → Add delegated `Mail.Read` permission
2. Set `AZURE_CLIENT_ID` in `.env`

### 5. Start

```bash
docker compose up -d --build
```

### 6. Complete auth

**Outlook** — check logs, enter the code at the URL shown:
```bash
docker compose logs outlook-mcp
# Shows: Open https://www.microsoft.com/link → Enter: XXXXXXXX
```

**Gmail** — ask Claude to authenticate (via remote control session or tmux):
```
use gmail start_google_auth with service_name gmail and user_google_email you@gmail.com
```
Opens auth URL → approve in browser → callback hits `localhost:8000` → done.

### 7. Verify

```bash
docker compose ps                    # all containers up
docker compose logs outlook-mcp      # "authenticated successfully"
docker compose logs gmail-mcp        # "Stored credentials for..."
```

## Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| claude-code | local build | — | Claude Code + channels + remote control |
| paperless-mcp | ghcr.io/baruchiro/paperless-mcp | 3000 | Paperless-ngx CRUD (20 tools) |
| checker-mcp | local build | 8001 | Invoice matching + P&L (4 tools) |
| gmail-mcp | ghcr.io/taylorwilsdon/google_workspace_mcp | 8000 | Gmail read-only |
| outlook-mcp | local build | 8002 | Outlook read-only (device code auth) |

## Windows local dev

```bash
# Set Claude config path in .env:
CLAUDE_CONFIG_DIR=C:/Users/YourUser/.claude

docker compose up -d --build
```
