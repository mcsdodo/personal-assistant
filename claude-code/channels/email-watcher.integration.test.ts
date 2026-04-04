import { mock } from "bun:test";
import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Env vars — MUST be set before the email-watcher module is imported so
// that module-level constants pick them up.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpDirForModule = mkdtempSync(join(tmpdir(), "ew-integ-module-"));

process.env.GMAIL_EMAIL = "integration@gmail.com";
process.env.OUTLOOK_ENABLED = "true";
process.env.STARTUP_DELAY_MS = "0";
process.env.POLL_INTERVAL_MS = "999999";
process.env.DB_PATH = join(tmpDirForModule, "module.db");
process.env.EMAIL_WATCHER_METRICS_PORT = "19465";
process.env.MAX_CATCHUP_EMAILS = "100";
process.env.EMAIL_FILTER_INCLUDE = "";
process.env.EMAIL_FILTER_EXCLUDE = "";

// ---------------------------------------------------------------------------
// Real-SQLite-backed ./db mock
//
// When running alongside other test files (e.g. email-watcher-utils.test.ts)
// that also mock ./db, bun uses whichever mock.module call is registered
// first. By providing our own mock with real SQLite logic, we ensure the
// email-watcher functions operate against a real database regardless of
// which mock "wins".
// ---------------------------------------------------------------------------

const DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  sender TEXT,
  subject TEXT,
  preview TEXT,
  has_attachments INTEGER DEFAULT 0,
  received_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  classified_at TEXT,
  classification TEXT,
  action TEXT,
  vendor TEXT,
  confidence TEXT,
  processed_at TEXT,
  process_result TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  trace_id TEXT
);
CREATE TABLE IF NOT EXISTS source_state (
  source TEXT PRIMARY KEY,
  last_checked TEXT NOT NULL
);
`;

function createDb(path?: string): Database {
  const db = path ? new Database(path, { create: true }) : new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(DB_SCHEMA);
  return db;
}

let currentDb: Database = createDb();

function openDbMock(_path: string): Database {
  return currentDb;
}

function insertEmailMock(db: Database, email: any): void {
  db.prepare(
    `INSERT OR IGNORE INTO emails
       (id, source, sender, subject, preview, has_attachments, received_at, status, trace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    email.id, email.source, email.sender ?? null, email.subject ?? null,
    email.preview ?? null, email.hasAttachments ? 1 : 0,
    email.receivedAt ?? null, email.status, email.traceId ?? null,
  );
}

function emailExistsMock(db: Database, id: string): boolean {
  return db.prepare("SELECT 1 FROM emails WHERE id = ? LIMIT 1").get(id) !== null;
}

function getLastCheckedMock(db: Database, source: string): string | null {
  const row = db.prepare("SELECT last_checked FROM source_state WHERE source = ? LIMIT 1")
    .get(source) as { last_checked: string } | null;
  return row?.last_checked ?? null;
}

function setLastCheckedMock(db: Database, source: string, timestamp: string): void {
  db.prepare(
    `INSERT INTO source_state (source, last_checked) VALUES (?, ?)
     ON CONFLICT(source) DO UPDATE SET last_checked = excluded.last_checked`
  ).run(source, timestamp);
}

const ALLOWED_UPDATE_FIELDS = new Set([
  "status", "classification", "classified_at", "action",
  "vendor", "confidence", "process_result", "processed_at",
]);

function updateEmailMock(db: Database, id: string, fields: Record<string, string | null>): boolean {
  const filtered: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_UPDATE_FIELDS.has(key)) filtered[key] = value ?? null;
  }
  if ("classification" in filtered && !("classified_at" in filtered))
    filtered.classified_at = new Date().toISOString();
  if ("process_result" in filtered && !("processed_at" in filtered))
    filtered.processed_at = new Date().toISOString();
  const keys = Object.keys(filtered);
  if (keys.length === 0)
    return db.prepare("SELECT 1 FROM emails WHERE id = ? LIMIT 1").get(id) !== null;
  const setClauses = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => filtered[k]);
  return db.prepare(`UPDATE emails SET ${setClauses} WHERE id = ?`).run(...values, id).changes > 0;
}

function getRecentEmailsMock(db: Database, opts: { limit?: number; status?: string; source?: string }) {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) { conditions.push("status = ?"); params.push(opts.status); }
  if (opts.source) { conditions.push("source = ?"); params.push(opts.source); }
  let sql = "SELECT * FROM emails";
  if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY discovered_at DESC";
  if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
  return db.prepare(sql).all(...params);
}

