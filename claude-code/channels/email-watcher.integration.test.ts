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
// MCP Client mock — uses globalThis so it works regardless of which test
// file's mock.module call "wins" (bun uses the first registered mock).
// ---------------------------------------------------------------------------

type CallToolFn = (args: { name: string; arguments: any }) => Promise<any>;

const G = globalThis as any;
G.__ewIntegGmailCallTool = async () => ({ content: [] });
G.__ewIntegOutlookCallTool = async () => ({ content: [] });

function setGmailCallTool(fn: CallToolFn) { G.__ewIntegGmailCallTool = fn; }
function setOutlookCallTool(fn: CallToolFn) { G.__ewIntegOutlookCallTool = fn; }

// MCP SDK mocks are handled by test-preload.ts (bunfig.toml preload).
// The preload's Client mock delegates to globalThis.__ewIntegGmailCallTool
// and globalThis.__ewIntegOutlookCallTool hooks for per-test control.

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

import { openDb, emailExists } from "./db";
import { openWorkflowDb, getJobByIdempotencyKey } from "./workflow-db";

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
let wfDb: ReturnType<typeof openWorkflowDb>;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ew-integ-"));
  db = openDb(join(tmpDir, "email.db"));
  wfDb = openWorkflowDb(join(tmpDir, "workflow.db"));

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
  try { wfDb.close(); } catch {}
  try { rmSync(tmpDir, { recursive: true }); } catch {}
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
    expect(result![0].id).toBe("msg-gmail-001");
    expect(result![0].source).toBe("gmail");
    expect(result![0].sender).toBe("vendor@shop.com");
    expect(result![0].subject).toBe("Invoice #1");
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
      "1. report.pdf (application/pdf, 1024 KB)",
      "   Attachment ID: att-001",
    ].join("\n");

    setGmailCallTool(async ({ name }: any) => {
      if (name === "search_gmail_messages") return mcpTextResult(searchResponse);
      if (name === "get_gmail_message_content") return mcpRawTextResult(contentText);
      return { content: [] };
    });

    const result = await pollGmail(db, "after:1234567890");
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe("msg-gmail-002");
    expect(result![0].subject).toBe("Invoice #2");
    expect(result![0].sender).toBe("alice@example.com");
    expect(result![0].hasAttachments).toBe(true);
  });

  test("deduplicates against existing emails in DB", async () => {
    // Pre-insert an email
    db.prepare("INSERT INTO emails (id, source, status) VALUES (?, ?, ?)").run("msg-gmail-dup", "gmail", "processed");

    // Use sparse format (IDs only) — rich format takes a shortcut that skips DB dedup
    const searchResponse = { messages: [{ id: "msg-gmail-dup" }, { id: "msg-gmail-new" }] };

    const contentText = [
      "Subject: New Email",
      "From: New <new@example.com>",
      "Date: Mon, 1 Mar 2026 10:00:00 +0000",
      "",
      "--- BODY ---",
      "Body",
      "---",
    ].join("\n");

    setGmailCallTool(async ({ name, arguments: args }: any) => {
      if (name === "search_gmail_messages") return mcpTextResult(searchResponse);
      if (name === "get_gmail_message_content") return mcpRawTextResult(contentText);
      return { content: [] };
    });

    const result = await pollGmail(db, "after:1234567890");
    // Only the new one — dup was filtered out by emailExists check
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe("msg-gmail-new");
  });

  test("returns null on MCP error", async () => {
    setGmailCallTool(async () => { throw new Error("MCP connection lost"); });

    const result = await pollGmail(db, "after:1234567890");
    expect(result).toBeNull();
  });

  test("returns empty array when no emails found", async () => {
    setGmailCallTool(async ({ name }: any) => {
      if (name === "search_gmail_messages") return { content: [{ type: "text", text: "" }] };
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
  test("detects new emails from Outlook", async () => {
    const emailData = [
      { id: "msg-outlook-001", sender: "vendor@corp.com", subject: "Receipt", has_attachments: true, received_at: "2026-03-01T10:00:00Z" },
    ];

    setOutlookCallTool(async ({ name }: any) => {
      if (name === "list_emails") return mcpTextResult(emailData);
      return { content: [] };
    });

    const result = await pollOutlook(db, "2026-03-01T00:00:00Z");
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe("msg-outlook-001");
    expect(result![0].source).toBe("outlook");
    expect(result![0].sender).toBe("vendor@corp.com");
    expect(result![0].hasAttachments).toBe(true);
  });

  test("handles single-object response (wraps in array)", async () => {
    const singleEmail = { id: "msg-outlook-single", sender: "a@b.com", subject: "One" };

    setOutlookCallTool(async ({ name }: any) => {
      if (name === "list_emails") return mcpTextResult(singleEmail);
      return { content: [] };
    });

    const result = await pollOutlook(db, null);
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe("msg-outlook-single");
  });

  test("returns null on MCP error", async () => {
    setOutlookCallTool(async () => { throw new Error("Auth expired"); });

    const result = await pollOutlook(db, null);
    expect(result).toBeNull();
  });

  test("passes pagination args correctly", async () => {
    let capturedArgs: any;
    setOutlookCallTool(async (args: any) => {
      capturedArgs = args;
      return mcpTextResult([]);
    });

    await pollOutlook(db, "2026-03-15T12:00:00Z");
    expect(capturedArgs.arguments.top).toBe(50);
    expect(capturedArgs.arguments.received_after).toBe("2026-03-15T12:00:00Z");
  });
});

// =========================================================================
// processNewEmails — direct job creation
// =========================================================================

describe("processNewEmails", () => {
  test("creates invoice_intake job in workflow DB", async () => {
    const emails = [{
      id: "proc-001",
      source: "gmail",
      sender: "vendor@shop.com",
      subject: "Invoice 123",
      preview: "Please find attached...",
      hasAttachments: true,
      receivedAt: "2026-04-04T10:00:00Z",
    }];

    await processNewEmails(db, mockChannel as any, emails, wfDb);

    // Email in audit DB
    expect(emailExists(db, "proc-001")).toBe(true);

    // Job in workflow DB
    const job = getJobByIdempotencyKey(wfDb, "gmail:proc-001");
    expect(job).not.toBeNull();
    expect(job!.workflow_type).toBe("invoice_intake");
    expect(job!.state).toBe("queued");
    expect(job!.source_ref).toBe("gmail:proc-001");

    const input = JSON.parse(job!.input_json!);
    expect(input.email_source).toBe("gmail");
    expect(input.message_id).toBe("proc-001");

    // No channel notifications
    expect(mockChannel._notifications).toHaveLength(0);
  });

  test("caps at MAX_NEW_PER_CYCLE", async () => {
    const emails = Array.from({ length: 10 }, (_, i) => ({
      id: `cap-${i}`,
      source: "outlook" as const,
      sender: `s${i}@example.com`,
      subject: `Email ${i}`,
      hasAttachments: false,
    }));

    await processNewEmails(db, mockChannel as any, emails, wfDb);

    // Default MAX_NEW_PER_CYCLE is 5
    const allJobs = wfDb.prepare("SELECT COUNT(*) as cnt FROM jobs").get() as { cnt: number };
    expect(allJobs.cnt).toBe(5);
  });

  test("idempotent — same email creates one job", async () => {
    const emails = [{
      id: "idemp-001",
      source: "gmail",
      sender: "a@b.com",
      subject: "Test",
      hasAttachments: false,
    }];

    await processNewEmails(db, mockChannel as any, emails, wfDb);
    const job1 = getJobByIdempotencyKey(wfDb, "gmail:idemp-001");

    // Second call — email already in DB, but createJob is idempotent
    await processNewEmails(db, mockChannel as any, emails, wfDb);
    const job2 = getJobByIdempotencyKey(wfDb, "gmail:idemp-001");

    expect(job2!.id).toBe(job1!.id);
  });

  test("persists invoiceLinks when present", async () => {
    const emails = [{
      id: "proc-links-001",
      source: "gmail",
      sender: "alza@alza.sk",
      subject: "Vaša faktúra",
      hasAttachments: false,
      invoiceLinks: [{ url: "https://alza.sk/pdfdoc.asp?id=123", text: "Stiahnuť faktúru" }],
    }];

    await processNewEmails(db, mockChannel as any, emails, wfDb);

    const row = db.prepare("SELECT invoice_links FROM emails WHERE id = ?").get("proc-links-001") as { invoice_links: string | null };
    expect(row.invoice_links).toBeTruthy();
    const links = JSON.parse(row.invoice_links!);
    expect(links[0].url).toContain("pdfdoc.asp");
  });

  test("handles outlook source correctly", async () => {
    const emails = [{
      id: "proc-outlook-001",
      source: "outlook",
      sender: "vendor@corp.com",
      subject: "Receipt",
      hasAttachments: true,
      receivedAt: "2026-04-04T12:00:00Z",
    }];

    await processNewEmails(db, mockChannel as any, emails, wfDb);

    const job = getJobByIdempotencyKey(wfDb, "outlook:proc-outlook-001");
    expect(job).not.toBeNull();
    expect(job!.source_ref).toBe("outlook:proc-outlook-001");

    const input = JSON.parse(job!.input_json!);
    expect(input.email_source).toBe("outlook");
  });
});

// =========================================================================
// Full flow — poll → processNewEmails → verify
// =========================================================================

describe("full flow", () => {
  test("Gmail poll → processNewEmails → email in DB + job created", async () => {
    setGmailCallTool(async ({ name }: any) => {
      if (name === "search_gmail_messages")
        return mcpTextResult([{ id: "flow-gmail-001", subject: "Flow test", from: "flow@test.com" }]);
      return { content: [] };
    });

    const polled = await pollGmail(db, "after:1234567890");
    expect(polled).toHaveLength(1);

    await processNewEmails(db, mockChannel as any, polled!, wfDb);

    expect(emailExists(db, "flow-gmail-001")).toBe(true);
    const job = getJobByIdempotencyKey(wfDb, "gmail:flow-gmail-001");
    expect(job).not.toBeNull();
    expect(job!.workflow_type).toBe("invoice_intake");
    expect(mockChannel._notifications).toHaveLength(0);
  });

  test("Outlook poll → processNewEmails → email in DB + job created", async () => {
    setOutlookCallTool(async ({ name }: any) => {
      if (name === "list_emails")
        return mcpTextResult([{ id: "flow-outlook-001", sender: "corp@test.com", subject: "OL test" }]);
      return { content: [] };
    });

    const polled = await pollOutlook(db, null);
    expect(polled).toHaveLength(1);

    await processNewEmails(db, mockChannel as any, polled!, wfDb);

    expect(emailExists(db, "flow-outlook-001")).toBe(true);
    const job = getJobByIdempotencyKey(wfDb, "outlook:flow-outlook-001");
    expect(job).not.toBeNull();
  });

  test("mixed sources create separate jobs", async () => {
    setGmailCallTool(async ({ name }: any) => {
      if (name === "search_gmail_messages")
        return mcpTextResult([{ id: "mixed-gmail-001", subject: "Gmail", from: "g@test.com" }]);
      return { content: [] };
    });
    setOutlookCallTool(async ({ name }: any) => {
      if (name === "list_emails")
        return mcpTextResult([{ id: "mixed-outlook-001", sender: "o@test.com", subject: "Outlook" }]);
      return { content: [] };
    });

    const gmail = await pollGmail(db, "after:1234567890");
    const outlook = await pollOutlook(db, null);

    await processNewEmails(db, mockChannel as any, gmail!, wfDb);
    await processNewEmails(db, mockChannel as any, outlook!, wfDb);

    const gJob = getJobByIdempotencyKey(wfDb, "gmail:mixed-gmail-001");
    const oJob = getJobByIdempotencyKey(wfDb, "outlook:mixed-outlook-001");
    expect(gJob).not.toBeNull();
    expect(oJob).not.toBeNull();
    expect(gJob!.id).not.toBe(oJob!.id);
  });
});
