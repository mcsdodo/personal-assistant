import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Env vars — MUST be set before the email-poller module is imported so
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
process.env.MAX_CATCHUP_EMAILS = "200";
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

import { openDb as openEmailDb, emailExists, setLastChecked } from "../../lib/email-db";
import { openWorkflowDb, getJobByIdempotencyKey } from "../../lib/workflow-db";

let pollGmail: any;
let pollOutlook: any;
let processNewEmails: any;
let resetGmailClient: any;
let resetOutlookClient: any;
let pollCycle: any;

beforeAll(async () => {
  const mod = await import("./main");
  pollGmail = mod.pollGmail;
  pollOutlook = mod.pollOutlook;
  processNewEmails = mod.processNewEmails;
  resetGmailClient = mod.resetGmailClient;
  resetOutlookClient = mod.resetOutlookClient;
  pollCycle = mod.pollCycle;
});

const MAX_NEW_PER_CYCLE = parseInt(process.env.MAX_NEW_PER_CYCLE ?? "5", 10);

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

let db: ReturnType<typeof openEmailDb>;
let wfDb: ReturnType<typeof openWorkflowDb>;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ew-integ-"));
  db = openEmailDb(join(tmpDir, "email.db"));
  wfDb = openWorkflowDb(join(tmpDir, "workflow.db"));

  if (resetGmailClient) resetGmailClient();
  if (resetOutlookClient) resetOutlookClient();

  setGmailCallTool(async () => ({ content: [] }));
  setOutlookCallTool(async () => ({ content: [] }));
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
    db.prepare("INSERT INTO emails (id, source) VALUES (?, ?)").run("msg-gmail-dup", "gmail");

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

    setGmailCallTool(async ({ name }: any) => {
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

  test("logs full-page guard when search returns exactly GMAIL_PAGE_SIZE (200) results", async () => {
    // Build 200 distinct rich-format results (subject present → hasMetadata=true → no per-ID fetch)
    const searchResponse = Array.from({ length: 200 }, (_, i) => ({
      id: `fullpage-${i.toString().padStart(3, "0")}`,
      subject: `Email ${i}`,
      from: `sender${i}@example.com`,
    }));

    setGmailCallTool(async ({ name }: any) => {
      if (name === "search_gmail_messages") return mcpTextResult(searchResponse);
      return { content: [] };
    });

    const logLines: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: any[]) => { logLines.push(args.join(" ")); };
    try {
      await pollGmail(db, "after:1234567890");
    } finally {
      console.error = origConsoleError;
    }

    const guardLog = logLines.find((l) => l.includes("Gmail email page came back full"));
    expect(guardLog).toBeDefined();
  });

  test("does NOT log full-page guard when search returns fewer than 200 results", async () => {
    const searchResponse = Array.from({ length: 50 }, (_, i) => ({
      id: `partial-${i.toString().padStart(3, "0")}`,
      subject: `Email ${i}`,
      from: `sender${i}@example.com`,
    }));

    setGmailCallTool(async ({ name }: any) => {
      if (name === "search_gmail_messages") return mcpTextResult(searchResponse);
      return { content: [] };
    });

    const logLines: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: any[]) => { logLines.push(args.join(" ")); };
    try {
      await pollGmail(db, "after:1234567890");
    } finally {
      console.error = origConsoleError;
    }

    const guardLog = logLines.find((l) => l.includes("Gmail email page came back full"));
    expect(guardLog).toBeUndefined();
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
    expect(capturedArgs.arguments.top).toBe(200);
    expect(capturedArgs.arguments.received_after).toBe("2026-03-15T12:00:00Z");
  });

  test("logs full-page guard when list_emails returns exactly OUTLOOK_PAGE_SIZE (200) results", async () => {
    // Build 200 distinct outlook emails
    const emailData = Array.from({ length: 200 }, (_, i) => ({
      id: `outlook-fullpage-${i.toString().padStart(3, "0")}`,
      sender: `sender${i}@corp.com`,
      subject: `Email ${i}`,
      has_attachments: false,
      received_at: "2026-03-01T10:00:00Z",
    }));

    setOutlookCallTool(async ({ name }: any) => {
      if (name === "list_emails") return mcpTextResult(emailData);
      return { content: [] };
    });

    const logLines: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: any[]) => { logLines.push(args.join(" ")); };
    try {
      await pollOutlook(db, "2026-03-01T00:00:00Z");
    } finally {
      console.error = origConsoleError;
    }

    const guardLog = logLines.find((l) => l.includes("Outlook email page came back full"));
    expect(guardLog).toBeDefined();
  });

  test("does NOT log full-page guard when list_emails returns fewer than 200 results", async () => {
    const emailData = [
      { id: "msg-outlook-small-001", sender: "a@corp.com", subject: "One", has_attachments: false, received_at: "2026-03-01T10:00:00Z" },
    ];

    setOutlookCallTool(async ({ name }: any) => {
      if (name === "list_emails") return mcpTextResult(emailData);
      return { content: [] };
    });

    const logLines: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: any[]) => { logLines.push(args.join(" ")); };
    try {
      await pollOutlook(db, "2026-03-01T00:00:00Z");
    } finally {
      console.error = origConsoleError;
    }

    const guardLog = logLines.find((l) => l.includes("Outlook email page came back full"));
    expect(guardLog).toBeUndefined();
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

    await processNewEmails(db, wfDb, emails, MAX_NEW_PER_CYCLE);

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
  });

  test("each email gets its own root span (per-file trace topology)", async () => {
    // Before task 48 Issue 3, every job created in the same poll cycle
    // inherited the poll span's trace_id, making multi-file incidents hard
    // to debug in Tempo. After the fix, each email starts its own `root: true`
    // span so each job has a distinct trace.
    //
    // We can't rely on real OTel trace_ids here because bun + the OTel SDK's
    // ProxyTracer interaction prevents `BasicTracerProvider.register()` from
    // replacing the cached no-op tracer that `getTracer()` captured at module
    // load time. Instead we assert the CODE STRUCTURE: `startActiveSpan` is
    // invoked once per email with `root: true`. Full trace_id distinctness is
    // verified manually in production (see task 48, Issue 3).
    const { getTracer } = await import("../../lib/tracing");
    const realTracer = getTracer("email-poller");
    const spanCalls: Array<{ name: string; options: any }> = [];
    const origStartActiveSpan = realTracer.startActiveSpan.bind(realTracer);
    (realTracer as any).startActiveSpan = function (
      name: string,
      optionsOrFn: any,
      ctxOrFn?: any,
      fn?: any,
    ) {
      if (name === "email-poller.process_email") {
        spanCalls.push({ name, options: optionsOrFn });
      }
      return origStartActiveSpan(name, optionsOrFn, ctxOrFn, fn);
    };

    try {
      const emails = [
        { id: "trace-1", source: "gmail" as const, sender: "a@x.com", subject: "Invoice 1", hasAttachments: true },
        { id: "trace-2", source: "gmail" as const, sender: "b@y.com", subject: "Invoice 2", hasAttachments: true },
        { id: "trace-3", source: "outlook" as const, sender: "c@z.com", subject: "Invoice 3", hasAttachments: true },
      ];

      await processNewEmails(db, wfDb, emails, MAX_NEW_PER_CYCLE);

      // One span per email, all marked as root
      expect(spanCalls).toHaveLength(3);
      for (const call of spanCalls) {
        expect(call.options.root).toBe(true);
      }
      // And attributes carry identifying info so traces are self-describing
      expect(spanCalls[0].options.attributes["email.message_id"]).toBe("trace-1");
      expect(spanCalls[1].options.attributes["email.message_id"]).toBe("trace-2");
      expect(spanCalls[2].options.attributes["email.message_id"]).toBe("trace-3");

      // Sanity: three jobs got created
      const jobs = wfDb.prepare(
        "SELECT id FROM jobs WHERE source_ref IN ('gmail:trace-1','gmail:trace-2','outlook:trace-3')",
      ).all();
      expect(jobs).toHaveLength(3);
    } finally {
      (realTracer as any).startActiveSpan = origStartActiveSpan;
    }
  });

  test("caps at MAX_NEW_PER_CYCLE", async () => {
    const emails = Array.from({ length: 10 }, (_, i) => ({
      id: `cap-${i}`,
      source: "outlook" as const,
      sender: `s${i}@example.com`,
      subject: `Email ${i}`,
      hasAttachments: false,
    }));

    await processNewEmails(db, wfDb, emails, MAX_NEW_PER_CYCLE);

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

    await processNewEmails(db, wfDb, emails, MAX_NEW_PER_CYCLE);
    const job1 = getJobByIdempotencyKey(wfDb, "gmail:idemp-001");

    // Second call — email already in DB, but createJob is idempotent
    await processNewEmails(db, wfDb, emails, MAX_NEW_PER_CYCLE);
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

    await processNewEmails(db, wfDb, emails, MAX_NEW_PER_CYCLE);

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

    await processNewEmails(db, wfDb, emails, MAX_NEW_PER_CYCLE);

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

    await processNewEmails(db, wfDb, polled!, MAX_NEW_PER_CYCLE);

    expect(emailExists(db, "flow-gmail-001")).toBe(true);
    const job = getJobByIdempotencyKey(wfDb, "gmail:flow-gmail-001");
    expect(job).not.toBeNull();
    expect(job!.workflow_type).toBe("invoice_intake");
  });

  test("Outlook poll → processNewEmails → email in DB + job created", async () => {
    setOutlookCallTool(async ({ name }: any) => {
      if (name === "list_emails")
        return mcpTextResult([{ id: "flow-outlook-001", sender: "corp@test.com", subject: "OL test" }]);
      return { content: [] };
    });

    const polled = await pollOutlook(db, null);
    expect(polled).toHaveLength(1);

    await processNewEmails(db, wfDb, polled!, MAX_NEW_PER_CYCLE);

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

    await processNewEmails(db, wfDb, gmail!, MAX_NEW_PER_CYCLE);
    await processNewEmails(db, wfDb, outlook!, MAX_NEW_PER_CYCLE);

    const gJob = getJobByIdempotencyKey(wfDb, "gmail:mixed-gmail-001");
    const oJob = getJobByIdempotencyKey(wfDb, "outlook:mixed-outlook-001");
    expect(gJob).not.toBeNull();
    expect(oJob).not.toBeNull();
    expect(gJob!.id).not.toBe(oJob!.id);
  });
});