function getEmailStatsMock(db: Database) {
  return db.prepare(
    `SELECT status, COUNT(*) as count,
       SUM(CASE WHEN discovered_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) as last_24h
     FROM emails GROUP BY status`
  ).all();
}

// ---------------------------------------------------------------------------
// MCP Client mock — uses globalThis so it works regardless of which test
// file's mock.module call "wins" (bun uses the first registered mock).
// ---------------------------------------------------------------------------

type CallToolFn = (args: { name: string; arguments: any }) => Promise<any>;

// Store callTool implementations on globalThis so even if another file's
// Client mock is used instead of ours, we can still control behavior.
const G = globalThis as any;
G.__ewIntegGmailCallTool = async () => ({ content: [] });
G.__ewIntegOutlookCallTool = async () => ({ content: [] });

// Convenience accessors in this file's scope.
function setGmailCallTool(fn: CallToolFn) { G.__ewIntegGmailCallTool = fn; }
function setOutlookCallTool(fn: CallToolFn) { G.__ewIntegOutlookCallTool = fn; }

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// MCP SDK mocks — each test file must register these (bun uses first-registered).
// The Client mock delegates to globalThis hooks for per-test control.
mock.module("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler() {}
    connect() { return Promise.resolve(); }
    async notification() {}
  },
}));
mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));
mock.module("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: Symbol("ListToolsRequestSchema"),
  CallToolRequestSchema: Symbol("CallToolRequestSchema"),
}));
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    _name = "";
    constructor(opts?: any) { this._name = opts?.name ?? ""; }
    connect() { return Promise.resolve(); }
    callTool(args: any) {
      const g = globalThis as any;
      if (this._name.includes("gmail") && typeof g.__ewIntegGmailCallTool === "function")
        return g.__ewIntegGmailCallTool(args);
      if (this._name.includes("outlook") && typeof g.__ewIntegOutlookCallTool === "function")
        return g.__ewIntegOutlookCallTool(args);
      return Promise.resolve({ content: [] });
    }
  },
}));
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class { constructor() {} },
}));

