#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// email-poller (standalone service)
//
// Polls Gmail + Outlook, persists discovered emails in emails.db, and creates
// invoice_intake jobs directly in workflow.db. No MCP server. No channel mode.
// No tools. INITIAL_LOOKBACK seeds last_checked on first run; over-cap windows
// fail loud (counter + log) without advancing the cursor.
// ---------------------------------------------------------------------------

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Database } from "bun:sqlite";
import {
  createManagedMcpClient,
  startHealthServer,
  startPollLoop,
} from "../../lib/watcher-runtime";
import {
  openDb as openEmailDb, insertEmail, emailExists,
  getLastChecked, setLastChecked, type InsertEmail,
} from "../../lib/email-db";
import { openWorkflowDb, createJob } from "../../lib/workflow-db";
import {
  validateInvoiceIntakeInput, WorkflowSchemaError,
} from "../../lib/workflow-schemas";
import { filterEmailsByRecipient } from "../../lib/email-filter";
import {
  parseDuration, cursorTimestamp, parseToolResult, extractGmailIds, parseGmailEmails,
  buildGmailQuery as _buildGmailQuery,
} from "../../lib/email-watcher-utils";
import {
  initTracing, getTracer, getMeter, withSpan, createLogger,
  getActiveTraceId, SpanStatusCode,
} from "../../lib/tracing";

// ── Types ─────────────────────────────────────────────────────────────
export interface EmailInfo {
  id: string;
  source: string;
  sender?: string;
  to?: string;
  subject?: string;
  preview?: string;
  hasAttachments?: boolean;
  receivedAt?: string;
  invoiceLinks?: unknown[];
}

// ── Config ────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "30000", 10);
const DB_PATH = process.env.DB_PATH ?? "/data/email-watcher/emails.db";
const WORKFLOW_DB_PATH = process.env.WORKFLOW_DB_PATH ?? "/data/email-watcher/workflow.db";
const STARTUP_DELAY_MS = parseInt(process.env.STARTUP_DELAY_MS ?? "15000", 10);
const MAX_NEW_PER_CYCLE = parseInt(process.env.MAX_NEW_PER_CYCLE ?? "5", 10);
const METRICS_PORT = parseInt(process.env.EMAIL_WATCHER_METRICS_PORT ?? "9465", 10);
const HEALTH_STALE_MULTIPLIER = 5;

const GMAIL_MCP_URL = process.env.GMAIL_MCP_URL ?? "http://gmail-mcp:8000/mcp";
const GMAIL_EMAIL = process.env.GMAIL_EMAIL ?? "";
const GMAIL_SEARCH_BASE = process.env.GMAIL_SEARCH_BASE ?? process.env.GMAIL_SEARCH_QUERY ?? "";
const MAX_CATCHUP_EMAILS = parseInt(process.env.MAX_CATCHUP_EMAILS ?? "200", 10);
const GMAIL_PAGE_SIZE = 200;
const INITIAL_LOOKBACK = process.env.INITIAL_LOOKBACK ?? "3d";

const OUTLOOK_MCP_URL = process.env.OUTLOOK_MCP_URL ?? "http://outlook-mcp:8002/mcp";
const OUTLOOK_ENABLED = (process.env.OUTLOOK_ENABLED ?? "true").toLowerCase() !== "false";
const EMAIL_FILTER_INCLUDE = process.env.EMAIL_FILTER_INCLUDE ?? "";
const EMAIL_FILTER_EXCLUDE = process.env.EMAIL_FILTER_EXCLUDE ?? "";

// Overlap window: cursor advances to (now - POLL_OVERLAP_MS) so each poll
// re-queries a bounded lookback window. This tolerates Gmail index lag where
// an email's receive-time falls behind the cursor before it's ever returned.
// Set POLL_OVERLAP=0h to disable. The existing emailExists dedup prevents
// re-processing already-seen emails.
const POLL_OVERLAP = process.env.POLL_OVERLAP ?? "10min";
const POLL_OVERLAP_MS = parseDuration(POLL_OVERLAP);

const gmailEnabled = GMAIL_EMAIL.length > 0;

