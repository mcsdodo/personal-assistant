# Personal Assistant Stack

Event-driven personal assistant built on Claude Code Channels plus MCP tool servers.

This file holds what you need **before** choosing an approach. Detail lives beside the code:

| Where | What it owns |
|---|---|
| [docs/USE_CASES.md](docs/USE_CASES.md) | what this project delivers -- the single source of truth |
| [docs/architecture.md](docs/architecture.md) | services, the source-code guide, the intake pipeline |
| [docs/infrastructure.md](docs/infrastructure.md) | health checks, restart resilience, persistence, version pinning |
| [docs/claude-code-runtime.md](docs/claude-code-runtime.md) | auth, settings, flags, MCP config format |
| [docs/observability.md](docs/observability.md), [docs/uc1a-observability.md](docs/uc1a-observability.md) | metrics, events, traces |
| [pollers/CLAUDE.md](pollers/CLAUDE.md) | email + gdrive pollers, cursor safety, the loud guards |
| [checker-mcp/CLAUDE.md](checker-mcp/CLAUDE.md) | invoice matching engine and its layering |
| [shared/CLAUDE.md](shared/CLAUDE.md) | the dependency-free build constraint, the locked twin |
| [observability/CLAUDE.md](observability/CLAUDE.md) | dashboards and alert-rule deploy semantics |
| [claude-code/CLAUDE.md](claude-code/CLAUDE.md) | instructions the running Claude session reads |
| [tests/README.md](tests/README.md) | E2E suite: setup, fixtures, markers |

Running the stack locally, or debugging a local crash-loop: the `personal-assistant-local-dev`
skill. Debugging production: `debugging-personal-assistant`.

## This is a public repo

Developed in a private monorepo and published here, so **everything in this directory is
public the moment it syncs.** Use realistic placeholders, not site-specific values:
`documents.lan`, `invoices.lan`, `/mnt/shared_configs/<stack>/...`, `YOUR_DOCKER_HOST`,
`YOUR_OTEL_ENDPOINT`. Keep them concrete enough to map back to a real deployment.

