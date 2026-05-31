import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb as openEmailDb, getLastChecked, setLastChecked } from "../../lib/email-db";
import { openWorkflowDb } from "../../lib/workflow-db";
import { seedFromInitialLookback, processWithOverflowGuard, processNewEmails, type EmailInfo } from "./main";

function tmpPath(prefix: string): string {
  return `/tmp/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("email-poller seedFromInitialLookback", () => {
  let db: Database;

  beforeEach(() => {
    db = openEmailDb(tmpPath("emails"));
  });

  it("seeds last_checked for an unseeded source from INITIAL_LOOKBACK", () => {
    const beforeMs = Date.now();
    seedFromInitialLookback(db, ["gmail", "outlook"], "3d");
    const seededGmail = getLastChecked(db, "gmail");
    const seededOutlook = getLastChecked(db, "outlook");
    expect(seededGmail).not.toBeNull();
    expect(seededOutlook).not.toBeNull();

    const seededMs = Date.parse(seededGmail!);
    const expected = beforeMs - 3 * 24 * 60 * 60 * 1000;
    // Allow 5s of slop for test runtime
    expect(seededMs).toBeGreaterThanOrEqual(expected - 5000);
    expect(seededMs).toBeLessThanOrEqual(expected + 5000);
  });

  it("does not overwrite an already-seeded source", () => {
    const oldTs = "2025-01-01T00:00:00.000Z";
    setLastChecked(db, "gmail", oldTs);
    seedFromInitialLookback(db, ["gmail"], "3d");
    expect(getLastChecked(db, "gmail")).toBe(oldTs);
  });
});

describe("email-poller processWithOverflowGuard", () => {
  let emailDb: Database;
  let wfDb: Database;

  beforeEach(() => {
    emailDb = openEmailDb(tmpPath("emails"));
    wfDb = openWorkflowDb(tmpPath("workflow"));
  });

  function emails(n: number): EmailInfo[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `gmail-${i}`,
      source: "gmail",
      sender: "vendor@example.com",
      subject: `Invoice ${i}`,
      hasAttachments: true,
      receivedAt: "2026-04-15T10:00:00.000Z",
    }));
  }

  it("processes emails normally below the cap and advances last_checked", async () => {
    const before = Date.now();
    const result = await processWithOverflowGuard(emailDb, wfDb, "gmail", emails(5), 200, 5);
    expect(result.overflow).toBe(false);
    expect(result.processed).toBe(5);
    expect(getLastChecked(emailDb, "gmail")).not.toBeNull();

    // Phase 1 invariant: cursor must land at now - POLL_OVERLAP (default 10min),
    // not at now. A regression that reverted to new Date().toISOString() would fail
    // this check because the cursor would be within milliseconds of `before`.
    const cursorMs = Date.parse(getLastChecked(emailDb, "gmail")!);
    // Must be at least ~9 min behind (slop for fast machines)
    expect(cursorMs).toBeLessThanOrEqual(before - 9 * 60 * 1000);
    // Must not be absurdly far behind (sanity: within 11 min)
    expect(cursorMs).toBeGreaterThan(before - 11 * 60 * 1000);
  });

  it("does NOT process or advance last_checked when emails exceed cap", async () => {
    const beforeRows = wfDb.prepare("SELECT COUNT(*) as n FROM jobs").get() as { n: number };
    const result = await processWithOverflowGuard(emailDb, wfDb, "gmail", emails(201), 200, 5);
    expect(result.overflow).toBe(true);
    expect(result.processed).toBe(0);
    expect(getLastChecked(emailDb, "gmail")).toBeNull();
    const afterRows = wfDb.prepare("SELECT COUNT(*) as n FROM jobs").get() as { n: number };
    expect(afterRows.n).toBe(beforeRows.n);
  });
});

describe("email-poller own-account reply filter", () => {
  let emailDb: Database;
  let wfDb: Database;

  beforeEach(() => {
    emailDb = openEmailDb(tmpPath("emails"));
    wfDb = openWorkflowDb(tmpPath("workflow"));
  });

  const OWN_EMAIL = "me@gmail.com";

  it("skips job creation for a Re: reply from the monitored account", async () => {
    const reply: EmailInfo = {
      id: "msg-reply-1",
      source: "gmail",
      sender: OWN_EMAIL,
      subject: "Re: faktúra za spracovanie účtovníctva",
      hasAttachments: false,
      receivedAt: "2026-05-04T10:51:54.000Z",
    };
    await processNewEmails(emailDb, wfDb, [reply], 5, OWN_EMAIL);
    const jobs = wfDb.prepare("SELECT COUNT(*) as n FROM jobs").get() as { n: number };
    expect(jobs.n).toBe(0);
  });

  it("still inserts the audit record even when skipping", async () => {
    const reply: EmailInfo = {
      id: "msg-reply-2",
      source: "gmail",
      sender: OWN_EMAIL,
      subject: "Re: invoice from vendor",
      hasAttachments: false,
      receivedAt: "2026-05-04T11:00:00.000Z",
    };
    await processNewEmails(emailDb, wfDb, [reply], 5, OWN_EMAIL);
    const emails = emailDb.prepare("SELECT COUNT(*) as n FROM emails").get() as { n: number };
    expect(emails.n).toBe(1);
  });

  it("does NOT skip a test email from the monitored account with a clean subject", async () => {
    const testInvoice: EmailInfo = {
      id: "msg-test-invoice",
      source: "gmail",
      sender: OWN_EMAIL,
      subject: "Faktúra 1000000001 - Alza.sk",
      hasAttachments: true,
      receivedAt: "2026-05-04T12:00:00.000Z",
    };
    await processNewEmails(emailDb, wfDb, [testInvoice], 5, OWN_EMAIL);
    const jobs = wfDb.prepare("SELECT COUNT(*) as n FROM jobs").get() as { n: number };
    expect(jobs.n).toBe(1);
  });

  it("does NOT skip a Re: from an external sender", async () => {
    const vendorReply: EmailInfo = {
      id: "msg-vendor-reply",
      source: "gmail",
      sender: "vendor@example.com",
      subject: "Re: your order",
      hasAttachments: true,
      receivedAt: "2026-05-04T13:00:00.000Z",
    };
    await processNewEmails(emailDb, wfDb, [vendorReply], 5, OWN_EMAIL);
    const jobs = wfDb.prepare("SELECT COUNT(*) as n FROM jobs").get() as { n: number };
    expect(jobs.n).toBe(1);
  });

  it("is case-insensitive on the sender email", async () => {
    const reply: EmailInfo = {
      id: "msg-reply-caps",
      source: "gmail",
      sender: "ME@GMAIL.COM",
      subject: "Re: some invoice",
      hasAttachments: false,
      receivedAt: "2026-05-04T14:00:00.000Z",
    };
    await processNewEmails(emailDb, wfDb, [reply], 5, OWN_EMAIL);
    const jobs = wfDb.prepare("SELECT COUNT(*) as n FROM jobs").get() as { n: number };
    expect(jobs.n).toBe(0);
  });
});
