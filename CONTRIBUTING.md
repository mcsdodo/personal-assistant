# Contributing

Thanks for your interest in improving Personal Assistant.

## Before You Start

- Open an issue for large changes before writing code.
- Keep pull requests focused and easy to review.
- Update docs when behavior, setup, or architecture changes.
- Do not commit secrets, OAuth tokens, `.env` files, or private test data.

## Development Setup

```bash
cp .env.example .env
docker compose --profile local --env-file .env up --build
```

For a full walkthrough, see `docs/getting-started.md`.

## Running Tests

```bash
# TypeScript channels and workflow tests
cd claude-code/channels
bun install
bun test

# Python matcher tests
cd ../../checker-mcp
python -m pytest test_matching.py -v

# End-to-end pipeline tests
cd ..
python -m pytest tests/ -v --timeout=300
```

For test prerequisites and troubleshooting, see `docs/development.md`.

## Documentation Conventions

- The README is for first-time users and evaluators.
- Put detailed setup, architecture, and troubleshooting content in `docs/`.
- Public docs intentionally use realistic placeholders such as `documents.lan`, `gmail-mcp.lan`, `/mnt/shared_configs/<stack>/`, and `YOUR_OTEL_ENDPOINT`.
- Keep placeholder usage consistent across the repo.

## Pull Request Checklist

- Explain the problem and the reason for the change.
- Link any related issue.
- Keep examples and commands accurate.
- Run the relevant tests for the files you changed.
- Update `docs/USE_CASES.md` and related docs when feature behavior changes.

## Scope Notes

- This project is self-hosted and integrates with third-party systems such as Paperless-ngx, Gmail, Outlook, Telegram, and Google Drive.
- Some examples are intentionally generic so the repo stays public-friendly while still matching the real architecture.