// ── Tracing + logging ────────────────────────────────────────────────
initTracing("email-poller");
const tracer = getTracer("email-poller");
const meter = getMeter("email-poller");
const log = createLogger("email-poller");
let lastSuccessfulPollAt: number = Date.now();

// Counter (zero-cardinality in the happy path; only fires when over cap).
const catchupOverflowCounter = meter.createCounter("email_watcher.catchup_overflow", {
  description: "Times a poll cycle saw more new emails than MAX_CATCHUP_EMAILS for a source",
});
const newCapExceededCounter = meter.createCounter("email_watcher.new_cap_exceeded", {
  description: "Times a poll cycle saw more new emails than MAX_NEW_PER_CYCLE, triggering oldest-first drain",
});
const searchPageFullCounter = meter.createCounter("email_watcher.search_page_full", {
  description: "Times a search returned a full page (>= GMAIL_PAGE_SIZE), indicating possible results truncation",
});

// ── INITIAL_LOOKBACK seeding (replaces first_start prompt) ───────────
export function seedFromInitialLookback(
  db: Database,
  sources: string[],
  lookback: string,
): void {
  const ms = parseDuration(lookback);
  for (const source of sources) {
    if (getLastChecked(db, source) === null) {
      const seedTs = new Date(Date.now() - ms).toISOString();
      setLastChecked(db, source, seedTs);
      log(`Initialized ${source} from INITIAL_LOOKBACK=${lookback}: last_checked=${seedTs}`);
    }
  }
}

// ── Fail-loud overflow guard (replaces catchup_required prompt) ──────
export interface OverflowResult {
  overflow: boolean;
  processed: number;
  capped?: boolean;
}

export async function processWithOverflowGuard(
  emailDb: Database,
  wfDb: Database,
  source: string,
  newEmails: EmailInfo[],
  maxCap: number,
  maxPerCycle: number,
): Promise<OverflowResult> {
  if (newEmails.length > maxCap) {
    catchupOverflowCounter.add(1, { source });
    log(
      `ERROR: ${source} catchup overflow: ${newEmails.length} > ${maxCap}. ` +
      `last_checked NOT advanced. Investigate and either raise MAX_CATCHUP_EMAILS ` +
      `or run skip-catchup.ts.`,
    );
    return { overflow: true, processed: 0 };
  }
  if (newEmails.length > maxPerCycle) {
    // Over-cap but within flood limit: sort oldest-first and process the oldest maxPerCycle.
    // Cursor is NOT advanced so the next poll re-covers the full window; emailExists dedup
    // removes already-ingested emails and the backlog drains maxPerCycle per poll until
    // the batch fits in the normal branch.
    const sorted = [...newEmails].sort((a, b) => {
      const ta = Date.parse(a.receivedAt ?? "");
      const tb = Date.parse(b.receivedAt ?? "");
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;  // unparseable → sort to end (treat as newest)
      if (Number.isNaN(tb)) return -1;
      return ta - tb; // ascending: oldest first
    });
    const toProcess = sorted.slice(0, maxPerCycle);
    newCapExceededCounter.add(1, { source });
    log(
      `${source}: ${newEmails.length} new emails exceed per-cycle cap of ${maxPerCycle}. ` +
      `Processing oldest ${maxPerCycle}; cursor held for next poll to drain remainder.`,
    );
    await processNewEmails(emailDb, wfDb, toProcess, maxPerCycle, GMAIL_EMAIL || undefined);
    return { overflow: false, processed: toProcess.length, capped: true };
  }
  await processNewEmails(emailDb, wfDb, newEmails, maxPerCycle, GMAIL_EMAIL || undefined);
  setLastChecked(emailDb, source, cursorTimestamp(Date.now(), POLL_OVERLAP_MS));
  return { overflow: false, processed: newEmails.length };
}