**Internal task numbers are the most common leak** -- name the change instead ("an earlier
refactor split", not "task 64"). They read as harmless shorthand and cannot be unpublished by
a later reword.

[CHANGELOG.md](CHANGELOG.md) is written upstream and shipped **verbatim**, and
**there is no separate review pass between writing an entry and publishing it.** Scrub an
entry as you write it: name the change rather than its tracking id, no internal hostnames,
host IPs, deploy tooling or production data counts. Entries should read as release notes for
this project, not as notes to the team that wrote it.

## Keep the docs in step

[docs/USE_CASES.md](docs/USE_CASES.md) is the source of truth for scope. **After
implementation work, update the affected documentation as part of the task, not afterwards** --
the status column in `USE_CASES.md`, the detailed doc in `docs/`, and any pointer here that
changed.

**Update the file that owns a fact, not every file that mentions it.** This section used to
say "update all affected documentation", which produced two drifting copies of the same
tables; three docs were found stale in exactly that way. If a fact belongs to a doc, this
file should link to it rather than repeat it.

## Architecture

```
claude-code container (node:20-slim, user: node)
├── Claude Code session in tmux
├── telegram channel (official plugin, two-way)
├── file-ops tool server (stdio; scoped download/delete/decrypt/base64/env)
├── workflow-mcp channel+tools (stdio; durable job queue + 2s classification push loop)
└── subagents: email-classifier, document-classifier (haiku)

email-poller / gdrive-poller (bun)   -> write workflow.db directly, /health :9465 / :9466
pa-worker (bun)                      -> workerTick, sweepStaleGuidance, notifyTelegram, /health :8003
paperless-mcp / gmail-mcp            -> community images
checker-mcp (python, two-process)    -> matching tools :8001/mcp + Flask UI :5000
outlook-mcp (python)                 -> read-only Outlook tools :8002/mcp
```

**The pollers are pure data-path containers and that is the design.** They write straight
into `workflow.db`, independent of Claude Code's lifecycle, so an MCP-spawn race can never
break ingest. Only `telegram`, `file-ops` and `workflow-mcp` remain stdio channels, because
each needs the live Claude session. Everything else is a separate container over Streamable
HTTP (`"type": "http"` in `.mcp.json`).

The executor runs in its own `pa-worker` container: `workflow-mcp` writes a
`classification_request_meta` job event when the worker parks a job, and a 2 s push loop
inside `claude-code` drains those breadcrumbs into channel notifications. Cost is one poll
tick before Claude sees the request.

## Invoice direction decides what `vendor` means

The document-classifier returns `invoice_direction` -- `"incoming"`, `"outgoing"`, or `null` for a
document that is not an invoice or credit note. **Answer it before `vendor`, because it decides
which company on the page the vendor is:**

| direction | `vendor` is | printed |
|---|---|---|
| `incoming` | the seller | the letterhead |
| `outgoing` | the **buyer** | the buyer block, never the letterhead |

On an outgoing invoice `vendor` is **never** `${BUSINESS_COMPANY_NAME}`. We are the issuer, so our
own name is in the letterhead -- but the counterparty is the customer we billed. `vendor` drives
the Paperless correspondent **and the document title**, and the P&L accrual-income test reads the
title, so naming ourselves there files the invoice against us and drops the month out of income.

**This was undefined before, not merely mis-answered.** The contract had no direction field, so
`vendor` had no meaning for outgoing invoices at all, and the rule "look for the name near
IČO/DIČ" actively pointed at the letterhead -- which on an invoice we issue is us. The classifier
reached the right conclusion about direction and wrote it into `notes`, where nothing read it.

`owner` short-circuits on `"outgoing"` for the same reason: our identifiers sit on the **seller**
side there, so the buyer-side proof rule would force either `"personal"` or an invented
`owner_match_evidence`. It produced an invented one.

[checker-mcp/CLAUDE.md](checker-mcp/CLAUDE.md) owns how the checker consumes this.

## Business / personal owner model

The document-classifier returns an internal `owner` role -- `business`, `personal` or
`unknown` -- which **never appears directly as a Paperless tag or Telegram command**. The
`business` role maps to an external label from `OWNER_BUSINESS_LABEL`: `buildTagNames` pushes
that label for business documents and the literal `"personal"` for personal ones, and
`telegram-notify.ts` renders `set:owner=business` as `/<OWNER_BUSINESS_LABEL>`.

`OWNER_BUSINESS_LABEL` is **REQUIRED and has no code default** -- the stack throws at
startup if it is unset or empty, and `requireBusinessLabel()` enforces it at every read site.
That is a deliberate fail-loud choice; do not "helpfully" add a default.

## Do not start a second `claude` process inside `claude-code`

Starting an extra interactive session in its own tmux session -- to try a CLI flag, say --
coincided with the channel watchdog reporting `telegram/server.ts not running` and restarting
the container ~180 s later:

```
[watchdog] WARN: best-effort channel telegram/server.ts not running (Claude Code v2.1.x MCP race)
[watchdog] FATAL: ... missing for 18 checks (~180s) -- recovery restart attempt 1/3
```

It recovered on its own with no job loss, but the container that runs the whole email
pipeline is the wrong place to experiment. **Test CLI behaviour on a scratch host at the same
Claude Code version** -- flags change between releases and this image is version-pinned.

## HTTP MCPs showing "△ needs authentication"

**Symptom.** One or more HTTP MCPs (paperless, checker, gmail) show `△ needs authentication`
in `/mcp`, and calling their tools returns an `authenticate` placeholder instead of
executing. **The pipeline stalls silently** -- invoice jobs pile up in
`awaiting_classification` because Claude cannot fetch email bodies, while watchers and stdio
channels keep working (they have their own MCP clients), so the failure looks partial.

**Root cause.** Claude Code's MCP SDK persistently caches OAuth Dynamic Client Registration
discovery state under `mcpOAuth` in `~/.claude/.credentials.json`. Once an entry exists with
a non-empty `discoveryState`, the SDK treats that server as OAuth-protected on every startup,
even when `accessToken` is empty and the server returns plain 404s on `/register`. It
survives restarts because `data/claude-config/` is a host bind-mount.

**Fix, already in place:** `claude-code/entrypoint.sh` strips the whole `mcpOAuth` block on
every container start. We never use OAuth on any HTTP MCP here, so wiping it is always safe.
**Do not remove that line as pointless.**

Verification after a restart -- `tmux send-keys -t claude /mcp Enter`, then `capture-pane` --
should show all 4 HTTP MCPs as `✓ connected`. **Do NOT** automate this check from within
`entrypoint.sh`: keystroke-based MCP menu navigation against the live session races with
workflow channel notification delivery and silently interrupts in-progress jobs. The
reconnect script that did this was removed for exactly that reason.

Manual recovery commands: the `debugging-personal-assistant` skill.

## Stateless MCP sessions

`checker-mcp` and `outlook-mcp` run with `FASTMCP_STATELESS_HTTP=true`, so no session IDs are
assigned and server restarts are transparent to Claude Code. This works around a Claude Code
bug where cached session IDs cause **permanent** tool failures after a server restart.
Community servers (`paperless-mcp`, `gmail-mcp`) may still be stateful -- if they restart and
tool calls fail, restart `claude-code`.

## Testing

**When asked to verify, review or test this stack, run the tests. All of them.**

```bash
cd pollers && bun test
cd claude-code && bun test
```

E2E needs the local stack up. **Spin it up rather than declaring it unavailable** -- the
`.env` file is present locally with valid credentials, and `gmail-mcp` / `outlook-mcp` keep
their OAuth tokens across restarts, so they do not need re-authentication.

```bash
docker compose --profile local up -d --build      # wait ~90s for claude-code healthy
python -m pytest tests/ -v -m "not link" --timeout=300
```

Unit-test rules for bun tests live in [claude-code/channels/CLAUDE.md](claude-code/channels/CLAUDE.md);
E2E rules, fixtures and markers in [tests/README.md](tests/README.md), which is the fuller
copy -- do not duplicate it here. First-time local setup, including the three things a fresh
checkout must do before the stack stays healthy: the `personal-assistant-local-dev` skill.
