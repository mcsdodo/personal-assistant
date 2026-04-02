# Personal Assistant E2E Pipeline Tests

For the contributor overview, start with [`../docs/development.md`](../docs/development.md).

End-to-end tests for the email processing pipeline. Sends real emails, waits for the pipeline to process them, and verifies results in Paperless.

## Prerequisites

1. **Local compose stack running**:
   ```bash
   cd compose.stacks/infra/personal-assistant
   docker compose --profile local --env-file .env up -d
   ```

2. **Gmail OAuth token** — run once to authorize:
   ```bash
   python tests/helpers.py  # or trigger start_google_auth from Claude session
   ```

3. **Outlook auth active** — device code flow at startup:
   ```bash
   docker logs personal-assistant-outlook-mcp 2>&1 | grep -A3 "OUTLOOK AUTH"
   ```

4. **Python deps**:
   ```bash
   pip install pytest requests google-auth google-api-python-client
   ```

5. **Test data** in `tests/test_data/`:
   - `invoice.pdf` — Alza invoice
   - `fuel_invoice.pdf` — Slovnaft fuel receipt
   - `refund.pdf` — Alza credit note
   - `account_statement_locked.pdf` — encrypted Tatra banka statement
   - `personal.pdf` — personal document

## Running

```bash
cd compose.stacks/infra/personal-assistant

# All tests (slow — full pipeline resets between modules)
python -m pytest tests/ -v --timeout=300

# Gmail only
python -m pytest tests/test_email_gmail.py -v -x --timeout=300

# Outlook only
python -m pytest tests/test_email_outlook.py -v -x --timeout=300

# Download link test (needs SSH to host1 for test PDF server)
python -m pytest tests/test_email_link.py -v -x --timeout=300

# By marker
python -m pytest tests/ -v -m gmail --timeout=300
python -m pytest tests/ -v -m "not link" --timeout=300
```

## How it works

1. **Reset** — fixture stops claude-code, deletes DBs + Paperless data, restarts
2. **Seed** — waits for email-watcher to seed existing emails (so test emails are "new")
3. **Send** — sends test emails via Gmail API to +dev addresses
4. **Poll** — polls email-watcher SQLite DB until email reaches target status
5. **Verify** — checks Paperless API for uploaded documents with correct metadata

## Timing

Each test takes 60-180s due to:
- Gmail/Outlook delivery delay (~30s)
- Email-watcher poll cycle (30s)
- Claude classification + download + upload (~30-60s)
- Paperless processing (~10s)

The `reset_pipeline` fixture adds ~60s for container restart + seed.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERLESS_URL` | `http://localhost:8010/api` | Paperless API URL |
| `PAPERLESS_TOKEN` | (required, set in `.env`) | Paperless API token |

## Troubleshooting

- **TimeoutError**: Check `docker logs personal-assistant-claude` and the Claude tmux session
- **Gmail auth error**: Remove the local Gmail token cache from your configured data directory and re-run the auth flow
- **Outlook not polling**: Check `curl http://localhost:9465/metrics | grep outlook`
- **Duplicate detection**: Tests use `clean_paperless` fixture to wipe between tests, but duplicate emails from previous runs may be detected by Claude's email dedup logic