// ── Process new emails (insert + create workflow jobs) ───────────────
export async function processNewEmails(
  emailDb: Database,
  wfDb: Database,
  emails: EmailInfo[],
  maxPerCycle: number,
  ownEmail?: string,
): Promise<void> {
  if (emails.length === 0) return;
  const capped = emails.slice(0, maxPerCycle);
  if (emails.length > maxPerCycle) {
    log(`Capped new emails from ${emails.length} to ${maxPerCycle}`);
  }

  for (const email of capped) {
    insertEmail(emailDb, {
      id: email.id,
      source: email.source,
      sender: email.sender ?? null,
      subject: email.subject ?? null,
      preview: email.preview ?? null,
      hasAttachments: email.hasAttachments ?? false,
      receivedAt: email.receivedAt ?? null,
      traceId: getActiveTraceId(),
      invoiceLinks: email.invoiceLinks?.length
        ? JSON.stringify(email.invoiceLinks) : null,
    } as InsertEmail);

    if (
      ownEmail &&
      email.source === "gmail" &&
      email.sender?.toLowerCase() === ownEmail.toLowerCase() &&
      /^re:\s/i.test(email.subject ?? "")
    ) {
      log(`↩ Skipping own-account reply: ${email.id} "${email.subject}"`);
      continue;
    }

    const jobInput = {
      email_source: email.source,
      message_id: email.id,
      sender: email.sender ?? null,
      subject: email.subject ?? null,
      received_at: email.receivedAt ?? null,
    };
    try {
      validateInvoiceIntakeInput(jobInput);
    } catch (err) {
      const reason = err instanceof WorkflowSchemaError ? err.message : String(err);
      log(`✗ Refusing to create job for ${email.source}:${email.id}: ${reason}`);
      continue;
    }

    const perEmailTracer = getTracer("email-poller");
    let createdJobId: string | null = null;
    await perEmailTracer.startActiveSpan(
      "email-poller.process_email",
      {
        root: true,
        attributes: {
          "email.source": email.source,
          "email.message_id": email.id,
          "email.sender": email.sender ?? "",
          "email.subject": email.subject ?? "",
        },
      },
      (span) => {
        try {
          const job = createJob(wfDb, {
            workflowType: "invoice_intake",
            inputJson: JSON.stringify(jobInput),
            sourceRef: `${email.source}:${email.id}`,
            idempotencyKey: `${email.source}:${email.id}`,
            requiresApproval: false,
            traceId: getActiveTraceId(),
          });
          createdJobId = job.id;
          span.setAttribute("job.id", job.id);
          span.setAttribute("job.type", "invoice_intake");
          span.setAttribute("job.state", job.state);
          span.setStatus({ code: SpanStatusCode.OK });
        } finally {
          span.end();
        }
      },
    );
    log(`Created job ${createdJobId} for ${email.source}:${email.id} (state: queued)`);
  }
  log(`Processed ${capped.length} new email(s), created jobs directly`);
}

// ── Metrics registration ─────────────────────────────────────────────
function registerMetrics(emailDb: Database, wfDb: Database): void {
  meter.createObservableGauge("email_watcher.emails", {
    description: "Total emails tracked by source",
  }).addCallback((gauge) => {
    const rows = emailDb
      .query("SELECT source, COUNT(*) AS count FROM emails GROUP BY source")
      .all() as Array<{ source: string; count: number }>;
    for (const row of rows) {
      gauge.observe(row.count, { source: row.source });
    }
  });

  meter.createObservableGauge("email_watcher.attachments", {
    description: "Emails with attachments by source",
  }).addCallback((gauge) => {
    const rows = emailDb
      .query("SELECT source, COUNT(*) AS count FROM emails WHERE has_attachments = 1 GROUP BY source")
      .all() as Array<{ source: string; count: number }>;
    for (const row of rows) {
      gauge.observe(row.count, { source: row.source });
    }
  });

  meter.createObservableGauge("email_watcher.recent_discovered", {
    description: "Emails discovered in the last 24 hours by source",
  }).addCallback((gauge) => {
    const rows = emailDb
      .query("SELECT source, COUNT(*) AS count FROM emails WHERE discovered_at >= datetime('now', '-1 day') GROUP BY source")
      .all() as Array<{ source: string; count: number }>;
    for (const row of rows) {
      gauge.observe(row.count, { source: row.source });
    }
  });

  meter.createObservableGauge("email_watcher.jobs", {
    description: "Jobs by workflow type and state",
  }).addCallback((gauge) => {
    const rows = wfDb
      .query("SELECT workflow_type, state, COUNT(*) AS count FROM jobs GROUP BY workflow_type, state")
      .all() as Array<{ workflow_type: string; state: string; count: number }>;
    for (const row of rows) {
      gauge.observe(row.count, { type: row.workflow_type, state: row.state });
    }
  });

  meter.createObservableGauge("email_watcher.backlog", {
    description: "Jobs not yet in a terminal state",
  }).addCallback((gauge) => {
    const rows = wfDb
      .query("SELECT workflow_type, COUNT(*) AS count FROM jobs WHERE state NOT IN ('completed', 'failed') GROUP BY workflow_type")
      .all() as Array<{ workflow_type: string; count: number }>;
    // Always observe both workflow types (including zero) so Prometheus sees
    // fresh samples instead of keeping stale values from earlier exports.
    const counts: Record<string, number> = { invoice_intake: 0, scan_intake: 0 };
    for (const row of rows) {
      counts[row.workflow_type] = row.count;
    }
    for (const [type, count] of Object.entries(counts)) {
      gauge.observe(count, { type });
    }
  });
}

