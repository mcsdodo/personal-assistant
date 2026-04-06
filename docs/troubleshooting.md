# Troubleshooting

## Claude container is up but nothing is happening

- Check `docker compose ps`
- Check the Claude session output:

```bash
docker exec personal-assistant-claude tmux capture-pane -t claude -p -S -60
```

## HTTP MCPs show ✘ failed at startup

The `claude-code` entrypoint runs a state-aware reconnect script that drives the `/mcp` TUI via `tmux send-keys` for each HTTP MCP server (`checker`, `gmail`, `outlook`, `paperless`). If a server still shows `✘ failed` after the container has been up for a minute or two:

1. Check `docker logs personal-assistant-claude` for the `Reconnecting HTTP MCP servers...` block — does it report `✓` or `✗` for each?
2. If `✗`, the menu layout may have changed in a Claude Code update, breaking the regex assumptions in `reconnect_mcp`. See [claude-code-runtime.md](claude-code-runtime.md#http-mcp-reconnect-workaround).
3. Manual fallback: `docker exec -it personal-assistant-claude tmux attach -t claude`, then `/mcp`, navigate to the failed server, press Enter, navigate to Reconnect, press Enter.

This is a workaround for [anthropics/claude-code#34008](https://github.com/anthropics/claude-code/issues/34008), an unfixed upstream bug where Claude Code marks HTTP MCPs as `failed` at startup even when the upstream servers are healthy.

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