// =========================================================================
// D1 — Transient-miss / index-lag recovery (headline regression test)
// =========================================================================
//
// Proves an email missed on poll N (because Gmail's index lagged) is recovered
// on poll N+1 thanks to the overlap window — and that it would be LOST without it.
//
// Coupling note: M is received 5 min ago; the default POLL_OVERLAP is 10 min.
// M's age (5 min) must stay comfortably inside the overlap window (10 min).
// A future dev lowering the default POLL_OVERLAP below 5 min would break this
// test — that is intended: the test is the regression guard.

describe("pollCycle: D1 — transient-miss / index-lag recovery", () => {
  test("email missed on poll-1 due to index lag is recovered on poll-2 via overlap window", async () => {
    // M: an email received 5 min ago — inside the 10-min overlap window.
    const M = {
      id: "d1-transient-miss-001",
      subject: "Invoice from vendor",
      from: "vendor@shop.com",
      receivedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    };
    const M_recv_epoch = Math.floor(Date.parse(M.receivedAt) / 1000);

    // Seed the cursor 20 min ago — older than M so poll-1's miss is attributable
    // to index lag, not to the `after:` filter excluding a too-old email.
    // If we seeded newer than M, the `after:` filter would exclude M on poll-1
    // and we'd be testing a different (non-index-lag) mechanism.
    setLastChecked(db, "gmail", new Date(Date.now() - 20 * 60 * 1000).toISOString());

    // Gmail mock: simulates server-side `after:<epoch>` filtering AND index lag.
    //
    // - callCount >= 2 simulates the Gmail index catching up between polls;
    //   on call 1 M has not yet been indexed, on call 2+ it has.
    // - M_recv_epoch >= afterEpoch simulates Gmail's server-side `after:` filter:
    //   only return M when its receive epoch is at or after the query's `after:` value.
    //
    // IMPORTANT: the mock MUST parse and honour `after:` — otherwise the test could
    // pass trivially (mock returns M regardless of cursor, so poll-2 always wins even
    // if the cursor was advanced to `now`).
    let callCount = 0;
    setGmailCallTool(async ({ name, arguments: args }: any) => {
      if (name === "search_gmail_messages") {
        callCount++;
        const indexed = callCount >= 2; // simulates index catching up between polls
        const afterMatch = (args.query as string).match(/after:(\d+)/);
        const afterEpoch = afterMatch ? parseInt(afterMatch[1], 10) : 0;
        // Return M only when indexed AND its receive time is within the query window
        if (indexed && M_recv_epoch >= afterEpoch) {
          return mcpTextResult([{ id: M.id, subject: M.subject, from: M.from, receivedAt: M.receivedAt }]);
        }
        return mcpTextResult([]);
      }
      return { content: [] };
    });
    // Outlook mock stays at default empty (set in beforeEach) — harmless.

    // Poll 1 finds nothing (M not yet indexed) but STILL advances the cursor to ~now−10min,
    // because processWithOverflowGuard.setLastChecked runs whenever newEmails.length <= maxPerCycle
    // (0 qualifies). That advance is what gives poll 2 its overlap window.
    await pollCycle(db, wfDb);

    // NON-NEGOTIABLE intermediate assertion: proves a real transient miss happened.
    // Without this check the test could pass trivially (e.g. mock ignoring `after:`).
    expect(emailExists(db, M.id)).toBe(false);

    // Poll 2: index has caught up (callCount >= 2); cursor is now ~10 min behind
    // (overlap window), so after:<epoch> <= M_recv_epoch → M is returned and ingested.
    await pollCycle(db, wfDb);

    expect(emailExists(db, M.id)).toBe(true);
    const job = getJobByIdempotencyKey(wfDb, `gmail:${M.id}`);
    expect(job).not.toBeNull();
    expect(job!.workflow_type).toBe("invoice_intake");
  });
});

