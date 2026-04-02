# Getting started

This guide gets the stack running locally with the `local` Docker Compose profile.

## What you need

- Docker and Docker Compose
- A Paperless-ngx API token
- Claude Code access for the `claude-code` container
- At least one inbox provider:
  - Gmail with Google OAuth desktop credentials
  - Outlook with Azure `Mail.Read`

Optional:

- Telegram bot credentials for notifications
- Google Drive access for scan ingestion
- An OTLP endpoint if you want external telemetry instead of the local profile

## 1. Configure environment variables

```bash
cp .env.example .env
```

Then edit `.env`.

Minimum useful local setup:

- `PAPERLESS_URL`
- `PAPERLESS_API_TOKEN`
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` or `AZURE_CLIENT_ID`
- `GMAIL_EMAIL` if Gmail is enabled

See `docs/configuration.md` for a grouped reference.

## 2. Start the local profile

```bash
docker compose --profile local --env-file .env up --build
```

The `local` profile also starts:

- a local Paperless stack
- Grafana
- Prometheus
- Loki
- Alloy

By default, local Paperless is available at `http://localhost:8010`.

## 3. Create a Paperless API token

1. Open `http://localhost:8010`
2. Create a Paperless superuser if needed:

```bash
docker compose exec paperless python3 manage.py createsuperuser
```

3. In the Paperless UI, go to Settings -> API Tokens
4. Copy the token into `.env` as `PAPERLESS_API_TOKEN`

## 4. Authenticate Claude Code

```bash
docker exec -it personal-assistant-claude claude login
docker restart personal-assistant-claude
```

## 5. Authenticate inbox providers

### Gmail

Trigger `start_google_auth` from inside the Claude session. Use a redirect URI such as `https://gmail-mcp.lan/oauth2callback` in public docs and map it to your real deployment.

### Outlook

Restart the Outlook container and check logs for the device-code URL and code:

```bash
docker logs personal-assistant-outlook-mcp
```

### Telegram

Message the bot after setting `TELEGRAM_BOT_TOKEN` and optionally `TELEGRAM_CHAT_ID`.

## 6. Send a smoke test

Try one of these:

- send a test invoice to the configured inbox
- place a PDF in a watched Google Drive folder
- run one of the end-to-end tests from `docs/development.md`

## 7. Check health

Useful checks:

```bash
docker compose ps
curl http://localhost:9465/health
curl http://localhost:9465/metrics
```

## Next reads

- `docs/configuration.md`
- `docs/architecture.md`
- `docs/development.md`
- `docs/troubleshooting.md`
