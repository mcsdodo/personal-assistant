import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb as openEmailDb, getLastChecked, setLastChecked } from "../../lib/email-db";
import { openWorkflowDb } from "../../lib/workflow-db";
import { seedFromInitialLookback, processWithOverflowGuard, type EmailInfo } from "./main";

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
    const result = await processWithOverflowGuard(emailDb, wfDb, "gmail", emails(5), 200, 5);
    expect(result.overflow).toBe(false);
    expect(result.processed).toBe(5);
    expect(getLastChecked(emailDb, "gmail")).not.toBeNull();
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