// =========================================================================
// D2-via-integration — Overlap dedup
// =========================================================================
//
// Proves the overlap window re-surfacing an already-seen email does NOT
// double-ingest it. M is indexed from call 1 (always), so poll-1 ingests it;
// poll-2's overlap re-query returns it again, and emailExists dedup filters it.
//
// This is DIFFERENT from D1: here `indexed = true` always — there is no lag.
// The mock still honours `after:` so it only returns M when the cursor is old
// enough to include M's receive time.

describe("pollCycle: overlap dedup — re-surfaced email is not double-ingested", () => {
  test("email re-surfaced by overlap window on poll-2 is deduplicated (one row, one job)", async () => {
    // M: received 5 min ago — inside the 10-min overlap window.
    const M = {
      id: "d2-overlap-dedup-001",
      subject: "Duplicate invoice test",
      from: "vendor@dedup.com",
      receivedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    };
    const M_recv_epoch = Math.floor(Date.parse(M.receivedAt) / 1000);

    // Seed cursor older than M — same rationale as D1.
    setLastChecked(db, "gmail", new Date(Date.now() - 20 * 60 * 1000).toISOString());

    // Gmail mock: M is indexed from call 1 (no lag), still honours `after:`.
    // This is the key difference from D1: `const indexed = true` always —
    // poll-1 successfully returns and ingests M.
    // Track returnedOnPoll2 to confirm M really was re-surfaced on poll-2
    // (not just never returned again) — this makes the dedup assertion meaningful.
    let callCount = 0;
    let returnedOnPoll2 = false;
    setGmailCallTool(async ({ name, arguments: args }: any) => {
      if (name === "search_gmail_messages") {
        callCount++;
        const afterMatch = (args.query as string).match(/after:(\d+)/);
        const afterEpoch = afterMatch ? parseInt(afterMatch[1], 10) : 0;
        // D2: no index-lag — M is always returned when within the after: window (contrast D1's callCount>=2 lag)
        if (M_recv_epoch >= afterEpoch) {
          if (callCount >= 2) returnedOnPoll2 = true;
          return mcpTextResult([{ id: M.id, subject: M.subject, from: M.from, receivedAt: M.receivedAt }]);
        }
        return mcpTextResult([]);
      }
      return { content: [] };
    });

    // Poll 1: M ingested for the first time.
    await pollCycle(db, wfDb);
    expect(emailExists(db, M.id)).toBe(true);

    // Poll 2: cursor is now ~10 min behind (overlap); M_recv_epoch >= afterEpoch
    // still holds → M is re-returned by the mock. emailExists dedup must prevent re-insertion.
    await pollCycle(db, wfDb);

    // Confirm M was genuinely re-surfaced on poll 2 (the mock returned it again);
    // without this, a dedup-count-1 assertion could trivially pass if M was never re-returned.
    expect(returnedOnPoll2).toBe(true);

    // Exactly ONE emails row — no duplicate insert.
    const emailCount = (db
      .prepare("SELECT COUNT(*) as cnt FROM emails WHERE id = ?")
      .get(M.id) as { cnt: number }).cnt;
    expect(emailCount).toBe(1);

    // Exactly ONE job — idempotent createJob + emailExists dedup both guard this.
    const job = getJobByIdempotencyKey(wfDb, `gmail:${M.id}`);
    expect(job).not.toBeNull();
    const jobCount = (wfDb
      .prepare("SELECT COUNT(*) as cnt FROM jobs WHERE source_ref = ?")
      .get(`gmail:${M.id}`) as { cnt: number }).cnt;
    expect(jobCount).toBe(1);
  });
});
