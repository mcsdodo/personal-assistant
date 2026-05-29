# Configuration

Configuration is environment-variable driven. Copy `.env.example` to `.env` and adjust values for your environment.

## Placeholder conventions

Public docs use realistic placeholders such as:

- `documents.lan`
- `/mnt/shared_configs/<stack>/`
- `YOUR_DOCKER_HOST`
- `YOUR_OTEL_ENDPOINT`

Map them to your own environment when deploying.

## Core variables

| Group | Variables | Notes |
|---|---|---|
| Paperless | `PAPERLESS_URL`, `PAPERLESS_API_TOKEN` | Required |
| Gmail | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GMAIL_EMAIL` | Required for Gmail intake |
| Outlook | `AZURE_CLIENT_ID`, `OUTLOOK_ENABLED` | Set `OUTLOOK_ENABLED=false` to skip |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional notifications |
| Drive | `GDRIVE_LEVEL1`, `GDRIVE_LEVEL2`, `GDRIVE_MCP_URL` | Optional scan workflow |
| Business identity | `BUSINESS_COMPANY_NAME`, `BUSINESS_TAX_IDS`, `BUSINESS_CRN`, `BUSINESS_LICENSE_PLATES` | Helps ownership detection |
| Polling | `POLL_INTERVAL_MS`, `WORKFLOW_POLL_MS` | Poll and worker timing |
| Telemetry | `OTEL_ENDPOINT`, `OTEL_METRIC_INTERVAL` | Optional external OTLP export |
| Storage | `PA_DATA_DIR`, `GMAIL_CLIENT_SECRET_FILE` | Local paths and mounted data |

## Authentication overview

### Claude Code

```bash
docker exec -it personal-assistant-claude claude login
```

### Gmail OAuth

- Configure Google OAuth desktop credentials.
- Trigger `start_google_auth` from the Claude session.
- The `gmail-mcp-auth` Caddy sidecar protects the MCP endpoint with a bearer token while passing the OAuth callback (`/oauth2callback`) through without auth.

### Outlook device code

- Set `AZURE_CLIENT_ID`.
- Restart the Outlook container and finish the device-code login shown in container logs.

### Telegram

- Create a bot via BotFather.
- Set `TELEGRAM_BOT_TOKEN`.
- Optionally pin chat access with `TELEGRAM_CHAT_ID`.

## Storage and persistence

The stack persists runtime state such as:

- Claude credentials
- downloads
- email and workflow SQLite databases
- Gmail OAuth tokens
- Outlook token cache

Local development typically uses `./data`.

Production examples in public docs use `/mnt/shared_configs/<stack>/...` to represent a mounted persistent volume.

## Local profile vs external services

The `local` profile is aimed at development and quick testing. It includes local observability services and a local Paperless instance.

For longer-lived deployments you will likely provide:

- an external Paperless instance
- your own reverse proxy and public callback domains
- persistent storage mounts
- your own OTLP endpoint, if used

## Related docs

- [getting-started.md](getting-started.md)
- [architecture.md](architecture.md)
- [observability.md](observability.md)
