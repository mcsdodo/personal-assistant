# Troubleshooting

## Claude container is up but nothing is happening

- Check `docker compose ps`
- Check the Claude session output:

```bash
docker exec personal-assistant-claude tmux capture-pane -t claude -p -S -60
```

## Health endpoint is failing

```bash
curl http://localhost:9465/health
curl http://localhost:9465/metrics
```

If health is stale, check whether Gmail or Outlook auth has expired.

## Gmail OAuth problems

- verify your OAuth client ID and secret
- confirm the OAuth client type is **Desktop app** (auto-allows `http://localhost` redirect)
- confirm the `gmail-mcp-auth` sidecar is running (`docker compose ps`)
- retry `start_google_auth` from the Claude session

## Outlook polling problems

Restart the Outlook container and inspect the device-code login output:

```bash
docker logs personal-assistant-outlook-mcp
```

## Paperless upload problems

- verify `PAPERLESS_URL`
- verify `PAPERLESS_API_TOKEN`
- confirm the Paperless instance is reachable from the containers

## E2E tests are timing out

- confirm the local stack is running
- confirm Paperless is ready
- confirm inbox auth is valid
- inspect `tests/README.md` and `docs/development.md`

## Duplicate detection is blocking expected uploads

The workflow intentionally pauses or short-circuits when it finds a likely match. Check the workflow state and Paperless documents before assuming the upload failed.