mock.module("./db", () => ({
  openDb: openDbMock,
  insertEmail: insertEmailMock,
  emailExists: emailExistsMock,
  getLastChecked: getLastCheckedMock,
  setLastChecked: setLastCheckedMock,
  updateEmail: updateEmailMock,
  getRecentEmails: getRecentEmailsMock,
  getEmailStats: getEmailStatsMock,
  getEmailTraceId: (db: Database, id: string) => {
    const row = db.prepare("SELECT trace_id FROM emails WHERE id = ? LIMIT 1").get(id) as { trace_id: string | null } | null;
    return row?.trace_id ?? null;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks registered)
// ---------------------------------------------------------------------------

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

let pollGmail: any;
let pollOutlook: any;
let processNewEmails: any;
let resetGmailClient: any;
let resetOutlookClient: any;

beforeAll(async () => {
  const mod = await import("./email-watcher");
  pollGmail = mod.pollGmail;
  pollOutlook = mod.pollOutlook;
  processNewEmails = mod.processNewEmails;
  resetGmailClient = mod.resetGmailClient;
  resetOutlookClient = mod.resetOutlookClient;
});

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

let db: Database;
let mockChannel: { _notifications: any[]; notification: (msg: any) => Promise<void> };

beforeEach(() => {
  db = createDb();
  currentDb = db;

  // Reset cached MCP clients so each test gets a fresh client
  // that picks up the latest globalThis callTool hooks
  if (resetGmailClient) resetGmailClient();
  if (resetOutlookClient) resetOutlookClient();

  setGmailCallTool(async () => ({ content: [] }));
  setOutlookCallTool(async () => ({ content: [] }));

  mockChannel = {
    _notifications: [],
    async notification(msg: any) { this._notifications.push(msg); },
  };
});

afterEach(() => {
  try { db.close(); } catch {}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mcpTextResult(data: any) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function mcpRawTextResult(text: string) {
  return { content: [{ type: "text", text }] };
}

// =========================================================================
// pollGmail
// =========================================================================

describe("pollGmail integration", () => {
  test("detects new email via rich search results", async () => {
    const searchResponse = [
      { id: "msg-gmail-001", subject: "Invoice #1", from: "vendor@shop.com" },
    ];

    setGmailCallTool(async ({ name }: any) => {
      if (name === "search_gmail_messages") return mcpTextResult(searchResponse);
      return { content: [] };
    });

    const result = await pollGmail(db, "after:1234567890");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg-gmail-001");
    expect(result[0].source).toBe("gmail");
    expect(result[0].sender).toBe("vendor@shop.com");
    expect(result[0].subject).toBe("Invoice #1");
  });

  test("fetches individual messages when search returns IDs only", async () => {
    const searchResponse = { messages: [{ id: "msg-gmail-002" }] };

    const contentText = [
      "Subject: Invoice #2",
      "From: Alice <alice@example.com>",
      "To: Bob <bob@example.com>",
      "Date: Mon, 1 Mar 2026 10:00:00 +0000",
      "",
      "--- BODY ---",
      "Your invoice is attached.",
      "---",
      "",
      "--- ATTACHMENTS ---",
      "invoice.pdf (application/pdf, 12345 bytes)",
    ].join("\n");

    setGmailCallTool(async ({ name }: any) => {
      if (name === "search_gmail_messages") return mcpTextResult(searchResponse);
      if (name === "get_gmail_message_content") return mcpRawTextResult(contentText);
      return { content: [] };
    });

    const result = await pollGmail(db, "after:1234567890");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg-gmail-002");
    expect(result[0].sender).toBe("alice@example.com");
    expect(result[0].to).toBe("bob@example.com");
    expect(result[0].subject).toBe("Invoice #2");
    expect(result[0].hasAttachments).toBe(true);
    expect(result[0].preview).toBe("Your invoice is attached.");
    expect(result[0].receivedAt).toBe("Mon, 1 Mar 2026 10:00:00 +0000");
  });

  test("skips already-seen emails (emailExists check)", async () => {
    insertEmailMock(db, {
      id: "msg-gmail-003", source: "gmail",
      sender: "old@example.com", subject: "Old", status: "new",
    });

    const searchResponse = {
      messages: [{ id: "msg-gmail-003" }, { id: "msg-gmail-004" }],
    };

    const fetchedIds: string[] = [];
    setGmailCallTool(async ({ name, arguments: args }: any) => {
      if (name === "search_gmail_messages") return mcpTextResult(searchResponse);
      if (name === "get_gmail_message_content") {
        fetchedIds.push(args.message_id);
        return mcpRawTextResult("Subject: New Email\nFrom: new@example.com\nDate: Tue, 2 Mar 2026\n");
      }
      return { content: [] };
    });

    const result = await pollGmail(db, "after:1234567890");
    expect(fetchedIds).toEqual(["msg-gmail-004"]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg-gmail-004");
  });

  test("returns null on MCP error (not empty array)", async () => {
    setGmailCallTool(async () => { throw new Error("Connection refused"); });
    const result = await pollGmail(db, "after:1234567890");
    expect(result).toBeNull();
  });

  test("returns empty when search has no data", async () => {
    setGmailCallTool(async () => ({ content: [] }));
    const result = await pollGmail(db, "");
    expect(result).toEqual([]);
  });

  test("returns empty when search finds no IDs", async () => {
    setGmailCallTool(async ({ name }: any) => {
      if (name === "search_gmail_messages") return mcpTextResult({ messages: [] });
      return { content: [] };
    });
    const result = await pollGmail(db, "after:1234567890");
    expect(result).toEqual([]);
  });
});

// =========================================================================
// pollOutlook
// =========================================================================

describe("pollOutlook integration", () => {
  test("detects new email and returns EmailInfo", async () => {
    const outlookResponse = [{
      id: "msg-outlook-001", sender: "shop@outlook.com", to: "me@outlook.com",
      subject: "Your Order", preview: "Thank you for your order",
      has_attachments: true, received_at: "2026-03-25T14:00:00Z",
    }];

    setOutlookCallTool(async () => mcpTextResult(outlookResponse));

    const result = await pollOutlook(db, "2026-03-20T00:00:00Z");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "msg-outlook-001", source: "outlook",
      sender: "shop@outlook.com", to: "me@outlook.com",
      subject: "Your Order", preview: "Thank you for your order",
      hasAttachments: true, receivedAt: "2026-03-25T14:00:00Z",
    });
  });

  test("wraps single email object into array", async () => {
    setOutlookCallTool(async () => mcpTextResult({
      id: "msg-outlook-002", sender: "single@outlook.com",
      subject: "Single", has_attachments: false, received_at: "2026-03-25T15:00:00Z",
    }));

    const result = await pollOutlook(db, null);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg-outlook-002");
    expect(result[0].source).toBe("outlook");
  });

  test("returns null on MCP error (not empty array)", async () => {
    setOutlookCallTool(async () => { throw new Error("Auth expired"); });
    const result = await pollOutlook(db, "2026-03-20T00:00:00Z");
    expect(result).toBeNull();
  });

  test("returns empty when no data", async () => {
    setOutlookCallTool(async () => ({ content: [] }));
    const result = await pollOutlook(db, null);
    expect(result).toEqual([]);
  });

  test("passes received_after when provided", async () => {
    let captured: any;
    setOutlookCallTool(async ({ arguments: args }: any) => {
      captured = args;
      return mcpTextResult([]);
    });

    await pollOutlook(db, "2026-03-20T00:00:00Z");
    expect(captured.received_after).toBe("2026-03-20T00:00:00Z");
    expect(captured.top).toBe(50);
  });

  test("omits received_after when null", async () => {
    let captured: any;
    setOutlookCallTool(async ({ arguments: args }: any) => {
      captured = args;
      return mcpTextResult([]);
    });

    await pollOutlook(db, null);
    expect(captured.top).toBe(50);
    expect(captured.received_after).toBeUndefined();
  });
});

// =========================================================================
// processNewEmails
// =========================================================================

describe("processNewEmails integration", () => {
  test("inserts emails into DB and pushes channel notifications", async () => {
    const emails = [{
      id: "proc-001", source: "gmail" as const,
      sender: "invoice@vendor.com", subject: "Invoice #999",
      preview: "Your invoice is attached.",
      hasAttachments: true, receivedAt: "2026-03-25T10:00:00Z",
    }];

    setGmailCallTool(async ({ name }: any) => {
      if (name === "get_gmail_message_content")
        return mcpRawTextResult("<html><body>No links here</body></html>");
      return { content: [] };
    });

    await processNewEmails(db, mockChannel, emails);

    expect(emailExistsMock(db, "proc-001")).toBe(true);
    const rows = getRecentEmailsMock(db, { status: "new" });
    const row = rows.find((r: any) => r.id === "proc-001");
    expect(row).toBeTruthy();
    expect(row.source).toBe("gmail");
    expect(row.sender).toBe("invoice@vendor.com");
    expect(row.subject).toBe("Invoice #999");
    expect(row.has_attachments).toBe(1);
    expect(row.status).toBe("new");

    expect(mockChannel._notifications).toHaveLength(1);
    const notif = mockChannel._notifications[0];
    expect(notif.method).toBe("notifications/claude/channel");
    expect(notif.params.meta.email_source).toBe("gmail");
    expect(notif.params.meta.message_id).toBe("proc-001");
    expect(notif.params.meta.sender).toBe("invoice@vendor.com");
    expect(notif.params.meta.subject).toBe("Invoice #999");
    expect(notif.params.content).toContain("New email detected:");
    expect(notif.params.content).toContain("From: invoice@vendor.com");
  });

  test("handles duplicate gracefully (INSERT OR IGNORE)", async () => {
    insertEmailMock(db, {
      id: "proc-002", source: "outlook",
      sender: "dup@example.com", subject: "Duplicate", status: "new",
    });

    await processNewEmails(db, mockChannel, [{
      id: "proc-002", source: "outlook" as const,
      sender: "dup@example.com", subject: "Duplicate (retry)",
    }]);

    const rows = db.query("SELECT * FROM emails WHERE id = ?").all("proc-002") as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe("Duplicate");
    expect(mockChannel._notifications).toHaveLength(1);
  });

  test("does nothing for empty email list", async () => {
    await processNewEmails(db, mockChannel, []);
    expect(mockChannel._notifications).toHaveLength(0);
  });

  test("caps to MAX_NEW_PER_CYCLE (5)", async () => {
    const emails = Array.from({ length: 8 }, (_, i) => ({
      id: `cap-${i}`, source: "outlook" as const,
      sender: `s${i}@example.com`, subject: `Email ${i}`,
    }));

    await processNewEmails(db, mockChannel, emails);

    expect(mockChannel._notifications).toHaveLength(5);
    for (let i = 0; i < 5; i++) expect(emailExistsMock(db, `cap-${i}`)).toBe(true);
    for (let i = 5; i < 8; i++) expect(emailExistsMock(db, `cap-${i}`)).toBe(false);
  });

  test("includes invoice_links in notification meta", async () => {
    setGmailCallTool(async () => mcpRawTextResult("<html><body>hi</body></html>"));

    await processNewEmails(db, mockChannel, [{
      id: "proc-links-001", source: "gmail" as const,
      sender: "noreply@alza.sk", subject: "Invoice",
      invoiceLinks: [{ url: "https://alza.sk/invoice/123", text: "Download" }],
    }]);

    const notif = mockChannel._notifications[0];
    expect(notif.params.meta.invoice_links).toBeTruthy();
    const links = JSON.parse(notif.params.meta.invoice_links);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://alza.sk/invoice/123");
    expect(notif.params.content).toContain("Invoice links:");
  });

  test("sets correct meta for outlook emails (no HTML fetch)", async () => {
    await processNewEmails(db, mockChannel, [{
      id: "proc-outlook-001", source: "outlook" as const,
      sender: "info@company.com", to: "me@outlook.com",
      subject: "Monthly Report", hasAttachments: false,
      receivedAt: "2026-03-25T16:00:00Z",
    }]);

    const notif = mockChannel._notifications[0];
    expect(notif.params.meta.email_source).toBe("outlook");
    expect(notif.params.meta.has_attachments).toBe("false");
    expect(notif.params.meta.received_at).toBe("2026-03-25T16:00:00Z");
    expect(notif.params.content).toContain("Has attachments: no");
  });
});

// =========================================================================
// Full flow: poll -> detect -> process
// =========================================================================

describe("full poll->detect->process flow", () => {
  test("Gmail: poll detects, process inserts and notifies", async () => {
    setLastCheckedMock(db, "gmail", "2026-03-20T00:00:00Z");

    setGmailCallTool(async ({ name }: any) => {
      if (name === "search_gmail_messages")
        return mcpTextResult([{
          id: "flow-gmail-001", from: "flow@example.com",
          subject: "Flow Test", snippet: "Full flow",
          hasAttachments: true, date: "2026-03-25T10:00:00Z",
        }]);
      if (name === "get_gmail_message_content")
        return mcpRawTextResult("<html>no links</html>");
      return { content: [] };
    });

    const emails = await pollGmail(db, "after:1711929600");
    expect(emails).toHaveLength(1);

    await processNewEmails(db, mockChannel, emails);

    expect(emailExistsMock(db, "flow-gmail-001")).toBe(true);
    expect(mockChannel._notifications).toHaveLength(1);
    expect(mockChannel._notifications[0].params.meta.message_id).toBe("flow-gmail-001");

    // Poll again — same email in DB, dedup should filter it out.
    const emails2 = await pollGmail(db, "after:1711929600");
    const newOnly = emails2.filter((e: any) => !emailExistsMock(db, e.id));
    expect(newOnly).toHaveLength(0);
  });

  test("Outlook: poll detects, process inserts and notifies", async () => {
    setOutlookCallTool(async () => mcpTextResult([{
      id: "flow-outlook-001", sender: "flow-outlook@example.com",
      subject: "Outlook Flow", preview: "Full flow",
      has_attachments: false, received_at: "2026-03-25T14:00:00Z",
    }]));

    const emails = await pollOutlook(db, "2026-03-20T00:00:00Z");
    expect(emails).toHaveLength(1);

    await processNewEmails(db, mockChannel, emails);

    expect(emailExistsMock(db, "flow-outlook-001")).toBe(true);
    const rows = getRecentEmailsMock(db, {});
    const row = rows.find((r: any) => r.id === "flow-outlook-001");
    expect(row).toBeTruthy();
    expect(row.source).toBe("outlook");
    expect(row.status).toBe("new");

    expect(mockChannel._notifications).toHaveLength(1);
    expect(mockChannel._notifications[0].params.meta.email_source).toBe("outlook");
  });

  test("mixed sources: Gmail and Outlook in sequence", async () => {
    setGmailCallTool(async ({ name }: any) => {
      if (name === "search_gmail_messages")
        return mcpTextResult([{ id: "mixed-gmail-001", from: "gmail@test.com", subject: "Gmail Mixed" }]);
      if (name === "get_gmail_message_content")
        return mcpRawTextResult("<html>no links</html>");
      return { content: [] };
    });

    setOutlookCallTool(async () => mcpTextResult([{
      id: "mixed-outlook-001", sender: "outlook@test.com",
      subject: "Outlook Mixed", has_attachments: true,
      received_at: "2026-03-25T15:00:00Z",
    }]));

    const gmailEmails = await pollGmail(db, "");
    const outlookEmails = await pollOutlook(db, null);
    expect(gmailEmails).toHaveLength(1);
    expect(outlookEmails).toHaveLength(1);

    await processNewEmails(db, mockChannel, gmailEmails);
    await processNewEmails(db, mockChannel, outlookEmails);

    expect(emailExistsMock(db, "mixed-gmail-001")).toBe(true);
    expect(emailExistsMock(db, "mixed-outlook-001")).toBe(true);
    expect(mockChannel._notifications).toHaveLength(2);

    const sources = mockChannel._notifications.map((n: any) => n.params.meta.email_source);
    expect(sources).toContain("gmail");
    expect(sources).toContain("outlook");
  });
});
