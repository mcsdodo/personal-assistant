#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// email-watcher channel
//
// MCP Server (stdio) that polls gmail-mcp and outlook-mcp over Streamable HTTP,
// persists discovered emails in SQLite, and creates invoice_intake jobs directly
// in workflow.db for new emails. Exposes get_recent_emails and get_email_stats
// tools for querying the audit trail.
// ---------------------------------------------------------------------------

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Database } from "bun:sqlite";

import {
  createManagedMcpClient,
  startHealthServer as runtimeStartHealthServer,
  startPollLoop,
} from "./watcher-runtime";

import {
  openDb,
  insertEmail,
  emailExists,
  getLastChecked,
  setLastChecked,
  getRecentEmails,
  type InsertEmail,
} from "./db";

import { initTracing, getTracer, getMeter, withSpan, createLogger, getActiveTraceId, SpanStatusCode } from "./tracing";
import { openWorkflowDb, createJob } from "./workflow-db";
import { validateInvoiceIntakeInput, WorkflowSchemaError } from "./workflow-schemas";


// Pure functions live in email-watcher-utils.ts (no side effects, safe to import from tests).
// Re-export for backward compatibility + import for internal use.
export type { EmailInfo } from "./email-watcher-utils";
export { parseDuration, esc, metricLine, emitWithDefaults, parseToolResult, extractGmailIds, parseGmailEmails } from "./email-watcher-utils";
import type { EmailInfo } from "./email-watcher-utils";
import { buildGmailQuery as _buildGmailQuery, parseDuration, parseToolResult, extractGmailIds, parseGmailEmails } from "./email-watcher-utils";

// ---------------------------------------------------------------------------
// Config (env vars)
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "30000", 10);
const DB_PATH = process.env.DB_PATH ?? "/data/email-watcher/emails.db";
const WORKFLOW_DB_PATH = process.env.WORKFLOW_DB_PATH ?? "/data/email-watcher/workflow.db";
const STARTUP_DELAY_MS = parseInt(process.env.STARTUP_DELAY_MS ?? "15000", 10);
const MAX_NEW_PER_CYCLE = parseInt(process.env.MAX_NEW_PER_CYCLE ?? "5", 10);
const METRICS_PORT = parseInt(process.env.EMAIL_WATCHER_METRICS_PORT ?? "9465", 10);
const HEALTH_STALE_MULTIPLIER = 5; // unhealthy after N missed poll cycles

const GMAIL_MCP_URL = process.env.GMAIL_MCP_URL ?? "http://gmail-mcp:8000/mcp";
const GMAIL_EMAIL = process.env.GMAIL_EMAIL ?? "";
const GMAIL_SEARCH_BASE = process.env.GMAIL_SEARCH_BASE ?? process.env.GMAIL_SEARCH_QUERY ?? "";
const MAX_CATCHUP_EMAILS = parseInt(process.env.MAX_CATCHUP_EMAILS ?? "10", 10);

const OUTLOOK_MCP_URL = process.env.OUTLOOK_MCP_URL ?? "http://outlook-mcp:8002/mcp";
const OUTLOOK_ENABLED = (process.env.OUTLOOK_ENABLED ?? "true").toLowerCase() !== "false";

// Email filtering: whitelist/blacklist by recipient address (supports Gmail + addressing)
// EMAIL_FILTER_INCLUDE: only process emails where TO contains this string (dev: "+dev")
// EMAIL_FILTER_EXCLUDE: skip emails where TO contains this string (prod: "+dev")
const EMAIL_FILTER_INCLUDE = process.env.EMAIL_FILTER_INCLUDE ?? "";
const EMAIL_FILTER_EXCLUDE = process.env.EMAIL_FILTER_EXCLUDE ?? "";

import { filterEmailsByRecipient } from "./email-filter";

const gmailEnabled = GMAIL_EMAIL.length > 0;

// buildGmailQuery wrapper — passes module-level GMAIL_SEARCH_BASE to the pure function
function buildGmailQuery(lastChecked: string | null): string {
  return _buildGmailQuery(GMAIL_SEARCH_BASE, lastChecked);
}
// Re-export with the base param for direct testing
export { buildGmailQuery as _buildGmailQueryWithBase } from "./email-watcher-utils";

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