// ── MCP Client helpers ────────────────────────────────────────────────
const gmailClientWrapper = createManagedMcpClient({
  name: "email-poller-gmail",
  version: "0.0.1",
  url: GMAIL_MCP_URL,
  logger: { log },
  connectMessage: "Connected to gmail-mcp",
});

const outlookClientWrapper = createManagedMcpClient({
  name: "email-poller-outlook",
  version: "0.0.1",
  url: OUTLOOK_MCP_URL,
  logger: { log },
  connectMessage: "Connected to outlook-mcp",
});

async function getGmailClient(): Promise<Client> {
  return gmailClientWrapper.get();
}

async function getOutlookClient(): Promise<Client> {
  return outlookClientWrapper.get();
}

export function resetGmailClient(): void {
  gmailClientWrapper.reset();
}

export function resetOutlookClient(): void {
  outlookClientWrapper.reset();
}

// ── Gmail query wrapper ───────────────────────────────────────────────
function buildGmailQuery(lastChecked: string | null): string {
  return _buildGmailQuery(GMAIL_SEARCH_BASE, lastChecked);
}

// ── Gmail polling ─────────────────────────────────────────────────────
export async function pollGmail(db: Database, query: string): Promise<EmailInfo[] | null> {
  // Re-read env var at call time so integration tests can set GMAIL_EMAIL
  // after module load (module may be cached without GMAIL_EMAIL set).
  const effectiveGmailEmail = process.env.GMAIL_EMAIL ?? GMAIL_EMAIL;
  if (!effectiveGmailEmail) return [];

  try {
    const client = await getGmailClient();

    // Step 1: Search for messages
    const searchResult = await client.callTool({
      name: "search_gmail_messages",
      arguments: {
        query,
        user_google_email: effectiveGmailEmail,
        page_size: GMAIL_PAGE_SIZE,
      },
    });

    const searchData = parseToolResult(searchResult);
    if (!searchData) {
      log("Gmail search returned no data");
      return [];
    }

    // Guard: if the API returned a full page, log loudly — the single-page
    // assumption may be breaking and true pagination should be revisited.
    const rawIds = extractGmailIds(searchData);
    if (rawIds.length >= GMAIL_PAGE_SIZE) {
      log(
        `WARNING: Gmail search page came back full (${rawIds.length} >= ${GMAIL_PAGE_SIZE}). ` +
        `Single-page assumption may be breaking — emails beyond page 1 are not retrieved. ` +
        `True pagination must be revisited.`,
      );
      searchPageFullCounter.add(1, { source: "gmail" });
    }
    const allIds = [...new Set(rawIds)];
    if (allIds.length === 0) {
      return [];
    }

    // If search result already had rich metadata (subjects), use it directly
    const fromSearch = parseGmailEmails(searchData, []);
    const hasMetadata = fromSearch.some((e) => e.subject || e.sender);
    if (fromSearch.length > 0 && hasMetadata) {
      return fromSearch;
    }

    // Skip emails already in the DB — only fetch details for unknown IDs.
    // This avoids ~50 sequential Gmail API calls per poll when nothing is new.
    const ids = allIds.filter((id) => !emailExists(db, id));
    if (ids.length === 0) {
      return [];
    }

    // Step 2: Fetch full content per message (includes attachment info)
    // The batch endpoint omits --- ATTACHMENTS --- section, so we must
    // call get_gmail_message_content individually to detect attachments.
    const emails: EmailInfo[] = [];
    for (const id of ids) {
      try {
        const contentResult = await client.callTool({
          name: "get_gmail_message_content",
          arguments: {
            message_id: id,
            user_google_email: effectiveGmailEmail,
          },
        });

        const text = parseToolResult(contentResult);
        if (typeof text === "string") {
          const subjectMatch = text.match(/Subject:\s*(.+)/);
          const fromMatch = text.match(/From:\s*(.+)/);
          // Skip if Gmail returned an error instead of email content (e.g. 404)
          if (!fromMatch && !subjectMatch) {
            log(`Gmail returned no email headers for ${id}, skipping (likely 404 or deleted)`);
            continue;
          }
          const toMatch = text.match(/To:\s*(.+)/);
          const dateMatch = text.match(/Date:\s*(.+)/);
          const rawFrom = fromMatch?.[1]?.trim() ?? "";
          const emailMatch = rawFrom.match(/<([^>]+)>/);
          const rawTo = toMatch?.[1]?.trim() ?? "";
          const toEmailMatch = rawTo.match(/<([^>]+)>/);
          // Detect attachments from --- ATTACHMENTS --- section
          const hasAttachments = /--- ATTACHMENTS ---/.test(text);
          // Extract body preview (between --- BODY --- and next ---)
          const bodyMatch = text.match(/--- BODY ---\s*([\s\S]*?)(?:---|$)/);
          const preview = bodyMatch?.[1]?.trim().substring(0, 200) ?? undefined;
          emails.push({
            id,
            source: "gmail",
            sender: emailMatch ? emailMatch[1] : rawFrom,
            to: toEmailMatch ? toEmailMatch[1] : rawTo || undefined,
            subject: subjectMatch?.[1]?.trim(),
            hasAttachments,
            preview,
            receivedAt: dateMatch?.[1]?.trim(),
          });
        }
      } catch (e: any) {
        log(`Gmail fetch failed for ${id}: ${e.message}`);
      }
    }
    return emails;
  } catch (e: any) {
    log(`Gmail poll error: ${e.message}`);
    resetGmailClient();
    return null;
  }
}

