# Code Review: Testing Strategy & Architecture Simplification

**Date:** 2026-03-31
**Scope:** Testing strategy, unit test coverage gaps, integration test approach, local vs production deployment complexity

---

## 1. Current Testing Architecture

### Two-tier structure

| Tier | Location | Framework | Tests | Runtime | External deps |
|------|----------|-----------|-------|---------|---------------|
| Unit tests | `claude-code/channels/*.test.ts` | `bun test` | ~68 | Seconds | None |
| Unit tests | `checker-mcp/test_matching.py` | `pytest` | 113 | Seconds | None (mocked Paperless) |
| E2E tests | `tests/test_email_*.py` | `pytest` | 11 | 20+ min | Real Gmail, Outlook, Docker, Paperless, SSH |
| Golden regression | `checker-mcp/test_golden.py` | Standalone script | 1 | Minutes | Real Paperless (production data) |

### What works well

- `checker-mcp/test_matching.py` is **exemplary**: 113 tests, fully mocked `PaperlessClient`, excellent isolation, covers pure functions and integration paths
- `invoice-worker.test.ts` has solid fetch mocking infrastructure (sequential handler array, RPC response factories, temp SQLite per test)
- `fuzzy-match.test.ts`, `invoice-links.test.ts` are clean pure-function tests with real-world fixtures
- Test data committed to repo (4 PDFs covering invoice/fuel/credit/encrypted statement)

---

## 2. Testing Gaps by Severity

### HIGH: Near-zero coverage

| Source file | Lines | Tests | Gap |
|-------------|-------|-------|-----|
| `email-watcher.ts` | 1266 | `email-watcher.test.ts` tests **only** `filterEmailsByRecipient` (a helper function). Zero coverage of: `pollGmail`, `pollOutlook`, `pollCycle`, `processNewEmails`, `retryStuckEmails`, `renderMetrics`, `startMetricsServer`, all 6 MCP tool handlers, `parseToolResult`, `extractGmailIds`, `parseGmailEmails`, `buildGmailQuery`, `parseDuration`, catchup flow, client reconnection | ~0% of actual watcher logic |
| `invoice-worker.ts` (`executeScanIntake`) | ~180 lines (915-1099) | Zero tests | GDrive intake path completely untested |
| `invoice-worker.ts` (Gmail download) | ~60 lines | Zero tests | Only Outlook attachment path tested; Gmail branch in `downloadAttachment` skipped |

### MEDIUM: Partial coverage with meaningful gaps

| Source file | Tested | Missing |
|-------------|--------|---------|
| `download-helper.ts` (98 lines) | `readFileAsDownload` only (4 tests) | `tryDecrypt` (PDF decryption), CLI `main`, HEIC detection, unknown extension handling |
| `workflow-core.ts` (146 lines) | Only `synthetic` workflow type (3 tests) | `invoice_intake` dispatch, `scan_intake` dispatch, unknown workflow type, crash handling, trace parent resolution |
| `db.ts` (266 lines) | Good CRUD coverage | `getLastChecked`/`setLastChecked` (checkpoint tracking), `getEmailTraceId`, trace_id migration |
| `workflow-db.ts` (317 lines) | Core lifecycle covered | `cancelJob` from different states, `claimNextQueuedJob` contention, timestamp assertions, `listJobs` limit |
| `gdrive-watcher.ts` (747 lines) | Zero tests | No test file exists at all |
| `gdrive-db.ts` (155 lines) | Zero tests | No test file exists at all |

### LOW: Nice to have

| Source file | Gap |
|-------------|-----|
| `fuzzy-match.ts` | `normalizeName`, `stripLegalSuffix`, `jaroWinkler` not tested directly (only via `findBestCorrespondentMatch`) |
| `download-helper.ts` | Zero-byte files, spaces in paths |
| `paperless-fields.ts` | API failure on initial list fetch, network errors (fetch throws) |

---

## 3. E2E Test Problems

### 3.1 Requires full local deployment

