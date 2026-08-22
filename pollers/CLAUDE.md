# Pollers

Two standalone Bun services -- `email-poller` and `gdrive-poller` -- that write directly into
`workflow.db`. They are **pure data-path containers**, independent of Claude Code's
lifecycle, which is the whole point: an MCP-spawn race inside `claude-code` can never break
ingest.

| Service | Polls | Creates | Audit DB | Health |
|---|---|---|---|---|
| `email-poller` | Gmail + Outlook every `POLL_INTERVAL_MS` (default 30s) | `invoice_intake` jobs | `emails.db` | `/health` :9465 |
| `gdrive-poller` | Drive `GDRIVE_LEVEL1` x `GDRIVE_LEVEL2` every 30s via gmail-mcp | `scan_intake` jobs | `gdrive.db` | `/health` :9466 |

Shared operational scaffolding is in [`lib/watcher-runtime.ts`](lib/watcher-runtime.ts):
`startHealthServer` (with the staleness check), `createManagedMcpClient` (singleton with
`.get()` / `.reset()`), `startPollLoop`. Domain logic stays in each poller.

---

## `email-poller/src/main.ts` is invisible to grep

The file contains **literal NUL bytes** -- a composite-key separator written as a raw
character instead of `\0`:

```ts
for (const state of JOB_STATES) counts[`${type}\0${state}`] = 0;
```

`file` therefore reports it as binary data, and **`grep -I`, ripgrep, ugrep and most editor
searches skip it silently** -- you get "no matches", not an error. That is a false negative,
and it is very easy to conclude from it that a symbol does not exist anywhere in this tree.

Search it with `command grep -a`, `git grep -a`, or Python. Replacing the raw NULs with `\0`
escapes would fix it permanently and change no behaviour.

## Transient-miss tolerance, and two coupled drop-forever defects (task 85)

**These are silent-data-loss guards. Do not simplify them.**

After a successful poll the cursor advances to **`now − POLL_OVERLAP`** (default `10min`),
not to wall-clock now, so every poll re-queries the last `POLL_OVERLAP` of receive-time. Any
transient reason a just-arrived email was not returned by the poll that should have caught it
-- Gmail search-index lag, delivery timing, a one-off API hiccup -- is recovered by a later
poll inside the window. `emailExists` dedup makes the re-fetch idempotent.

`POLL_OVERLAP` is parsed by `parseDuration`, which gained a `min` unit for this. **Note `m`
still means months, not minutes** -- a live footgun. Set `POLL_OVERLAP=0h` to restore the old
advance-to-now behaviour.

Two coupled defects were fixed in the same pass, both of which dropped emails **forever**:

1. **The per-cycle cap is now cursor-safe.** `MAX_NEW_PER_CYCLE` (default 5) processes the
   **oldest** N and does **not** advance the cursor, emitting
   `email_watcher.new_cap_exceeded{source=...}`, so the next poll drains the remainder. It
   used to advance the cursor past the emails it had not processed.
2. **Page size is 200 with a loud truncation signal.** Gmail `search_gmail_messages` reads
   `page_size=200` and Outlook `list_emails` `top=200`; a full page emits
   `email_watcher.search_page_full{source=...}`. True `page_token` pagination is
   deliberately deferred -- that counter firing is the cue to build it.

## Catchup overflow, and the escape hatch

If one cycle sees more than `MAX_CATCHUP_EMAILS` new emails for a source (default **150**,
which must stay below the 200 page size or the guard is unreachable), the poller logs
`ERROR: <source> catchup overflow`, bumps `email_watcher.catchup_overflow{source=...}` and
**does not advance `last_checked`**. It fails loud and stops rather than quietly skipping.

```bash
docker exec <stack>-email-poller bun /app/email-poller/cli/skip-catchup.ts gmail
```

That advances `last_checked = now` so the next cycle starts fresh.

## First deploy

On a fresh deploy `emails.db` has no `source_state` rows, so the poller seeds `last_checked`
per enabled source from `INITIAL_LOOKBACK` (default `3d`). To choose a different window set
`INITIAL_LOOKBACK=1w` (or `12h`, `24h`) **before** the first deploy -- after the first cycle
the row exists and the variable is ignored.

Post-deploy, confirm the `Config:` log line shows `overlap=10min` and watch one cycle for the
`now − overlap` cursor write.

## Owner model

`gdrive-poller` maps an owner folder to a role: `OWNER_BUSINESS_LABEL` -> `business`,
`personal` -> `personal`, and writes explicit `owner`, `bucket` and `folder_id` on every
`scan_intake` job. `OWNER_BUSINESS_LABEL` is **REQUIRED with no code default** -- see the
stack [CLAUDE.md](../CLAUDE.md).

## Metrics

Meters are `email-poller` and `gdrive-poller`, but the **emitted series still start
`email_watcher.` / `gdrive_watcher.`**. That mismatch is deliberate: dashboards and Grafana
alert rules query the series names, so renaming them to match the services would silently
break both. Do not tidy it.
