# UC-1: Invoice Processing (email → Paperless)

Automated pipeline: poll Gmail + Outlook → classify email with Haiku → download PDF → classify document with Haiku → process via durable workflow → upload to Paperless-ngx → notify via Telegram.

## Architecture

### Container Boundaries

```mermaid
flowchart LR
    subgraph cc["claude-code container (node:20-slim)"]
        direction TB
        claude["Claude CLI (Sonnet)"]
        ew["email-watcher<br/>(stdio channel)"]
        tg["telegram<br/>(stdio channel)"]
        wf["workflow-mcp<br/>(stdio server)<br/>includes invoice-worker"]
    end

    subgraph mcp["MCP containers"]
        gmail["gmail-mcp :8000"]
        outlook["outlook-mcp :8002"]
        paperless["paperless-mcp :3000"]
        checker["checker-mcp :8001"]
    end

    ew -.->|polls via HTTP| gmail
    ew -.->|polls via HTTP| outlook
    wf -.->|callMcpTool HTTP| gmail
    wf -.->|callMcpTool HTTP| outlook
    wf -.->|callMcpTool HTTP| paperless
```

### Pipeline Flow

```mermaid
sequenceDiagram
    participant G as Gmail/Outlook MCPs
    participant EW as email-watcher<br/>(channel)
    participant DB as SQLite
    participant C as Claude (Sonnet)
    participant CL as email-classifier<br/>(Haiku)
    participant DC as document-classifier<br/>(Haiku)
    participant WF as workflow-mcp
    participant IW as invoice-worker
    participant P as Paperless MCP
    participant TG as Telegram

    rect rgb(40, 40, 60)
    note over G,TG: First scan (per source)
    G-->>EW: emails[]
    EW->>DB: INSERT status="seed" (all emails)
    note over DB: Seeds are terminal — never processed
    end

    rect rgb(40, 40, 60)
    note over G,TG: Subsequent polls — new email detected
    loop Every 30s
        EW->>G: poll
        G-->>EW: emails[]
    end
    EW->>DB: emailExists(id)?
    DB-->>EW: false
    EW->>DB: INSERT status="new"
    EW--)C: channel notification<br/>(sender, subject, message_id, source)
    end

    rect rgb(50, 40, 40)
    note over C,CL: Step 1 — Classify
    C->>CL: dispatch (email metadata)
    CL-->>C: JSON {is_invoice, confidence,<br/>vendor, action, doc_type}
    C->>EW: update_email_status(id,<br/>status="classified",<br/>classification, action,<br/>vendor, confidence)
    EW->>DB: UPDATE classified_at=now()
    end

    rect rgb(40, 50, 40)
    note over C,TG: Step 2 — Act on classification

    alt action = "download_and_upload"
        note over C,G: Download PDF to disk
        alt strategy = "attachment"
            C->>G: download_attachment / download-helper.ts
        else strategy = "known_link" / "direct_url"
            C->>G: invoice_links from event or extractInvoiceLinks() → curl -o
        end
        G-->>C: file on disk (file_path)
        opt encrypted PDF
            C->>C: qpdf --decrypt (BANK_PDF_PASSWORD)
        end

        note over C,DC: Classify document
        C->>DC: dispatch document-classifier (Haiku)
        DC-->>C: {vendor, total_amount, doc_type, ...}
        C->>C: merge: DC non-null values override email-classifier

        note over C,WF: Create job (file_path + month_tag + merged classification)
        C->>WF: create_invoice_intake_job
        WF->>IW: execute job
        IW->>IW: read file from disk (file_path)
        IW->>P: dedup check (order_id + correspondent)

        alt exact duplicate (same amount)
            IW-->>WF: completed (outcome: duplicate)
            note over C: Skip silently
        else duplicate_likely (amount mismatch)
            IW-->>WF: awaiting_approval
            C->>TG: reply("Possible duplicate, approve?")
        else no duplicate
            IW->>P: post_document + custom fields
            IW->>IW: delete local file
            IW-->>WF: completed (outcome: uploaded)
            C->>TG: reply("Uploaded {vendor} — {amount} EUR")
        end

    else action = "notify_user"
        C->>TG: reply("New invoice from {sender}.<br/>Process? Reply yes/no")

    else action = "ignore"
        note over C: Silent — no notification
    end
    end

    rect rgb(40, 40, 50)
    note over C,DB: Step 3 — Record final status
    C->>EW: update_email_status(id,<br/>status="processed|failed|ignored",<br/>process_result="...")
    EW->>DB: UPDATE processed_at=now()
    end
```

