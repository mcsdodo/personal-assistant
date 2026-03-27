# Personal Assistant Stack — Local Dev

Event-driven personal assistant: Claude Code (Sonnet) + Haiku subagents + MCP tool servers + channels (email-watcher, Telegram).

## Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| claude-code | local build | 9465 (metrics) | Claude Code + channels + subagents + remote control |
| paperless-mcp | ghcr.io/baruchiro/paperless-mcp | 3000 | Paperless-ngx CRUD (20 tools) |
| checker-mcp | local build | 8001 | Invoice matching + P&L (4 tools) |
| gmail-mcp | ghcr.io/taylorwilsdon/google_workspace_mcp | 8000 | Gmail read-only (OAuth via `gmail-mcp.lacny.me`) |
| outlook-mcp | local build | 8002 | Outlook read-only (MSAL device code auth) |

## Folder Structure

```
personal-assistant/
  CLAUDE.md                    # Stack docs (always read this first)
  docker-compose.yml           # Production compose (Komodo deploys this)
  local/
    docker-compose.yml         # Local dev overlay (build contexts + observability)
    .env / .env.example        # Local dev secrets
    claude-code/               # Dockerfile + channels + agents
    checker-mcp/               # Dockerfile + match_invoices.py
    outlook-mcp/               # Dockerfile + MSAL server
    observability/             # Alloy, Prometheus, Loki, Grafana configs
    data/                      # Gitignored: auth tokens, SQLite DB, downloads
```

## Production Deployment (Komodo)

Everything is managed by Komodo. No manual host setup needed.

```powershell
cd compose.stacks/_komodo
.\komodo.ps1 -Stack personal-assistant   # builds 3 images + deploys
```

Komodo handles: secrets (core.config.toml), builds (3 Dockerfiles), deploy (procedure), env vars.
Docker auto-creates bind mount dirs on `/mnt/shared_configs/personal-assistant/`.
Entrypoint creates `settings.json` on first boot. Gmail `client_secret.json` generated from env var.

### Post-deploy auth (one-time, per service)

**Claude Code:**
```bash
docker exec -it personal-assistant-claude claude login
```

**Outlook** (device code expires in 15 min — restart container for fresh code):
```bash
docker restart personal-assistant-outlook-mcp
docker logs personal-assistant-outlook-mcp 2>&1 | grep -A3 "OUTLOOK AUTH"
# Open URL, enter code, sign in. Token cached automatically.
```

**Gmail** (permanent OAuth via `gmail-mcp.lacny.me`):
Trigger from Claude session (Remote Control or tmux):
```
call start_google_auth with service_name gmail and user_google_email lacny.jozef@gmail.com
```
Open the returned URL, approve. Callback goes to `https://gmail-mcp.lacny.me/oauth2callback`.
Requires: `https://gmail-mcp.lacny.me/oauth2callback` in Google Cloud Console authorized redirect URIs.

**Telegram:**
1. DM the bot in Telegram
2. Pre-seeded access.json in `claude-config/channels/telegram/` handles pairing
3. If new pairing needed: read `access.json` for pending entry, add user ID to allowlist

### After auth, restart Claude to reconnect all MCPs:
```bash
docker restart personal-assistant-claude
```

## Local Dev

```bash
# From compose.stacks/infra/personal-assistant/
docker compose -f docker-compose.yml -f local/docker-compose.yml --env-file local/.env up --build

# View Claude session
docker exec -it personal-assistant-claude tmux attach -t claude

# Capture without attaching
docker exec personal-assistant-claude tmux capture-pane -t claude -p -S -30
```

Local dev overrides the production NAS mounts with local bind mounts by default:

- `./local/data/claude-config` -> `/home/node/.claude`
- `./local/data/downloads` -> `/workspace/downloads`
- `./local/data/email-watcher` -> `/data/email-watcher`
- `./local/data/outlook` -> `/data`

If you want to reuse your desktop Claude login temporarily for debugging, set `CLAUDE_CONFIG_DIR` in `local/.env` to a writable local path that contains your `.claude` files. The intended local setup is app-owned state in `./local/data/claude-config`.

Local dev adds build contexts for the 3 custom images + observability sidecar (Alloy + Prometheus + Loki + Grafana).

| Service | Local URL |
|---------|-----------|
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9091 |
| Loki | http://localhost:3101 |
| Alloy UI | http://localhost:12345 |

## Persistent Data (NAS-backed)

| Host path | Container path | Content |
|-----------|---------------|---------|
| `/mnt/shared_configs/personal-assistant/claude-config` | `/home/node/.claude` | Claude OAuth, settings, Telegram access |
| `/mnt/shared_configs/personal-assistant/gmail` | `/app/store_creds` | Gmail OAuth tokens |
| `/mnt/shared_configs/personal-assistant/outlook` | `/data` | Outlook MSAL token cache |
| `/mnt/shared_configs/personal-assistant/email-watcher` | `/data/email-watcher` | SQLite audit trail |
| `/mnt/shared_configs/personal-assistant/downloads` | `/workspace/downloads` | Downloaded invoices |
