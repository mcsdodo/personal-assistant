# Development

This page covers tests, local workflows, and contributor-oriented setup.

## Local stack

```bash
cp .env.example .env
docker compose --profile local --env-file .env up --build
```

## Test suites

### TypeScript channels and workflow

```bash
cd claude-code/channels
bun install
bun test
```

### Python invoice matching

```bash
cd checker-mcp
python -m pytest test_matching.py -v
```

### End-to-end pipeline

```bash
python -m pytest tests/ -v --timeout=300
```

## E2E prerequisites

1. Start the local stack with the `local` profile.
2. Ensure Paperless is reachable at the URL configured in `.env`.
3. Complete Gmail OAuth and/or Outlook device-code auth.
4. Install Python test dependencies as needed.

```bash
pip install pytest requests google-auth google-api-python-client
```

## What the E2E tests do

1. Reset the pipeline state
2. Seed watcher checkpoints
3. Send or stage test input
4. Poll SQLite audit state until the workflow completes
5. Verify the result in Paperless

## Useful commands

```bash
docker compose --profile local --env-file .env ps
docker exec personal-assistant-claude tmux capture-pane -t claude -p -S -30
curl http://localhost:9465/health
curl http://localhost:9465/metrics
```

## Related docs

- `CONTRIBUTING.md`
- `docs/getting-started.md`
- `docs/troubleshooting.md`
- `tests/README.md`