// ── Outlook polling ───────────────────────────────────────────────────
export async function pollOutlook(db: Database, receivedAfter: string | null): Promise<EmailInfo[] | null> {
  // Re-read env var at call time so integration tests can control enabled state.
  const effectiveOutlookEnabled = (process.env.OUTLOOK_ENABLED ?? "true").toLowerCase() !== "false";
  if (!effectiveOutlookEnabled) return [];

  try {
    const client = await getOutlookClient();

    const args: Record<string, any> = { top: 50 };
    if (receivedAfter) {
      args.received_after = receivedAfter;
    }

    const result = await client.callTool({
      name: "list_emails",
      arguments: args,
    });

    let data = parseToolResult(result);
    if (!data) {
      log("Outlook returned no data");
      return [];
    }
    // Single email → parseToolResult returns object, not array. Wrap it.
    if (!Array.isArray(data)) {
      data = [data];
    }

    return data.map((item: any) => ({
      id: String(item.id),
      source: "outlook" as const,
      sender: item.sender ?? undefined,
      to: item.to ?? undefined,
      subject: item.subject ?? undefined,
      preview: item.preview ?? undefined,
      hasAttachments: item.has_attachments ?? false,
      receivedAt: item.received_at ?? undefined,
    }));
  } catch (e: any) {
    log(`Outlook poll error: ${e.message}`);
    resetOutlookClient();
    return null;
  }
}

