import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  openDb,
  insertEmail,
  emailExists,
  getRecentEmails,
  type InsertEmail,
  type EmailRow,
} from "./db";
import type { Database } from "bun:sqlite";

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "db-test-"));
  db = openDb(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // On Windows, WAL files may still be locked briefly after close
  }
});

// ---------------------------------------------------------------------------
// openDb
// ---------------------------------------------------------------------------
describe("openDb", () => {
  test("creates emails table", () => {
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='emails'")
      .all();
    expect(rows).toHaveLength(1);
  });

  test("is idempotent — opening twice does not error", () => {
    const dbPath = join(tmpDir, "test.db");
    // db is already open on this path; open again
    const db2 = openDb(dbPath);
    const rows = db2
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='emails'")
      .all();
    expect(rows).toHaveLength(1);
    db2.close();
  });

  test("enables WAL journal mode", () => {
    const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
  });
});

// ---------------------------------------------------------------------------
// insertEmail
// ---------------------------------------------------------------------------
describe("insertEmail", () => {
  const email: InsertEmail = {
    id: "msg-001",
    source: "gmail",
    sender: "shop@example.com",
    subject: "Invoice #123",
    preview: "Your invoice is attached.",
    hasAttachments: true,
    receivedAt: "2026-03-25T10:00:00Z",
  };

  test("inserts a new email", () => {
    insertEmail(db, email);
    const row = db.query("SELECT * FROM emails WHERE id = ?").get("msg-001") as EmailRow;
    expect(row).toBeTruthy();
    expect(row.id).toBe("msg-001");
    expect(row.source).toBe("gmail");
    expect(row.sender).toBe("shop@example.com");
    expect(row.subject).toBe("Invoice #123");
    expect(row.preview).toBe("Your invoice is attached.");
    expect(row.has_attachments).toBe(1);
    expect(row.received_at).toBe("2026-03-25T10:00:00Z");
    expect(row.discovered_at).toBeTruthy();
  });

  test("ignores duplicate (INSERT OR IGNORE)", () => {
    insertEmail(db, email);
    // Insert again — should not throw and should not duplicate
    insertEmail(db, email);
    const rows = db.query("SELECT * FROM emails WHERE id = ?").all("msg-001");
    expect(rows).toHaveLength(1);
  });

  test("handles missing optional fields", () => {
    insertEmail(db, {
      id: "msg-minimal",
      source: "outlook",
    });
    const row = db.query("SELECT * FROM emails WHERE id = ?").get("msg-minimal") as EmailRow;
    expect(row.sender).toBeNull();
    expect(row.subject).toBeNull();
    expect(row.preview).toBeNull();
    expect(row.has_attachments).toBe(0);
    expect(row.received_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// emailExists
// ---------------------------------------------------------------------------
describe("emailExists", () => {
  test("returns false for unknown ID", () => {
    expect(emailExists(db, "nonexistent")).toBe(false);
  });

  test("returns true for inserted email", () => {
    insertEmail(db, { id: "msg-exist", source: "gmail" });
    expect(emailExists(db, "msg-exist")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getRecentEmails
// ---------------------------------------------------------------------------
describe("getRecentEmails", () => {
  beforeEach(() => {
    // Insert emails with different timestamps by manipulating discovered_at directly
    const stmt = db.prepare(
      `INSERT INTO emails (id, source, sender, subject, discovered_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run("e1", "gmail", "a@example.com", "First", "2026-03-25T08:00:00Z");
    stmt.run("e2", "outlook", "b@example.com", "Second", "2026-03-25T09:00:00Z");
    stmt.run("e3", "gmail", "c@example.com", "Third", "2026-03-25T10:00:00Z");
    stmt.run("e4", "outlook", "d@example.com", "Fourth", "2026-03-25T11:00:00Z");
    stmt.run("e5", "gmail", "e@example.com", "Fifth", "2026-03-25T12:00:00Z");
  });

  test("returns all emails ordered by discovered_at DESC", () => {
    const rows = getRecentEmails(db, {});
    expect(rows).toHaveLength(5);
    expect(rows[0].id).toBe("e5");
    expect(rows[1].id).toBe("e4");
    expect(rows[2].id).toBe("e3");
    expect(rows[3].id).toBe("e2");
    expect(rows[4].id).toBe("e1");
  });

  test("filters by source", () => {
    const rows = getRecentEmails(db, { source: "outlook" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === "outlook")).toBe(true);
  });

  test("respects limit", () => {
    const rows = getRecentEmails(db, { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("e5");
    expect(rows[1].id).toBe("e4");
  });

  test("combines source and limit filters", () => {
    const rows = getRecentEmails(db, { source: "gmail", limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === "gmail")).toBe(true);
  });
});