## UC-1.1: Gmail Polling

Polls Gmail via the community `google_workspace_mcp` image (pinned `1.16.2`, supports `body_format: "html"`).

**Flow:** `search_gmail_messages` (page_size=50) → extract IDs (deduplicated via `Set`) → `get_gmail_messages_content_batch` → parse metadata.

`parseGmailEmails` checks whether search results contain actual metadata (Subject/From/To headers). Gmail search often returns sparse results with only Message IDs and no headers — when this happens, `parseGmailEmails` falls through to the batch-fetch path instead of short-circuiting with incomplete data.

`extractGmailIds` deduplicates IDs with `new Set()` because Gmail search results can return the same message as Message ID, Thread ID, and URL hex — without dedup, batch-fetch would process the same email multiple times.

**Code:**
- [`email-watcher.ts:512-574`](../local/claude-code/channels/email-watcher.ts#L512) — `pollGmail()`: search + batch-fetch + parse
- [`email-watcher.ts:522`](../local/claude-code/channels/email-watcher.ts#L522) — search query from `GMAIL_SEARCH_QUERY` env (default: `newer_than:1d`)

**Auth:** OAuth via `https://gmail-mcp.lacny.me/oauth2callback`. Trigger `start_google_auth` tool from inside the Claude session. Tokens persist in `/mnt/shared_configs/personal-assistant/gmail/`.

**Config:**
- [`docker-compose.yml:96-128`](../docker-compose.yml#L96) — gmail-mcp service (community image, caddy label for OAuth callback, env vars)

## UC-1.2: Outlook Polling

Polls Outlook via custom MCP server using Microsoft Graph API.

**Flow:** `list_emails(top=20)` → parse response array → map to `EmailInfo`.

**Code:**
- [`email-watcher.ts:581-612`](../local/claude-code/channels/email-watcher.ts#L581) — `pollOutlook()`: call `list_emails`, parse array
- [`outlook-mcp/server.py`](../local/outlook-mcp/server.py) — 4 tools: `list_emails`, `get_email`, `get_attachments`, `download_attachment`

**Auth:** MSAL device code flow. On first start (no cached token), prints URL + code in container logs. Tokens persist in `/mnt/shared_configs/personal-assistant/outlook/token_cache.json`.

**Config:**
- [`docker-compose.yml:129-149`](../docker-compose.yml#L129) — outlook-mcp service (MSAL env vars, stateless HTTP, NAS volume)

## UC-1.3: Classification

Haiku subagent classifies each new email by sender, subject, and body excerpt.

**Output fields:** `is_invoice`, `confidence` (high/medium/low), `vendor`, `doc_type`, `is_fuel`, `action` (download_and_upload/notify_user/ignore), `download_strategy` (attachment/known_link/direct_url/browser_required/manual_review), `strategy_confidence`, `requires_review`, `order_id`, `total_amount`, `currency`.

**`has_attachments` override:** The classifier prompt is aware of the `has_attachments` field from the email metadata. When `has_attachments` is true, the `attachment` download strategy overrides all other guesses — this prevents emails with actual PDF attachments (e.g., bank statements, fuel receipts) from being misclassified as `browser_required`.

**Code:**
- [`agents/email-classifier.md`](../local/claude-code/agents/email-classifier.md) — Haiku classifier prompt defining all output fields and decision rules
- [`invoice-worker.ts:36-89`](../local/claude-code/channels/invoice-worker.ts#L36) — `InvoiceIntakeInput` type definition with all classification fields

**Document classification (post-download):** After downloading the PDF, Claude runs the `document-classifier` Haiku subagent ([`agents/document-classifier.md`](../local/claude-code/agents/document-classifier.md)) which visually inspects the PDF and returns 7 fields: `doc_type`, `vendor`, `total_amount`, `currency`, `is_fuel`, `confidence`, `order_id`. Non-null values override the email-classifier's guesses. This same classifier handles GDrive scans.

**Status recording:** After classification, Claude calls `update_email_status` with the classification JSON, action, vendor, and confidence.

## UC-1.4: Upload to Paperless

The invoice-worker uploads documents via the Paperless MCP's `post_document` tool.

**Steps:**
1. **Resolve correspondent** — match vendor name to existing Paperless correspondent (case-insensitive), create if missing
2. **Resolve tags** — derive tags from the `owner` field set by the document-classifier (see owner-aware logic below), create missing tags
3. **Resolve document type** — map `doc_type` to Paperless type (invoice → "invoice", statement → "account_statement")
4. **Build title** — `{vendor} - {order_id}` or `{vendor} - {subject}`
5. **Upload** — `post_document` with base64 content, correspondent, tags, type, custom fields (total_amount, order_id)

**Owner-aware tag derivation:**

The `owner` field from the document-classifier determines the tag set. The classifier inspects the PDF for business identifiers (company name, VAT/ICO/DIC, license plates, "Podnikatelsky ucet") and returns `owner: "techlab"` or `owner: "personal"`.

| Owner | Tags applied |
|-------|-------------|
| `techlab` (business) | `techlab` + `invoicing`/`documents` (from `doc_type`) + `fuel` (if `is_fuel`) + `YYYY-MM` |
| `personal` | `personal` + `YYYY-MM` only |
| missing/null (backward compat) | Defaults to `techlab` behavior |

Previously, `techlab` was hardcoded on all documents and there was no personal/business distinction.

**Code:**
- [`invoice-worker.ts:445-475`](../local/claude-code/channels/invoice-worker.ts#L445) — `resolveCorrespondent()`: list → match → create if needed
- [`invoice-worker.ts:481-550`](../local/claude-code/channels/invoice-worker.ts#L481) — `checkDuplicate()`: search by order_id + correspondent, compare amounts
- [`invoice-worker.ts:552-625`](../local/claude-code/channels/invoice-worker.ts#L552) — `resolveTags()`: list → match → create missing
- [`invoice-worker.ts:628-700`](../local/claude-code/channels/invoice-worker.ts#L628) — `uploadToPaperless()`: assemble args, call `post_document`
- [`invoice-worker.ts:706`](../local/claude-code/channels/invoice-worker.ts#L706) — `buildTitle()`: title generation logic

## UC-1.5: Telegram Notification

Claude notifies the user via the Telegram channel's `reply` tool after processing.

**Notification types:**
- Success: `"✓ Uploaded {vendor} invoice to Paperless ({amount} EUR)"`
- Failure: `"⚠ {vendor} invoice download failed: {reason}"`
- Unknown vendor: `"New invoice from {sender}: {subject}. Process? Reply yes/no"`
- Auth expired: `"⚠ {service} auth expired — re-authenticate"`

**Channel notifications (email-watcher → Claude):**
- [`email-watcher.ts:701-730`](../local/claude-code/channels/email-watcher.ts#L701) — channel notification format: meta fields include `email_source`, `message_id`, `sender`, `subject`, `has_attachments`, `received_at`

**Telegram plugin:** Official Anthropic plugin, cloned at Docker build time from `github.com/anthropics/claude-plugins-official`.
- [`Dockerfile:33-36`](../local/claude-code/Dockerfile#L33) — git clone + bun install

## UC-1.6: Approval Gates

The invoice-worker pauses automatically for edge cases and waits for human approval via Telegram.

**Approval triggers (post-Task 16 simplification):**
1. Dedup: amount mismatch on matching order_id (`duplicate_likely`)

Gates for unknown vendor, low confidence, browser_required, and requires_review were removed — triage now happens in Claude before job creation, using the document-classifier's higher-quality PDF analysis.

**Code:**
- [`invoice-worker.ts:185-195`](../local/claude-code/channels/invoice-worker.ts#L185) — `duplicate_likely` approval gate

**Workflow tools for approval:**
- [`workflow-mcp.ts:182-194`](../local/claude-code/channels/workflow-mcp.ts#L182) — `approve_job` tool definition
- [`workflow-mcp.ts:195-207`](../local/claude-code/channels/workflow-mcp.ts#L195) — `cancel_job` tool definition

**Status:** Simplified to single dedup gate. Deployed.

## UC-1.7: Query Invoice Status

Claude can query Paperless directly using `search_documents` from the community Paperless MCP. Example: "do I have March invoices?" triggers a search with month filter.

**Also available:** email-watcher audit trail queries:
- [`email-watcher.ts:784-794`](../local/claude-code/channels/email-watcher.ts#L784) — `get_recent_emails` tool (filter by status, source, limit)
- [`email-watcher.ts:796-802`](../local/claude-code/channels/email-watcher.ts#L796) — `get_email_stats` tool (counts by status, last 24h breakdown)

## UC-1.8: GDrive Scan Auto-Upload

Scanned documents dropped into Google Drive are automatically classified and uploaded to Paperless.

**Pipeline:** gdrive-watcher polls `Techlab/Invoice scans/` → Claude downloads file via `curl` → document-classifier (Haiku) extracts metadata → `create_scan_intake_job` with `file_path` + `month_tag` → worker reads from disk, uploads to Paperless, moves file to `Processed/`.

**Unified classifier:** Both email PDFs and GDrive scans use the same `document-classifier` agent. The email path adds an email-classifier triage step before download; the GDrive path skips it.

**PDF decryption:** Password-protected PDFs (e.g., bank statements) are decrypted via `qpdf` before classification. Password from `BANK_PDF_PASSWORD` env var.

**Code:**
- [`agents/document-classifier.md`](../local/claude-code/agents/document-classifier.md) — Haiku classifier prompt (7-field output)
- [`channels/download-helper.ts`](../local/claude-code/channels/download-helper.ts) — CLI helper for attachment downloads + qpdf decryption
- [`channels/gdrive-watcher.ts`](../local/claude-code/channels/gdrive-watcher.ts) — GDrive polling channel

## Download Strategies

The classifier assigns a `download_strategy` that determines how the worker gets the file:

| Strategy | Handler | Description |
|----------|---------|-------------|
| `attachment` | [`invoice-worker.ts:270-370`](../local/claude-code/channels/invoice-worker.ts#L270) | Download email attachment via MCP (prefers PDF) |
| `known_link` | [`invoice-worker.ts:284-290`](../local/claude-code/channels/invoice-worker.ts#L284) | Extract invoice link from email body using vendor rules, download via MCP |
| `direct_url` | Same as known_link | Direct URL in email body |
| `browser_required` | Pauses for approval | Requires browser interaction (e.g., login-gated portal) |
| `manual_review` | Pauses for approval | Classifier unsure, needs human review |

**Vendor rules** for link extraction: [`channels/invoice-links.ts`](../local/claude-code/channels/invoice-links.ts) — `INVOICE_LINK_RULES` is the single source of truth for vendor-specific patterns (sender + link text + subject). Used by both email-watcher (Gmail HTML) and invoice-worker (Outlook `body_html`). The legacy `INVOICE_RULES` in `outlook-mcp/server.py` is superseded.

**Pre-job download (email path):** Claude now downloads the PDF *before* creating the intake job (using `curl` for links, `download-helper.ts` for attachments). The job receives a `file_path` and the worker reads from disk. The worker's MCP-based download functions are kept as fallback when `file_path` is missing (e.g., legacy jobs or manual retries).

## Durable Workflow Layer

Jobs survive container restarts. The workflow layer provides:

- **SQLite-backed job queue** with states: `queued → running → completed/failed/awaiting_approval`
- **Event log** per job tracking every step (download, dedup, upload)
- **Idempotency keys** to prevent duplicate job creation
- **Worker polling** every 2s for queued jobs

**Code:**
- [`workflow-db.ts:46-78`](../local/claude-code/channels/workflow-db.ts#L46) — schema: `jobs` + `job_events` tables
- [`workflow-core.ts:56`](../local/claude-code/channels/workflow-core.ts#L56) — `executeNextJob()`: claim + dispatch by workflow_type
- [`workflow-mcp.ts:368`](../local/claude-code/channels/workflow-mcp.ts#L368) — worker loop: poll every `WORKFLOW_POLL_MS` (default 2s)
- [`workflow-mcp.ts:62-207`](../local/claude-code/channels/workflow-mcp.ts#L62) — 7 MCP tools exposed to Claude
- [`mcp-client.ts:32-75`](../local/claude-code/channels/mcp-client.ts#L32) — HTTP MCP client for worker → MCP server calls (stateless path)
- [`mcp-client.ts:81-170`](../local/claude-code/channels/mcp-client.ts#L81) — stateful MCP client with initialize handshake (for paperless-mcp, gmail-mcp)

## Email Audit Trail

Every email is tracked in SQLite from discovery to final outcome.

**Schema:** [`db.ts:47-66`](../local/claude-code/channels/db.ts#L47) — `emails` table with fields: id, source, sender, subject, preview, has_attachments, received_at, discovered_at, classified_at, classification, action, vendor, confidence, processed_at, process_result, status.

### Status Lifecycle

```mermaid
stateDiagram-v2
    [*] --> seed : First scan<br/>(per source)
    [*] --> new : New email<br/>detected

    new --> classified : email-classifier<br/>subagent

    classified --> processed : download_and_upload<br/>succeeded / duplicate
    classified --> ignored : action = ignore
    classified --> failed : download/upload error

    seed --> [*]
    processed --> [*]
    ignored --> [*]
    failed --> [*]
```

### Status Reference

| Status | Meaning | Set by | Timestamp |
|--------|---------|--------|-----------|
| `seed` | Pre-existing email from first scan — never processed | email-watcher `pollCycle` | `discovered_at` |
| `new` | Newly detected, pushed to Claude as channel event | email-watcher `pollCycle` | `discovered_at` |
| `classified` | email-classifier returned classification JSON | Claude via `update_email_status` | `classified_at` (auto) |
| `processed` | invoice-worker completed (uploaded or duplicate) | Claude via `update_email_status` | `processed_at` (auto) |
| `ignored` | Classifier said action=ignore (not an invoice) | Claude via `update_email_status` | `processed_at` |
| `failed` | Download, upload, or classification error | Claude via `update_email_status` | `processed_at` |

### Design Decisions

- **Per-source seeding**: Gmail and Outlook seed independently via `hasAnyEmailsForSource()` — prevents false "new" notifications when one source seeds before the other
- **Capping**: Max 5 new emails per poll cycle (`MAX_NEW_PER_CYCLE`) to avoid flooding Claude's context
- **Two-stage update**: Classification and processing are separate `update_email_status` calls — shows where in the pipeline an email stalled
- **Auto-timestamps**: `classified_at` set when `classification` provided, `processed_at` when `process_result` provided
- **Idempotent inserts**: `INSERT OR IGNORE` on email ID prevents duplicate pushes across restarts

**First-run seeding:** On startup, if no emails exist for a source, existing emails are inserted as `seed` status without triggering notifications. Only subsequent new emails generate channel events.
- [`email-watcher.ts:619-730`](../local/claude-code/channels/email-watcher.ts#L619) — `pollCycle()`: seed detection, dedup, notification push