initTracing("email-watcher");
const tracer = getTracer("email-watcher");
const meter = getMeter("email-watcher");

// ---------------------------------------------------------------------------
// Logging — all to stderr (stdout reserved for MCP stdio transport)
// ---------------------------------------------------------------------------

const log = createLogger("email-watcher");

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

function startHealthServer(emailDb: Database): void {
  runtimeStartHealthServer({
    port: METRICS_PORT,
    db: emailDb,
    getStaleMs: () => Date.now() - lastSuccessfulPollAt,
    maxStaleMs: POLL_INTERVAL_MS * HEALTH_STALE_MULTIPLIER,
    logger: { log },
    name: "email-watcher",
  });
}

// ---------------------------------------------------------------------------
// MCP Client helpers
// ---------------------------------------------------------------------------

let lastSuccessfulPollAt: number = Date.now();

const catchupQueue: Map<string, EmailInfo[]> = new Map();
const awaitingFirstStart: Set<string> = new Set();

const gmailClientWrapper = createManagedMcpClient({
  name: "email-watcher-gmail",
  version: "0.0.1",
  url: GMAIL_MCP_URL,
  logger: { log },
  connectMessage: "Connected to gmail-mcp",
});

const outlookClientWrapper = createManagedMcpClient({
  name: "email-watcher-outlook",
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

// parseToolResult, extractGmailIds, parseGmailEmails imported from ./email-watcher-utils

// ---------------------------------------------------------------------------
// Gmail polling
// ---------------------------------------------------------------------------

export async function pollGmail(db: Database, query: string): Promise<EmailInfo[]> {
  if (!gmailEnabled) return [];

  try {
    const client = await getGmailClient();

    // Step 1: Search for messages
    const searchResult = await client.callTool({
      name: "search_gmail_messages",
      arguments: {
        query,
        user_google_email: GMAIL_EMAIL,
        page_size: 50,
      },
    });

    const searchData = parseToolResult(searchResult);
    if (!searchData) {
      log("Gmail search returned no data");
      return [];
    }

    const allIds = [...new Set(extractGmailIds(searchData))];
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
            user_google_email: GMAIL_EMAIL,
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

// ---------------------------------------------------------------------------
// Outlook polling
// ---------------------------------------------------------------------------

export async function pollOutlook(db: Database, receivedAfter: string | null): Promise<EmailInfo[]> {
  if (!OUTLOOK_ENABLED) return [];

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

// ---------------------------------------------------------------------------
// Process new emails (insert + create workflow jobs directly)
// ---------------------------------------------------------------------------

export async function processNewEmails(db: Database, channel: Server, emails: EmailInfo[], wfDb?: Database): Promise<void> {
  if (emails.length === 0) return;

  const capped = emails.slice(0, MAX_NEW_PER_CYCLE);
  if (emails.length > MAX_NEW_PER_CYCLE) {
    log(`Capped new emails from ${emails.length} to ${MAX_NEW_PER_CYCLE}`);
  }

  const jobDb = wfDb ?? workflowDb;

  for (const email of capped) {
    insertEmail(db, {
      id: email.id,
      source: email.source,
      sender: email.sender ?? null,
      subject: email.subject ?? null,
      preview: email.preview ?? null,
      hasAttachments: email.hasAttachments ?? false,
      receivedAt: email.receivedAt ?? null,
      status: "new",
      traceId: getActiveTraceId(),
      invoiceLinks: email.invoiceLinks?.length ? JSON.stringify(email.invoiceLinks) : null,
    });

    // Validate the job input against the schema before persisting it. This
    // catches any drift between the watcher's idea of an invoice_intake input
    // and the worker's expectations.
    const jobInput = { email_source: email.source, message_id: email.id };
    try {
      validateInvoiceIntakeInput(jobInput);
    } catch (err) {
      const reason = err instanceof WorkflowSchemaError ? err.message : String(err);
      log(`✗ Refusing to create job for ${email.source}:${email.id}: ${reason}`);
      continue;
    }

    // Create workflow job directly (no channel notification to Claude)
    const job = createJob(jobDb, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify(jobInput),
      sourceRef: `${email.source}:${email.id}`,
      idempotencyKey: `${email.source}:${email.id}`,
      requiresApproval: false,
      traceId: getActiveTraceId(),
    });

    // OTel span — links job creation to the poll cycle trace
    try {
      const tracer = getTracer("email-watcher");
      tracer.startActiveSpan("email-watcher.job_created", {
        attributes: {
          "job.id": job.id,
          "job.type": "invoice_intake",
          "job.state": job.state,
          "email.source": email.source,
          "email.message_id": email.id,
        },
      }, (span) => {
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      });
    } catch { /* tracing unavailable */ }

    log(`Created job ${job.id} for ${email.source}:${email.id} (state: ${job.state})`);
  }

  log(`Processed ${capped.length} new email(s), created jobs directly`);
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

async function pollCycle(db: Database, channel: Server): Promise<void> {
  return withSpan(tracer, "email-watcher.poll", {}, async (span) => {
    const sources: Array<{ name: string; poll: () => Promise<EmailInfo[] | null> }> = [];

    if (gmailEnabled && !catchupQueue.has("gmail")) {
      const lastChecked = getLastChecked(db, "gmail");
      if (lastChecked === null && !awaitingFirstStart.has("gmail")) {
        awaitingFirstStart.add("gmail");
        await channel.notification({
          method: "notifications/claude/channel",
          params: {
            content:
              "First start for Gmail source. No previous checkpoint found.\n" +
              "How far back should I check for emails?\n" +
              "Ask the user via Telegram. They can reply with a duration (e.g. '3 days', '1 week') or 'skip'.\n" +
              "Then call init_source(source='gmail', since='3d') or skip_catchup(source='gmail').",
            meta: {
              event_type: "first_start",
              source: "gmail",
              timestamp: new Date().toISOString(),
            },
          },
        });
        log("Gmail: first start, awaiting user input");
      } else if (lastChecked !== null) {
        const query = buildGmailQuery(lastChecked);
        sources.push({ name: "gmail", poll: () => pollGmail(db, query) });
      }
    }

    if (OUTLOOK_ENABLED && !catchupQueue.has("outlook")) {
      const lastChecked = getLastChecked(db, "outlook");
      if (lastChecked === null && !awaitingFirstStart.has("outlook")) {
        awaitingFirstStart.add("outlook");
        await channel.notification({
          method: "notifications/claude/channel",
          params: {
            content:
              "First start for Outlook source. No previous checkpoint found.\n" +
              "How far back should I check for emails?\n" +
              "Ask the user via Telegram. They can reply with a duration (e.g. '3 days', '1 week') or 'skip'.\n" +
              "Then call init_source(source='outlook', since='3d') or skip_catchup(source='outlook').",
            meta: {
              event_type: "first_start",
              source: "outlook",
              timestamp: new Date().toISOString(),
            },
          },
        });
        log("Outlook: first start, awaiting user input");
      } else if (lastChecked !== null) {
        sources.push({ name: "outlook", poll: () => pollOutlook(db, lastChecked) });
      }
    }

    if (sources.length === 0) return;

    const results = await Promise.all(sources.map(s => s.poll()));
    let totalFound = 0;
    let totalNew = 0;

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i].name;
      const pollResult = results[i];

      // null = poll error (auth expired, connection refused, etc.)
      // Skip this source entirely — do NOT advance last_checked cursor.
      if (pollResult === null) {
        span.setAttribute(`poll.${source}.error`, true);
        span.setStatus({ code: SpanStatusCode.ERROR, message: `${source} poll failed, cursor not advanced` });
        continue;
      }

      let emails = pollResult;

      totalFound += pollResult.length;

      // Filter to emails not already in DB
      emails = emails.filter((e) => !emailExists(db, e.id));

      // Apply whitelist/blacklist filter
      if (EMAIL_FILTER_INCLUDE || EMAIL_FILTER_EXCLUDE) {
        const before = emails.length;
        emails = filterEmailsByRecipient(emails, EMAIL_FILTER_INCLUDE, EMAIL_FILTER_EXCLUDE);
        if (before !== emails.length) {
          log(`Email filter: ${before} -> ${emails.length} (include="${EMAIL_FILTER_INCLUDE}", exclude="${EMAIL_FILTER_EXCLUDE}")`);
        }
      }

      totalNew += emails.length;

      if (emails.length > MAX_CATCHUP_EMAILS) {
        catchupQueue.set(source, emails);
        await channel.notification({
          method: "notifications/claude/channel",
          params: {
            content:
              `Catchup required for ${source}: found ${emails.length} new emails since last check.\n` +
              `This exceeds the threshold of ${MAX_CATCHUP_EMAILS}.\n` +
              `Ask the user via Telegram whether to process all ${emails.length} emails or skip.\n` +
              `Call approve_catchup(source='${source}') to process, or skip_catchup(source='${source}') to skip.`,
            meta: {
              event_type: "catchup_required",
              source,
              email_count: String(emails.length),
              timestamp: new Date().toISOString(),
            },
          },
        });
        log(`${source}: ${emails.length} emails exceed catchup threshold, awaiting approval`);
      } else {
        await processNewEmails(db, channel, emails);
        setLastChecked(db, source, new Date().toISOString());
      }
    }

    span.setAttribute("email.found", totalFound);
    span.setAttribute("email.new", totalNew);

    lastSuccessfulPollAt = Date.now();
  });
}

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: "email-watcher", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      'Events from email-watcher arrive as <channel source="email-watcher" email_source="gmail|outlook" ...>.\n' +
      "Each event is a NEW email detected in a monitored inbox.\n" +
      "Special events: first_start (ask user how far back to check), catchup_required (too many emails, ask to approve).\n" +
      "Classify using the email-classifier subagent, then act on the result.\n" +
      "The email_source and message_id fields tell you which MCP tools to use.\n\n" +
      "For first_start events: ask user via Telegram, then call init_source or skip_catchup.\n" +
      "For catchup_required events: ask user via Telegram, then call approve_catchup or skip_catchup.",
  }
);

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

let db: Database;
let workflowDb: Database;

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_recent_emails",
      description: "Get recently discovered emails from the audit log, with optional filtering by source.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Max emails to return (default: 20)" },
          source: { type: "string", description: "Filter by source (gmail, outlook)" },
        },
      },
    },
    {
      name: "get_email_stats",
      description: "Get total email count and last-24-hour count.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "init_source",
      description:
        "Initialize a source on first start. Sets last_checked to the given duration in the past and triggers polling. " +
        "Call this after the user tells you how far back to check (e.g. '3d', '1w', '24h').",
      inputSchema: {
        type: "object" as const,
        properties: {
          source: { type: "string", enum: ["gmail", "outlook"], description: "Email source to initialize" },
          since: { type: "string", description: "Duration to look back (e.g. '3d', '1w', '24h', '12h')" },
        },
        required: ["source", "since"],
      },
    },
    {
      name: "approve_catchup",
      description:
        "Approve processing of queued catchup emails for a source. " +
        "Call this when the user approves processing emails accumulated during downtime.",
      inputSchema: {
        type: "object" as const,
        properties: {
          source: { type: "string", enum: ["gmail", "outlook"], description: "Email source to approve" },
        },
        required: ["source"],
      },
    },
    {
      name: "skip_catchup",
      description:
        "Skip queued catchup emails and set last_checked to now. " +
        "Call this when the user wants to skip accumulated emails.",
      inputSchema: {
        type: "object" as const,
        properties: {
          source: { type: "string", enum: ["gmail", "outlook"], description: "Email source to skip" },
        },
        required: ["source"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_recent_emails": {
        const limit = (args?.limit as number) ?? 20;
        const source = args?.source as string | undefined;

        const rows = getRecentEmails(db, { limit, source });
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      }

      case "get_email_stats": {
        const total = db.prepare("SELECT COUNT(*) as count FROM emails").get() as { count: number };
        const last24h = db.prepare(
          "SELECT COUNT(*) as count FROM emails WHERE discovered_at >= datetime('now', '-1 day')"
        ).get() as { count: number };
        return {
          content: [{ type: "text", text: JSON.stringify({ total: total.count, last_24h: last24h.count }) }],
        };
      }

      case "init_source": {
        const source = args?.source as string;
        const since = args?.since as string;
        if (!source || !since) {
          return { content: [{ type: "text", text: "Error: source and since are required" }], isError: true };
        }
        const ms = parseDuration(since);
        const lastChecked = new Date(Date.now() - ms).toISOString();
        setLastChecked(db, source, lastChecked);
        awaitingFirstStart.delete(source);
        log(`Initialized ${source}: last_checked=${lastChecked} (${since} ago)`);
        return {
          content: [{ type: "text", text: `Initialized ${source}: will check emails from ${lastChecked} (${since} ago). Next poll cycle will pick them up.` }],
        };
      }

      case "approve_catchup": {
        const source = args?.source as string;
        if (!source) {
          return { content: [{ type: "text", text: "Error: source is required" }], isError: true };
        }
        const queued = catchupQueue.get(source);
        if (!queued || queued.length === 0) {
          return { content: [{ type: "text", text: `No catchup emails queued for ${source}` }], isError: true };
        }
        // Process in batches — processNewEmails caps at MAX_NEW_PER_CYCLE
        for (let i = 0; i < queued.length; i += MAX_NEW_PER_CYCLE) {
          await processNewEmails(db, mcp, queued.slice(i, i + MAX_NEW_PER_CYCLE));
        }
        setLastChecked(db, source, new Date().toISOString());
        catchupQueue.delete(source);
        log(`Approved catchup for ${source}: processed ${queued.length} emails`);
        return {
          content: [{ type: "text", text: `Processed ${queued.length} catchup emails for ${source}` }],
        };
      }

      case "skip_catchup": {
        const source = args?.source as string;
        if (!source) {
          return { content: [{ type: "text", text: "Error: source is required" }], isError: true };
        }
        setLastChecked(db, source, new Date().toISOString());
        catchupQueue.delete(source);
        awaitingFirstStart.delete(source);
        log(`Skipped catchup for ${source}: last_checked set to now`);
        return {
          content: [{ type: "text", text: `Skipped catchup for ${source}. Will only process new emails from now.` }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `Error: ${e.message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Retry stuck emails
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Open SQLite DB
  log(`Opening database at ${DB_PATH}`);
  db = openDb(DB_PATH);
  log(`Opening workflow database at ${WORKFLOW_DB_PATH}`);
  workflowDb = openWorkflowDb(WORKFLOW_DB_PATH);
  registerMetrics(db, workflowDb);
  startHealthServer(db);

  // 2. Connect MCP server (stdio)
  await mcp.connect(new StdioServerTransport());
  log("MCP server connected (stdio)");

  // 3. Tool handlers are already registered above

  // 4. Wait for email MCP servers to start
  log(`Waiting ${STARTUP_DELAY_MS}ms for MCP servers to start...`);
  await new Promise((resolve) => setTimeout(resolve, STARTUP_DELAY_MS));

  // 5. Log config
  log(
    `Config: gmail=${gmailEnabled ? GMAIL_EMAIL : "disabled"}, ` +
    `outlook=${OUTLOOK_ENABLED ? "enabled" : "disabled"}, ` +
    `poll=${POLL_INTERVAL_MS}ms, db=${DB_PATH}`
  );

  // 6. Run first poll cycle + start interval timer (managed by watcher-runtime)
  await startPollLoop({
    name: "email-watcher",
    intervalMs: POLL_INTERVAL_MS,
    poll: () => pollCycle(db, mcp),
    logger: { log },
    runFirstCycleImmediately: true,
  });
}

if (import.meta.main) {
  main().catch((e) => {
    log(`Fatal error: ${e.message}`);
    process.exit(1);
  });
}
