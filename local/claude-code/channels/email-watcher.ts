#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// email-watcher channel
//
// MCP Server (stdio) that polls gmail-mcp and outlook-mcp over Streamable HTTP,
// persists discovered emails in SQLite, and pushes channel notifications for
// new emails. Also exposes update_email_status, get_recent_emails, and
// get_email_stats tools so Claude can write back results.
// ---------------------------------------------------------------------------

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Database } from "bun:sqlite";

import {
  openDb,
  insertEmail,
  emailExists,
  hasAnyEmailsForSource,
  updateEmail,
  getRecentEmails,
  getEmailStats,
  type InsertEmail,
} from "./db";

import { initTracing, getTracer, withSpan, createLogger, getActiveTraceId } from "./tracing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmailInfo {
  id: string;
  source: "gmail" | "outlook";
  sender?: string;
  to?: string;
  subject?: string;
  preview?: string;
  hasAttachments?: boolean;
  receivedAt?: string;
}

// ---------------------------------------------------------------------------
// Config (env vars)
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "30000", 10);
const DB_PATH = process.env.DB_PATH ?? "/data/email-watcher/emails.db";
const STARTUP_DELAY_MS = parseInt(process.env.STARTUP_DELAY_MS ?? "15000", 10);
const MAX_NEW_PER_CYCLE = parseInt(process.env.MAX_NEW_PER_CYCLE ?? "5", 10);
const METRICS_PORT = parseInt(process.env.EMAIL_WATCHER_METRICS_PORT ?? "9465", 10);
const HEALTH_STALE_MULTIPLIER = 5; // unhealthy after N missed poll cycles

const GMAIL_MCP_URL = process.env.GMAIL_MCP_URL ?? "http://gmail-mcp:8000/mcp";
const GMAIL_EMAIL = process.env.GMAIL_EMAIL ?? "";
const GMAIL_SEARCH_QUERY = process.env.GMAIL_SEARCH_QUERY ?? "newer_than:1d";

const OUTLOOK_MCP_URL = process.env.OUTLOOK_MCP_URL ?? "http://outlook-mcp:8002/mcp";
const OUTLOOK_ENABLED = (process.env.OUTLOOK_ENABLED ?? "true").toLowerCase() !== "false";

// Email filtering: whitelist/blacklist by recipient address (supports Gmail + addressing)
// EMAIL_FILTER_INCLUDE: only process emails where TO contains this string (dev: "+dev")
// EMAIL_FILTER_EXCLUDE: skip emails where TO contains this string (prod: "+dev")
const EMAIL_FILTER_INCLUDE = process.env.EMAIL_FILTER_INCLUDE ?? "";
const EMAIL_FILTER_EXCLUDE = process.env.EMAIL_FILTER_EXCLUDE ?? "";

import { filterEmailsByRecipient } from "./email-filter";

const gmailEnabled = GMAIL_EMAIL.length > 0;

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

initTracing("email-watcher");
const tracer = getTracer("email-watcher");

// ---------------------------------------------------------------------------
// Logging — all to stderr (stdout reserved for MCP stdio transport)
// ---------------------------------------------------------------------------

const log = createLogger("email-watcher");