// ── Poll cycle ────────────────────────────────────────────────────────
async function pollCycle(emailDb: Database, wfDb: Database): Promise<void> {
  return withSpan(tracer, "email-poller.poll", {}, async (span) => {
    const sources: Array<{ name: string; poll: () => Promise<EmailInfo[] | null> }> = [];

    if (gmailEnabled) {
      const lastChecked = getLastChecked(emailDb, "gmail");
      // INITIAL_LOOKBACK seed runs in main(); lastChecked is always non-null here.
      const query = buildGmailQuery(lastChecked);
      sources.push({ name: "gmail", poll: () => pollGmail(emailDb, query) });
    }
    if (OUTLOOK_ENABLED) {
      const lastChecked = getLastChecked(emailDb, "outlook");
      sources.push({ name: "outlook", poll: () => pollOutlook(emailDb, lastChecked) });
    }
    if (sources.length === 0) return;

    const results = await Promise.all(sources.map((s) => s.poll()));
    let totalFound = 0;
    let totalNew = 0;

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i].name;
      const pollResult = results[i];
      if (pollResult === null) {
        // Poll error (auth expired, connection refused). Do not advance cursor.
        span.setAttribute(`poll.${source}.error`, true);
        span.setStatus({ code: SpanStatusCode.ERROR, message: `${source} poll failed, cursor not advanced` });
        continue;
      }
      let emails = pollResult;
      totalFound += pollResult.length;

      emails = emails.filter((e) => !emailExists(emailDb, e.id));
      if (EMAIL_FILTER_INCLUDE || EMAIL_FILTER_EXCLUDE) {
        const before = emails.length;
        emails = filterEmailsByRecipient(emails, EMAIL_FILTER_INCLUDE, EMAIL_FILTER_EXCLUDE);
        if (before !== emails.length) {
          log(`Email filter: ${before} -> ${emails.length} (include="${EMAIL_FILTER_INCLUDE}", exclude="${EMAIL_FILTER_EXCLUDE}")`);
        }
      }
      totalNew += emails.length;

      await processWithOverflowGuard(emailDb, wfDb, source, emails, MAX_CATCHUP_EMAILS, MAX_NEW_PER_CYCLE);
    }

    span.setAttribute("email.found", totalFound);
    span.setAttribute("email.new", totalNew);
    lastSuccessfulPollAt = Date.now();
  });
}

// ── Main entry point ──────────────────────────────────────────────────
async function main(): Promise<void> {
  log(`Opening email database at ${DB_PATH}`);
  const emailDb = openEmailDb(DB_PATH);
  log(`Opening workflow database at ${WORKFLOW_DB_PATH}`);
  const wfDb = openWorkflowDb(WORKFLOW_DB_PATH);
  registerMetrics(emailDb, wfDb);
  startHealthServer({
    port: METRICS_PORT, db: emailDb,
    getStaleMs: () => Date.now() - lastSuccessfulPollAt,
    maxStaleMs: POLL_INTERVAL_MS * HEALTH_STALE_MULTIPLIER,
    logger: { log }, name: "email-poller",
  });

  // Seed last_checked for any new sources from INITIAL_LOOKBACK BEFORE the
  // first poll. This replaces the bidirectional first_start channel event.
  const sources: string[] = [];
  if (gmailEnabled) sources.push("gmail");
  if (OUTLOOK_ENABLED) sources.push("outlook");
  seedFromInitialLookback(emailDb, sources, INITIAL_LOOKBACK);

  log(`Waiting ${STARTUP_DELAY_MS}ms for upstream MCP servers to start...`);
  await new Promise((resolve) => setTimeout(resolve, STARTUP_DELAY_MS));

  log(
    `Config: gmail=${gmailEnabled ? GMAIL_EMAIL : "disabled"}, ` +
    `outlook=${OUTLOOK_ENABLED ? "enabled" : "disabled"}, ` +
    `poll=${POLL_INTERVAL_MS}ms, max_catchup=${MAX_CATCHUP_EMAILS}, ` +
    `overlap=${POLL_OVERLAP}, lookback=${INITIAL_LOOKBACK}, db=${DB_PATH}`,
  );

  await startPollLoop({
    name: "email-poller", intervalMs: POLL_INTERVAL_MS,
    poll: () => pollCycle(emailDb, wfDb),
    logger: { log }, runFirstCycleImmediately: true,
  });
}

if (import.meta.main) {
  main().catch((e) => {
    log(`Fatal error: ${e.message}`);
    process.exit(1);
  });
}
