# Channel unit tests — authoring rules

Rules for writing bun unit tests in this folder (`*.test.ts`). Integration-style bun tests (`*.integration.test.ts`) live in the same folder and follow the same rules.

## Rule: Test fixtures must match production writers

**Test fixtures MUST write to DB columns using the same format the production code writes.** If production uses `nowIso()` (ISO 8601 `YYYY-MM-DDTHH:MM:SS.mmmZ`), tests must too. Do NOT use SQLite shortcuts like `datetime('now', '-10 minutes')` to backdate rows — that emits the space-separated format `YYYY-MM-DD HH:MM:SS`, which silently hides string-comparison bugs.

### Why this rule exists

`reclaimStaleJobs` in `workflow-core.ts` had a production bug for an unknown duration: its query `WHERE updated_at < datetime('now', '-5 minutes')` compared against space format, but every code path writes `updated_at` via `nowIso()` (ISO with `T` and `Z`). ASCII `'T'` (84) > `' '` (32), so same-date ISO timestamps **always sort greater** than same-date space timestamps. The query matched zero rows, stale jobs accumulated forever, and backlog grew silently. Five tests for `reclaimStaleJobs` were green because they used `datetime('now','-10 minutes')` — the exact shortcut that hid the bug.

### How to apply

- **Backdating a row:** use `new Date(Date.now() - minutes * 60 * 1000).toISOString()` bound as a `?` parameter, never `datetime('now', '-N minutes')` inline in SQL.
- **Stamping "now":** use `new Date().toISOString()`, not `datetime('now')`.
- **Any column written by production code via `nowIso()`** (`updated_at`, `started_at`, `completed_at`, `scheduled_at`, `created_at` on updates) must use ISO format in test fixtures.
- **Columns that only rely on schema defaults** (e.g. `emails.discovered_at`, never written explicitly by production) are safe either way — production and tests both get space format from the `DEFAULT (datetime('now'))` clause.
- **When adding any new timestamp column comparison in production SQL**, write a regression test using an ISO-format fixture, and verify the test fails without the comparison (watch it go RED) before trusting it.

See `workflow-core.test.ts` (stale job reclamation block, `minutesAgoIso` helper) for the reference pattern.

## Rule: bun runs these files, and bun does not typecheck

**CI is `bun test` and nothing else** -- no `tsc`, no typecheck job. Bun strips types rather than checking them, so a **missing or misspelt import does not fail the build: it ships green and throws at runtime**, in a container, on the first request that reaches the broken path. This bites hardest after a refactor that moves or renames a module -- every test can pass while a production-only path references a symbol that no longer resolves.

So after any refactor here, and before deploying one, run the check CI does not:

```bash
bunx tsc --noEmit
```

Read it for **TS2304** (`Cannot find name`) and **TS2307** (`Cannot find module`) -- those two correspond to this failure mode; other diagnostics in a bun codebase are frequently noise. The same applies to the voice-assistant channels, which are built the same way.
