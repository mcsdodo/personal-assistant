import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb as openEmailDb, getLastChecked, setLastChecked, emailExists } from "../../lib/email-db";
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

  // Returns n emails with distinct, increasing receivedAt (id 0 = oldest),
  // but in **newest-first** order (index 0 = id n-1) to mirror Gmail search results.
  const BASE_TS = new Date("2026-04-15T10:00:00.000Z").getTime();
  function emails(n: number): EmailInfo[] {
    const ordered = Array.from({ length: n }, (_, i) => ({
      id: `gmail-${i}`,
      source: "gmail",
      sender: "vendor@example.com",
      subject: `Invoice ${i}`,
      hasAttachments: true,
      receivedAt: new Date(BASE_TS + i * 60_000).toISOString(), // each 1 min apart, id 0 oldest
    }));
    return ordered.reverse(); // newest-first, like Gmail search results
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

  it("over-cap: processes oldest maxPerCycle, holds cursor, drains remainder next poll", async () => {
    const batch = emails(7); // ids gmail-0..gmail-6; gmail-0 is oldest, gmail-6 newest
    // gmail-0..gmail-4 are the 5 oldest; gmail-5, gmail-6 are the 2 newest (not yet ingested)

    // --- First poll: 7 emails, over cap of 5 ---
    const result = await processWithOverflowGuard(emailDb, wfDb, "gmail", batch, 200, 5);
    expect(result.overflow).toBe(false);
    expect(result.capped).toBe(true);
    expect(result.processed).toBe(5);

    // Cursor must NOT have been advanced (held so next poll re-covers full window)
    expect(getLastChecked(emailDb, "gmail")).toBeNull();

    // Exactly 5 jobs created, for the 5 OLDEST emails (gmail-0..gmail-4)
    const jobs = wfDb
      .prepare("SELECT source_ref FROM jobs ORDER BY created_at ASC")
      .all() as Array<{ source_ref: string }>;
    expect(jobs.length).toBe(5);
    const processedRefs = jobs.map((j) => j.source_ref);
    expect(processedRefs).toContain("gmail:gmail-0");
    expect(processedRefs).toContain("gmail:gmail-1");
    expect(processedRefs).toContain("gmail:gmail-2");
    expect(processedRefs).toContain("gmail:gmail-3");
    expect(processedRefs).toContain("gmail:gmail-4");
    // Newest 2 must NOT have been processed yet
    expect(processedRefs).not.toContain("gmail:gmail-5");
    expect(processedRefs).not.toContain("gmail:gmail-6");

    // --- Simulate next poll: filter already-ingested emails (mirrors pollCycle emailExists check) ---
    const remaining = batch.filter((e) => !emailExists(emailDb, e.id));
    expect(remaining.length).toBe(2); // gmail-5, gmail-6

    const before2 = Date.now();
    const result2 = await processWithOverflowGuard(emailDb, wfDb, "gmail", remaining, 200, 5);
    expect(result2.overflow).toBe(false);
    expect(result2.capped).toBeUndefined(); // normal path, not capped
    expect(result2.processed).toBe(2);

    // Cursor IS now advanced (normal branch ran), and is behind by POLL_OVERLAP (~10 min)
    const cursor = getLastChecked(emailDb, "gmail");
    expect(cursor).not.toBeNull();
    const cursorMs = Date.parse(cursor!);
    expect(cursorMs).toBeLessThanOrEqual(before2 - 9 * 60 * 1000);
    expect(cursorMs).toBeGreaterThan(before2 - 11 * 60 * 1000);

    // Total jobs = 7 (all emails processed across both polls)
    const totalJobs = wfDb.prepare("SELECT COUNT(*) as n FROM jobs").get() as { n: number };
    expect(totalJobs.n).toBe(7);
  });

  it("over-cap with missing receivedAt (all undefined): processes 5, cursor held", async () => {
    // 7 emails with no receivedAt — Date.parse(undefined) → NaN.
    // NaN keys: all comparisons return 0 (stable V8 sort preserves original order).
    // The first 5 (in original order) should be processed; cursor stays null.
    const nanEmails: EmailInfo[] = Array.from({ length: 7 }, (_, i) => ({
      id: `nan-${i}`,
      source: "gmail",
      sender: "vendor@example.com",
      subject: `Invoice ${i}`,
      hasAttachments: false,
      receivedAt: undefined,
    }));

    const result = await processWithOverflowGuard(emailDb, wfDb, "gmail", nanEmails, 200, 5);
    expect(result.overflow).toBe(false);
    expect(result.capped).toBe(true);
    expect(result.processed).toBe(5);

    // Cursor must NOT have been advanced
    expect(getLastChecked(emailDb, "gmail")).toBeNull();

    // Exactly 5 jobs created
    const jobs = wfDb.prepare("SELECT COUNT(*) as n FROM jobs").get() as { n: number };
    expect(jobs.n).toBe(5);
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
