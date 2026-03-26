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
  hasAnyEmails,
  updateEmail,
  getRecentEmails,
  getEmailStats,
  type InsertEmail,
} from "./db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmailInfo {
  id: string;
  source: "gmail" | "outlook";
  sender?: string;
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

const GMAIL_MCP_URL = process.env.GMAIL_MCP_URL ?? "http://gmail-mcp:8000/mcp";
const GMAIL_EMAIL = process.env.GMAIL_EMAIL ?? "";
const GMAIL_SEARCH_QUERY = process.env.GMAIL_SEARCH_QUERY ?? "newer_than:1d";

const OUTLOOK_MCP_URL = process.env.OUTLOOK_MCP_URL ?? "http://outlook-mcp:8002/mcp";
const OUTLOOK_ENABLED = (process.env.OUTLOOK_ENABLED ?? "true").toLowerCase() !== "false";

const gmailEnabled = GMAIL_EMAIL.length > 0;

// ---------------------------------------------------------------------------
// Logging — all to stderr (stdout reserved for MCP stdio transport)
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.error(`[email-watcher] ${msg}`);
}

// ---------------------------------------------------------------------------
// MCP Client helpers
// ---------------------------------------------------------------------------

let gmailClient: Client | null = null;
let outlookClient: Client | null = null;

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
 * Extract text from MCP tool result content blocks.
 * Tries JSON.parse on text content, falls back to raw text.
 */
function parseToolResult(result: any): any {
  if (!result?.content) return null;

  const texts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  const joined = texts.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
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
          subject: item.subject ?? undefined,
          preview: item.snippet ?? item.preview ?? item.body?.substring(0, 200) ?? undefined,
          hasAttachments: item.hasAttachments ?? item.has_attachments ?? false,
          receivedAt: item.receivedAt ?? item.received_at ?? item.date ?? item.internalDate ?? undefined,
        });
      }
    }
    if (emails.length > 0) return emails;
  }

  // Fallback: use the IDs we extracted, minimal info
  for (const id of ids) {
    emails.push({ id, source: "gmail" });
  }
  return emails;
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
        page_size: 20,
      },
    });

    const searchData = parseToolResult(searchResult);
    if (!searchData) {
      log("Gmail search returned no data");
      return [];
    }

    const ids = extractGmailIds(searchData);
    if (ids.length === 0) {
      return [];
    }

    // If search result already had rich metadata, use it directly
    const fromSearch = parseGmailEmails(searchData, []);
    if (fromSearch.length > 0) {
      return fromSearch;
    }

    // Step 2: Batch-fetch content for the IDs
    try {
      const contentResult = await client.callTool({
        name: "get_gmail_messages_content_batch",
        arguments: {
          message_ids: ids,
          user_google_email: GMAIL_EMAIL,
          format: "metadata",
        },
      });

      const contentData = parseToolResult(contentResult);
      if (contentData) {
        const fromContent = parseGmailEmails(contentData, ids);
        if (fromContent.length > 0) return fromContent;
      }
    } catch (e: any) {
      log(`Gmail batch-fetch failed, using IDs only: ${e.message}`);
    }

    // Fallback: return IDs with minimal info
    return parseGmailEmails(null, ids);
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
  const [gmailEmails, outlookEmails] = await Promise.all([
    pollGmail(),
    pollOutlook(),
  ]);

  const allEmails = [...gmailEmails, ...outlookEmails];

  if (allEmails.length === 0) {
    return;
  }

  // First scan: seed all emails, don't notify
  const isFirstScan = !hasAnyEmails(db);
  if (isFirstScan) {
    log(`First scan: seeding ${allEmails.length} emails`);
    for (const email of allEmails) {
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
    }
    return;
  }

  // Filter to emails not already in DB
  const newEmails = allEmails.filter((e) => !emailExists(db, e.id));

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
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Open SQLite DB
  log(`Opening database at ${DB_PATH}`);
  db = openDb(DB_PATH);

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

  // 7. Start interval timer
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