function esc(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function metricLine(
  name: string,
  labels: Record<string, string | null | undefined>,
  value: number,
): string {
  const parts = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length > 0
    ? `${name}{${parts.join(",")}} ${value}`
    : `${name} ${value}`;
}

function renderMetrics(db: Database): string {
  const lines: string[] = [
    "# HELP email_watcher_emails_total Emails tracked by source and status.",
    "# TYPE email_watcher_emails_total gauge",
  ];

  const emailsBySourceStatus = db
    .query(
      `SELECT source, status, COUNT(*) AS count
       FROM emails
       GROUP BY source, status
       ORDER BY source, status`
    )
    .all() as Array<{ source: string; status: string; count: number }>;

  for (const row of emailsBySourceStatus) {
    lines.push(
      metricLine(
        "email_watcher_emails_total",
        { source: row.source, status: row.status },
        row.count,
      ),
    );
  }

  lines.push(
    "# HELP email_watcher_backlog_total Emails waiting for classification or processing.",
    "# TYPE email_watcher_backlog_total gauge",
  );

  const backlog = db
    .query(
      `SELECT source, COUNT(*) AS count
       FROM emails
       WHERE status = 'new'
       GROUP BY source
       ORDER BY source`
    )
    .all() as Array<{ source: string; count: number }>;

  for (const row of backlog) {
    lines.push(metricLine("email_watcher_backlog_total", { source: row.source }, row.count));
  }

  lines.push(
    "# HELP email_watcher_attachments_total Emails with attachments by source and status.",
    "# TYPE email_watcher_attachments_total gauge",
  );

  const attachments = db
    .query(
      `SELECT source, status, COUNT(*) AS count
       FROM emails
       WHERE has_attachments = 1
       GROUP BY source, status
       ORDER BY source, status`
    )
    .all() as Array<{ source: string; status: string; count: number }>;

  for (const row of attachments) {
    lines.push(
      metricLine(
        "email_watcher_attachments_total",
        { source: row.source, status: row.status },
        row.count,
      ),
    );
  }

  lines.push(
    "# HELP email_watcher_recent_discovered_total Emails discovered in the last 24 hours by source and status.",
    "# TYPE email_watcher_recent_discovered_total gauge",
  );

  const recent = db
    .query(
      `SELECT source, status, COUNT(*) AS count
       FROM emails
       WHERE discovered_at >= datetime('now', '-1 day')
       GROUP BY source, status
       ORDER BY source, status`
    )
    .all() as Array<{ source: string; status: string; count: number }>;

  for (const row of recent) {
    lines.push(
      metricLine(
        "email_watcher_recent_discovered_total",
        { source: row.source, status: row.status },
        row.count,
      ),
    );
  }

  lines.push(
    "# HELP email_watcher_actions_total Classified actions recorded by the workflow.",
    "# TYPE email_watcher_actions_total gauge",
  );

  const actions = db
    .query(
      `SELECT action, COUNT(*) AS count
       FROM emails
       WHERE action IS NOT NULL
       GROUP BY action
       ORDER BY action`
    )
    .all() as Array<{ action: string; count: number }>;

  for (const row of actions) {
    lines.push(metricLine("email_watcher_actions_total", { action: row.action }, row.count));
  }

  lines.push(
    "# HELP email_watcher_confidence_total Classified emails by confidence level.",
    "# TYPE email_watcher_confidence_total gauge",
  );

  const confidences = db
    .query(
      `SELECT confidence, COUNT(*) AS count
       FROM emails
       WHERE confidence IS NOT NULL
       GROUP BY confidence
       ORDER BY confidence`
    )
    .all() as Array<{ confidence: string; count: number }>;

  for (const row of confidences) {
    lines.push(
      metricLine("email_watcher_confidence_total", { confidence: row.confidence }, row.count),
    );
  }

  lines.push(
    "# HELP email_watcher_vendors_total Classified vendors recorded by the workflow.",
    "# TYPE email_watcher_vendors_total gauge",
  );

  const vendors = db
    .query(
      `SELECT vendor, COUNT(*) AS count
       FROM emails
       WHERE vendor IS NOT NULL
       GROUP BY vendor
       ORDER BY count DESC, vendor
       LIMIT 20`
    )
    .all() as Array<{ vendor: string; count: number }>;

  for (const row of vendors) {
    lines.push(metricLine("email_watcher_vendors_total", { vendor: row.vendor }, row.count));
  }

  lines.push(
    "# HELP email_watcher_processed_results_total Processing outcomes by status.",
    "# TYPE email_watcher_processed_results_total gauge",
  );

  const processed = db
    .query(
      `SELECT status, COUNT(*) AS count
       FROM emails
       WHERE processed_at IS NOT NULL
       GROUP BY status
       ORDER BY status`
    )
    .all() as Array<{ status: string; count: number }>;

  for (const row of processed) {
    lines.push(metricLine("email_watcher_processed_results_total", { status: row.status }, row.count));
  }

  lines.push(
    "# HELP email_watcher_latency_seconds Workflow latency derived from the email audit trail.",
    "# TYPE email_watcher_latency_seconds gauge",
  );

  const latencies = db
    .query(
      `SELECT
         'classification' AS stage,
         AVG((julianday(classified_at) - julianday(discovered_at)) * 86400.0) AS avg_seconds
       FROM emails
       WHERE classified_at IS NOT NULL
       UNION ALL
       SELECT
         'processing' AS stage,
         AVG((julianday(processed_at) - julianday(discovered_at)) * 86400.0) AS avg_seconds
       FROM emails
       WHERE processed_at IS NOT NULL`
    )
    .all() as Array<{ stage: string; avg_seconds: number | null }>;

  for (const row of latencies) {
    if (row.avg_seconds !== null) {
      lines.push(
        metricLine(
          "email_watcher_latency_seconds",
          { stage: row.stage },
          row.avg_seconds,
        ),
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

function startMetricsServer(db: Database): void {
  Bun.serve({
    port: METRICS_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        // Check DB is accessible and polls aren't stale
        try {
          db.query("SELECT 1").get();
          const staleMs = Date.now() - lastSuccessfulPollAt;
          const maxStaleMs = POLL_INTERVAL_MS * HEALTH_STALE_MULTIPLIER;
          if (staleMs > maxStaleMs) {
            return new Response(`stale: last poll ${Math.round(staleMs / 1000)}s ago`, { status: 503 });
          }
          return new Response("ok", { status: 200 });
        } catch {
          return new Response("db error", { status: 503 });
        }
      }
      if (url.pathname === "/metrics") {
        return new Response(renderMetrics(db), {
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  log(`Metrics server listening on :${METRICS_PORT} (/health, /metrics)`);
}

// ---------------------------------------------------------------------------
// MCP Client helpers
// ---------------------------------------------------------------------------

let gmailClient: Client | null = null;
let outlookClient: Client | null = null;
let lastSuccessfulPollAt: number = Date.now();

async function getGmailClient(): Promise<Client> {
  if (gmailClient) return gmailClient;

  const client = new Client({ name: "email-watcher-gmail", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(GMAIL_MCP_URL));
  await client.connect(transport);
  gmailClient = client;
  log("Connected to gmail-mcp");
  return client;
}

async function getOutlookClient(): Promise<Client> {
  if (outlookClient) return outlookClient;

  const client = new Client({ name: "email-watcher-outlook", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(OUTLOOK_MCP_URL));
  await client.connect(transport);
  outlookClient = client;
  log("Connected to outlook-mcp");
  return client;
}

function resetGmailClient(): void {
  gmailClient = null;
}

function resetOutlookClient(): void {
  outlookClient = null;
}

/**
 * Extract data from MCP tool result content blocks.
 *
 * FastMCP (Python) serialises list[dict] as separate text content blocks —
 * one JSON object per block. If there are multiple text blocks, try to parse
 * each individually and return an array. Single block: try JSON.parse, fall
 * back to raw text.
 */
function parseToolResult(result: any): any {
  if (!result?.content) return null;

  const texts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  if (texts.length === 0) return null;

  // Multiple text blocks → likely one JSON object per block (FastMCP list)
  if (texts.length > 1) {
    const items = texts.map((t) => {
      try { return JSON.parse(t); } catch { return t; }
    });
    return items;
  }

  // Single block → try JSON.parse, fall back to raw text
  try {
    return JSON.parse(texts[0]);
  } catch {
    return texts[0];
  }
}

// ---------------------------------------------------------------------------
// Gmail polling
// ---------------------------------------------------------------------------

/**
 * Extract message IDs from gmail search results.
 * Handles: JSON array of strings, JSON object with messages key,
 * or raw text with hex IDs.
 */
function extractGmailIds(data: any): string[] {
  // Array of strings (IDs directly)
  if (Array.isArray(data)) {
    if (data.length > 0 && typeof data[0] === "string") return data;
    // Array of objects with id field
    if (data.length > 0 && typeof data[0] === "object" && data[0]?.id) {
      return data.map((m: any) => String(m.id));
    }
    return [];
  }

  // Object with messages array
  if (data && typeof data === "object") {
    if (Array.isArray(data.messages)) return extractGmailIds(data.messages);
    if (Array.isArray(data.messageIds)) return data.messageIds;
    if (data.id) return [String(data.id)];
  }

  // Raw text — look for 16+ character hex IDs
  if (typeof data === "string") {
    const matches = data.match(/\b[0-9a-f]{16,}\b/gi);
    return matches ?? [];
  }

  return [];
}

/**
 * Parse gmail email data into EmailInfo[].
 * Handles JSON array of email objects or minimal fallback.
 */
function parseGmailEmails(data: any, ids: string[]): EmailInfo[] {
  const emails: EmailInfo[] = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        const id = String(item.id ?? item.messageId ?? item.message_id ?? "");
        if (!id) continue;
        emails.push({
          id,
          source: "gmail",
          sender: item.sender ?? item.from ?? item.fromAddress ?? undefined,
          to: item.to ?? item.toAddress ?? item.recipient ?? undefined,
          subject: item.subject ?? undefined,
          preview: item.snippet ?? item.preview ?? item.body?.substring(0, 200) ?? undefined,
          hasAttachments: item.hasAttachments ?? item.has_attachments ?? false,
          receivedAt: item.receivedAt ?? item.received_at ?? item.date ?? item.internalDate ?? undefined,
        });
      }
    }
    if (emails.length > 0) return emails;
  }

  // Formatted text from google_workspace_mcp — parse Subject/From/Date
  if (typeof data === "string" && data.includes("Message ID:")) {
    const blocks = data.split(/(?=Message ID:)/);
    for (const block of blocks) {
      const idMatch = block.match(/Message ID:\s*(\S+)/);
      if (!idMatch) continue;
      const fromMatch = block.match(/From:\s*(.+)/);
      const toMatch = block.match(/To:\s*(.+)/);
      const subjectMatch = block.match(/Subject:\s*(.+)/);
      const dateMatch = block.match(/Date:\s*(.+)/);
      // Extract email from "Display Name" <email> format
      const rawFrom = fromMatch?.[1]?.trim() ?? "";
      const emailMatch = rawFrom.match(/<([^>]+)>/);
      const rawTo = toMatch?.[1]?.trim() ?? "";
      const toEmailMatch = rawTo.match(/<([^>]+)>/);
      emails.push({
        id: idMatch[1],
        source: "gmail",
        sender: emailMatch ? emailMatch[1] : rawFrom,
        to: toEmailMatch ? toEmailMatch[1] : rawTo || undefined,
        subject: subjectMatch?.[1]?.trim(),
        hasAttachments: false,
        receivedAt: dateMatch?.[1]?.trim(),
      });
    }
    if (emails.length > 0) return emails;
  }

  // No fallback — IDs without metadata are useless (can't classify).
  // The same IDs will appear on the next poll when the MCP is healthy.
  return [];
}

async function pollGmail(): Promise<EmailInfo[]> {
  if (!gmailEnabled) return [];

  try {
    const client = await getGmailClient();

    // Step 1: Search for messages
    const searchResult = await client.callTool({
      name: "search_gmail_messages",
      arguments: {
        query: GMAIL_SEARCH_QUERY,
        user_google_email: GMAIL_EMAIL,
        page_size: 50,
      },
    });

    const searchData = parseToolResult(searchResult);
    if (!searchData) {
      log("Gmail search returned no data");
      return [];
    }

    const ids = [...new Set(extractGmailIds(searchData))];
    if (ids.length === 0) {
      return [];
    }

    // If search result already had rich metadata (subjects), use it directly
    const fromSearch = parseGmailEmails(searchData, []);
    const hasMetadata = fromSearch.some((e) => e.subject || e.sender);
    if (fromSearch.length > 0 && hasMetadata) {
      return fromSearch;
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
    if (emails.length > 0) return emails;
  } catch (e: any) {
    log(`Gmail poll error: ${e.message}`);
    resetGmailClient();
    return [];
  }
}

// ---------------------------------------------------------------------------
// Outlook polling
// ---------------------------------------------------------------------------

async function pollOutlook(): Promise<EmailInfo[]> {
  if (!OUTLOOK_ENABLED) return [];

  try {
    const client = await getOutlookClient();

    const result = await client.callTool({
      name: "list_emails",
      arguments: { top: 20 },
    });

    const data = parseToolResult(result);
    if (!data || !Array.isArray(data)) {
      log("Outlook returned non-array data");
      return [];
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
    return [];
  }
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

async function pollCycle(db: Database, channel: Server): Promise<void> {
  return withSpan(tracer, "email-watcher.poll", {}, async (span) => {
    const [gmailEmails, outlookEmails] = await Promise.all([
      pollGmail(),
      pollOutlook(),
    ]);

    // Per-source seeding: each source seeds independently on its first
    // successful poll. This prevents the bug where Gmail seeds first, then
    // Outlook emails on the next cycle are treated as "new" (not seeded)
    // because the global hasAnyEmails() already returns true.
    const emailsBySource: Map<string, EmailInfo[]> = new Map();
    for (const email of gmailEmails) {
      const list = emailsBySource.get(email.source) ?? [];
      list.push(email);
      emailsBySource.set(email.source, list);
    }
    for (const email of outlookEmails) {
      const list = emailsBySource.get(email.source) ?? [];
      list.push(email);
      emailsBySource.set(email.source, list);
    }

    // Seed any source that has never been seen before
    let seededCount = 0;
    const emailsToProcess: EmailInfo[] = [];
    for (const [source, emails] of emailsBySource) {
      if (!hasAnyEmailsForSource(db, source)) {
        log(`First scan for ${source}: seeding ${emails.length} emails`);
        for (const email of emails) {
          insertEmail(db, {
            id: email.id,
            source: email.source,
            sender: email.sender ?? null,
            subject: email.subject ?? null,
            preview: email.preview ?? null,
            hasAttachments: email.hasAttachments ?? false,
            receivedAt: email.receivedAt ?? null,
            status: "seed",
          });
          seededCount++;
        }
      } else {
        emailsToProcess.push(...emails);
      }
    }

    // Filter to emails not already in DB
    let newEmails = emailsToProcess.filter((e) => !emailExists(db, e.id));

    // Apply whitelist/blacklist filter on recipient address
    if (EMAIL_FILTER_INCLUDE || EMAIL_FILTER_EXCLUDE) {
      const before = newEmails.length;
      newEmails = filterEmailsByRecipient(newEmails, EMAIL_FILTER_INCLUDE, EMAIL_FILTER_EXCLUDE);
      if (before !== newEmails.length) {
        log(`Email filter: ${before} → ${newEmails.length} (include="${EMAIL_FILTER_INCLUDE}", exclude="${EMAIL_FILTER_EXCLUDE}")`);
      }
    }

    // Poll completed successfully (reached MCP servers, no errors)
    lastSuccessfulPollAt = Date.now();

    const totalFound = gmailEmails.length + outlookEmails.length;
    span.setAttribute("email.found", totalFound);
    span.setAttribute("email.new", newEmails.length);
    span.setAttribute("email.seeded", seededCount);
    span.setAttribute("email.with_attachments", newEmails.filter(e => e.hasAttachments).length);

    if (newEmails.length === 0) {
      return;
    }

    // Cap to avoid flooding
    const capped = newEmails.slice(0, MAX_NEW_PER_CYCLE);
    if (newEmails.length > MAX_NEW_PER_CYCLE) {
      log(`Capped new emails from ${newEmails.length} to ${MAX_NEW_PER_CYCLE}`);
    }

    for (const email of capped) {
      // Insert as 'new'
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
      });

      // Push channel notification
      const contentLines = [
        "New email detected:",
        `Source: ${email.source}`,
      ];
      if (email.sender) contentLines.push(`From: ${email.sender}`);
      if (email.subject) contentLines.push(`Subject: ${email.subject}`);
      contentLines.push(`Has attachments: ${email.hasAttachments ? "yes" : "no"}`);
      if (email.preview) contentLines.push(`Preview: ${email.preview}`);
      contentLines.push(`Message ID: ${email.id}`);

      await channel.notification({
        method: "notifications/claude/channel",
        params: {
          content: contentLines.join("\n"),
          meta: {
            email_source: email.source,
            sender: email.sender ?? "",
            subject: email.subject ?? "",
            has_attachments: String(email.hasAttachments ?? false),
            message_id: email.id,
            received_at: email.receivedAt ?? "",
            timestamp: new Date().toISOString(),
          },
        },
      });
    }

    log(`Pushed ${capped.length} new email(s)`);
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
      "Classify using the email-classifier subagent, then act on the result.\n" +
      "The email_source and message_id fields tell you which MCP tools to use.\n\n" +
      "IMPORTANT: After classifying and/or processing an email, call update_email_status to record the result.",
  }
);

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

let db: Database;

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "update_email_status",
      description:
        "Update the status and classification details of a tracked email. " +
        "Call this after classifying or processing an email to record the result.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Email ID (message_id from the channel event)" },
          status: {
            type: "string",
            enum: ["classified", "processed", "failed", "ignored"],
            description: "New status for the email",
          },
          classification: { type: "string", description: "Classification JSON from email-classifier" },
          action: { type: "string", description: "Action taken (download_and_upload, notify_user, ignore)" },
          vendor: { type: "string", description: "Detected vendor name" },
          confidence: { type: "string", description: "Classification confidence (high, medium, low)" },
          process_result: { type: "string", description: "Result of processing (e.g. Paperless upload result)" },
        },
        required: ["id", "status"],
      },
    },
    {
      name: "get_recent_emails",
      description: "Get recently discovered emails from the audit log, with optional filtering by status and source.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Max emails to return (default: 20)" },
          status: { type: "string", description: "Filter by status (new, seed, classified, processed, failed, ignored)" },
          source: { type: "string", description: "Filter by source (gmail, outlook)" },
        },
      },
    },
    {
      name: "get_email_stats",
      description: "Get email counts grouped by status, including a last-24-hour breakdown.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "update_email_status": {
        const id = args?.id as string;
        const status = args?.status as string;
        if (!id || !status) {
          return {
            content: [{ type: "text", text: "Error: id and status are required" }],
            isError: true,
          };
        }

        const fields: Record<string, string | null> = { status };
        if (args?.classification) fields.classification = args.classification as string;
        if (args?.action) fields.action = args.action as string;
        if (args?.vendor) fields.vendor = args.vendor as string;
        if (args?.confidence) fields.confidence = args.confidence as string;
        if (args?.process_result) fields.process_result = args.process_result as string;

        const found = updateEmail(db, id, fields);
        if (!found) {
          return {
            content: [{ type: "text", text: `Email ${id} not found in database` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `Updated email ${id}: status=${status}` }],
        };
      }

      case "get_recent_emails": {
        const limit = (args?.limit as number) ?? 20;
        const status = args?.status as string | undefined;
        const source = args?.source as string | undefined;

        const rows = getRecentEmails(db, { limit, status, source });
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      }

      case "get_email_stats": {
        const stats = getEmailStats(db);
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
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

/**
 * Re-push emails stuck in non-terminal states (new, classified) as channel
 * notifications. These got stuck because Claude restarted mid-processing.
 * The DB is the source of truth — if status isn't terminal, re-push it.
 */
async function retryStuckEmails(db: Database, channel: Server): Promise<void> {
  const stuck = db
    .prepare(
      `SELECT * FROM emails
       WHERE status IN ('new', 'classified')
       ORDER BY discovered_at ASC`
    )
    .all() as import("./db").EmailRow[];

  if (stuck.length === 0) return;

  // Skip emails with no metadata — they can never be classified.
  // Mark them as failed so they don't get retried forever.
  const retryable = stuck.filter((e) => e.sender || e.subject);
  const unretryable = stuck.length - retryable.length;
  if (unretryable > 0) {
    log(`Marking ${unretryable} stuck email(s) as failed (no metadata)`);
    for (const email of stuck) {
      if (!email.sender && !email.subject) {
        updateEmail(db, email.id, {
          status: "failed",
          process_result: "No metadata (batch-fetch failed during discovery)",
        });
      }
    }
  }

  if (retryable.length === 0) return;

  log(`Retrying ${retryable.length} stuck email(s) (new/classified)`);

  const capped = retryable.slice(0, MAX_NEW_PER_CYCLE);
  if (retryable.length > MAX_NEW_PER_CYCLE) {
    log(`Capped retry from ${retryable.length} to ${MAX_NEW_PER_CYCLE}`);
  }

  for (const email of capped) {
    const contentLines = [
      "Retry: email stuck from previous session:",
      `Source: ${email.source}`,
    ];
    if (email.sender) contentLines.push(`From: ${email.sender}`);
    if (email.subject) contentLines.push(`Subject: ${email.subject}`);
    contentLines.push(`Has attachments: ${email.has_attachments ? "yes" : "no"}`);
    if (email.preview) contentLines.push(`Preview: ${email.preview}`);
    contentLines.push(`Message ID: ${email.id}`);
    contentLines.push(`Current status: ${email.status}`);

    await channel.notification({
      method: "notifications/claude/channel",
      params: {
        content: contentLines.join("\n"),
        meta: {
          email_source: email.source,
          sender: email.sender ?? "",
          subject: email.subject ?? "",
          has_attachments: String(email.has_attachments === 1),
          message_id: email.id,
          received_at: email.received_at ?? "",
          timestamp: new Date().toISOString(),
          retry: "true",
        },
      },
    });
  }

  log(`Re-pushed ${capped.length} stuck email(s)`);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Open SQLite DB
  log(`Opening database at ${DB_PATH}`);
  db = openDb(DB_PATH);
  startMetricsServer(db);

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

  // 6. Run first poll cycle
  try {
    await pollCycle(db, mcp);
  } catch (e: any) {
    log(`First poll cycle error: ${e.message}`);
  }

  // 7. Retry emails stuck from previous session (new/classified)
  try {
    await retryStuckEmails(db, mcp);
  } catch (e: any) {
    log(`Retry stuck emails error: ${e.message}`);
  }

  // 8. Start interval timer
  setInterval(async () => {
    try {
      await pollCycle(db, mcp);
    } catch (e: any) {
      log(`Poll cycle error: ${e.message}`);
    }
  }, POLL_INTERVAL_MS);
}

main().catch((e) => {
  log(`Fatal error: ${e.message}`);
  process.exit(1);
});