Every E2E test requires the full stack running locally:
- `docker compose --profile local --env-file .env up`
- Real Gmail OAuth credentials at `C:\_dev\invoice-automation\config\token.json`
- Real Outlook MSAL auth (device code flow)
- Paperless-ngx + PostgreSQL + Redis
- For link tests: SSH access to `host1` (192.168.0.96) to spin up nginx

This means E2E tests **cannot run in CI** and are **developer-machine-only**.

### 3.2 Test isolation issues

- **Module-scoped reset**: `reset_pipeline` runs once per module, not per test. Tests within a module share email-watcher DB state.
- **DB not wiped between tests**: `clean_paperless` wipes Paperless but NOT the email-watcher SQLite. Previously processed emails remain, causing order-dependent duplicate detection.
- **Tests handle this with fallback assertions** (e.g., `assert status in ["processed", "duplicate"]`), which weakens the test — a real duplicate bug would be masked.
- **Misleading fixture names**: `reset_pipeline_gmail_only` and `reset_pipeline_outlook_only` do the same thing (seed both sources).
- **Static order IDs**: Link tests use hardcoded `999000111`/`999000222` — re-runs without full reset can trigger false duplicates.

### 3.3 Hardcoded infrastructure

- `helpers.py` line 42: Hardcoded Paperless API token fallback (`890b1029...`)
- `helpers.py` lines 32-33: Windows-specific credential paths (`C:\_dev\invoice-automation\config\`)
- `helpers.py` line 321: Likely bug — `'rows' in dir()` should be `'rows' in locals()`
- `test_email_link.py`: SSH to `192.168.0.96` + Docker commands over SSH for PDF server

### 3.4 Asymmetric coverage

- Gmail tests: 6 scenarios (including `test_personal_invoice`)
- Outlook tests: 5 scenarios (missing `test_personal_invoice`)

---

## 4. Local vs Production Setup Complexity

### 4.1 Current architecture

```
Production:  docker-compose.yml (5 services, pre-built images, NAS volumes)
                  |
Local dev:   docker compose --profile local --env-file .env
             (override: build contexts + 8 additional services + local volumes)
```

### 4.2 Pain points

1. **~~Long invocation~~** *(resolved)*: Previously required `-f docker-compose.yml -f local/docker-compose.yml --env-file local/.env`. Now uses `--profile local --env-file .env`. Forgetting `--profile local` still falls back to production config (NAS mounts), but the command is shorter and harder to get wrong.

2. **Volume override relies on undocumented Docker Compose merge behavior**: The overlay replaces NAS-backed volumes with local paths because they share the same container mount point. This is correct but non-obvious — no comments explain it in either file.

3. **`gmail-mcp` entrypoint divergence**: Production uses a shell hack to write `client_secret.json` from an env var. Local overlay completely replaces entrypoint+command with file mount. Different startup code paths between environments.

4. **Local overlay does triple duty**: build context provider + observability stack (Alloy/Prometheus/Loki/Tempo/Grafana) + local Paperless (Paperless/Postgres/Redis). All 8 extra services start every time, even when you only need the core pipeline.

5. **Missing env vars in `.env.example`**: `BANK_PDF_PASSWORD`, `GDRIVE_LEVEL1`/`GDRIVE_LEVEL2`/`GDRIVE_MCP_URL` are used in production but absent from the local env example.

6. **Tempo defined but possibly unused**: No `TEMPO_URL` env var, no visible Alloy config forwarding traces to it.

7. **Port confusion**: `PAPERLESS_URL=http://paperless:8000` (container-to-container) vs Paperless exposed on `8010` externally. Correct but confusing.

---

## 5. Recommendations

### 5.1 Unit test coverage (highest ROI)

**Priority 1: Extract and test pure functions from `email-watcher.ts`**

The 1266-line email-watcher has many testable pure functions buried inside it:
- `extractGmailIds(result)` — parses multiple Gmail ID formats
- `parseGmailEmails(result)` — parses Gmail response formats
- `buildGmailQuery(base, afterTimestamp)` — constructs search queries
- `parseDuration(str)` — parses `"2h"`, `"7d"`, `"1w"`, `"3m"` strings
- `renderMetrics(db)` — generates Prometheus exposition format

**Action**: Extract these into a separate `email-watcher-utils.ts` module and add unit tests. This alone would cover the most critical parsing/formatting logic without needing to mock MCP clients.

**Priority 2: Add `gdrive-watcher.test.ts` and `gdrive-db.test.ts`**

These have zero test files. At minimum, `gdrive-db.ts` (155 lines) should have the same CRUD coverage as `db.test.ts`.

**Priority 3: Test `executeScanIntake` in `invoice-worker.test.ts`**

The GDrive intake path (~180 lines) shares infrastructure with email intake (same fetch mocking, same DB setup). Adding 5-10 tests for the scan path would be low effort given the existing test infrastructure.

**Priority 4: Test `tryDecrypt` in `download-helper.test.ts`**

PDF decryption is critical for bank statement processing. The function shells out to `qpdf` — mock `Bun.spawn` to test password success/failure paths.

### 5.2 Integration tests with mocked dependencies

**Introduce a middle tier**: tests that exercise real business logic against mocked external services (Gmail MCP, Outlook MCP, Paperless API) — without requiring Docker containers.

Candidate approach:
```
Unit tests (bun test)          — pure functions, DB operations, fetch mocking
                                  [seconds, no deps]

Integration tests (bun test)   — email-watcher poll cycle, invoice-worker pipeline,
                                  workflow lifecycle with mocked MCP responses
                                  [seconds, mocked HTTP]

E2E smoke tests (pytest)       — 2-3 critical paths against local stack
                                  [minutes, requires Docker]
```

**Concrete steps:**
1. Create `email-watcher.integration.test.ts` that mocks the MCP HTTP endpoints (fetch mock returning canned Gmail/Outlook responses) and verifies the full poll-detect-notify cycle
2. Create `workflow-lifecycle.integration.test.ts` that creates a job, runs `executeNextJob` with fully mocked Paperless/Gmail fetch responses, and verifies the job completes with correct state + events
3. Reduce E2E tests to 2-3 critical smoke tests (one Gmail, one Outlook, one link download) that validate the Docker integration works

### 5.3 ~~Simplify local/production setup~~ (done)

**Implemented:** Docker Compose profiles. The `local/` directory was eliminated — `local/docker-compose.yml` merged into `docker-compose.yml` with a `local` profile, config files moved to project root.

Usage:
```bash
# Local dev (all services + observability + local Paperless)
docker compose --profile local --env-file .env up --build
```

**Remaining items:**
- Add missing env vars to `.env.example` (`BANK_PDF_PASSWORD`, `GDRIVE_LEVEL1`, `GDRIVE_LEVEL2`, `GDRIVE_MCP_URL`)
- Unify `gmail-mcp` entrypoint (init script that checks for file before writing from env)
- Remove Tempo if unused, or add the Alloy forwarding config

### 5.4 E2E test fixes

1. **Rename `email-watcher.test.ts`** to `email-filter.test.ts` (it only tests filtering)
2. **Fix fixture names**: `reset_pipeline_gmail_only` / `reset_pipeline_outlook_only` do the same thing — either differentiate them or merge into one
3. **Add per-test email-watcher DB reset** or use unique subjects/IDs per test to avoid cross-test duplicate detection
4. **Remove hardcoded token fallback** in `helpers.py` — require `PAPERLESS_API_TOKEN` env var
5. **Fix `'rows' in dir()` bug** in `helpers.py` line 321 — should be `'rows' in locals()`

---

## 6. Effort Estimates

| Task | Effort | Impact |
|------|--------|--------|
| Extract + test email-watcher pure functions | 2-3h | High — covers biggest gap |
| Add `gdrive-db.test.ts` | 1h | Medium — mirrors existing db.test.ts |
| Add `executeScanIntake` tests | 2h | High — uses existing test infra |
| Add `tryDecrypt` tests | 30min | Medium — critical path |
| Create integration test tier (mocked MCP) | 4-6h | High — enables CI, reduces E2E reliance |
| Simplify compose with profiles | 2-3h | Medium — DX improvement |
| Fix E2E isolation issues | 1-2h | Medium — prevents false passes |
| Add missing `.env.example` vars | 15min | Low — documentation |
