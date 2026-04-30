import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb as openEmailDb, getLastChecked, setLastChecked } from "../../lib/email-db";
import { runSkipCatchup } from "./skip-catchup";

function tmpPath(prefix: string): string {
  return `/tmp/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("skip-catchup CLI", () => {
  let db: Database;
  beforeEach(() => { db = openEmailDb(tmpPath("emails")); });

  it("advances last_checked to now for an existing source", () => {
    setLastChecked(db, "gmail", "2025-01-01T00:00:00.000Z");
    const before = Date.now();
    runSkipCatchup(db, "gmail");
    const after = getLastChecked(db, "gmail");
    expect(after).not.toBe("2025-01-01T00:00:00.000Z");
    expect(Date.parse(after!)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("creates the row if the source has never been seeded", () => {
    runSkipCatchup(db, "outlook");
    expect(getLastChecked(db, "outlook")).not.toBeNull();
  });

  it("throws on an unknown source name", () => {
    expect(() => runSkipCatchup(db, "yahoo")).toThrow(/unknown source/);
  });
});
