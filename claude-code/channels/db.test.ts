import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";

// Import from resolved absolute path to bypass mock.module("./db") pollution
// from email-watcher.integration.test.ts (Bun's mock.module is global).
const dbModule = require(resolve(import.meta.dir, "db.ts"));
const openDb = dbModule.openDb as (path: string) => Database;
const insertEmail = dbModule.insertEmail as (db: Database, email: any) => void;
const emailExists = dbModule.emailExists as (db: Database, id: string) => boolean;
const updateEmail = dbModule.updateEmail as (db: Database, id: string, fields: Record<string, any>, source?: string) => boolean;
const getRecentEmails = dbModule.getRecentEmails as (db: Database, opts: any) => any[];
const getEmailStats = dbModule.getEmailStats as (db: Database) => any[];
type InsertEmail = import("./db").InsertEmail;
type EmailRow = import("./db").EmailRow;
type StatRow = import("./db").StatRow;

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
    status: "new",
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
    expect(row.status).toBe("new");
    expect(row.discovered_at).toBeTruthy();
  });

  test("ignores duplicate (INSERT OR IGNORE)", () => {
    insertEmail(db, email);
    // Insert again — should not throw and should not duplicate
    insertEmail(db, email);
    const rows = db.query("SELECT * FROM emails WHERE id = ?").all("msg-001");
    expect(rows).toHaveLength(1);
  });

  test("stores seed status", () => {
    insertEmail(db, { ...email, id: "msg-seed", status: "seed" });
    const row = db.query("SELECT status FROM emails WHERE id = ?").get("msg-seed") as { status: string };
    expect(row.status).toBe("seed");
  });

  test("handles missing optional fields", () => {
    insertEmail(db, {
      id: "msg-minimal",
      source: "outlook",
      status: "new",
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
    insertEmail(db, { id: "msg-exist", source: "gmail", status: "new" });
    expect(emailExists(db, "msg-exist")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasAnyEmails

// ---------------------------------------------------------------------------
// updateEmail
// ---------------------------------------------------------------------------
describe("updateEmail", () => {
  beforeEach(() => {
    insertEmail(db, {
      id: "msg-upd",
      source: "gmail",
      sender: "vendor@example.com",
      subject: "Invoice",
      status: "new",
    });
  });

  test("updates classification fields and auto-sets classified_at", () => {
    const classificationJson = JSON.stringify({ action: "download_and_upload", vendor: "Alza" });
    const result = updateEmail(db, "msg-upd", {
      classification: classificationJson,
      action: "download_and_upload",
      vendor: "Alza",
      confidence: "high",
      status: "classified",
    });
    expect(result).toBe("updated");

    const row = db.query("SELECT * FROM emails WHERE id = ?").get("msg-upd") as EmailRow;
    expect(row.classification).toBe(classificationJson);
    expect(row.action).toBe("download_and_upload");
    expect(row.vendor).toBe("Alza");
    expect(row.confidence).toBe("high");
    expect(row.status).toBe("classified");
    expect(row.classified_at).toBeTruthy();
  });

  test("updates process_result and auto-sets processed_at", () => {
    const result = updateEmail(db, "msg-upd", {
      process_result: "Uploaded to Paperless as doc #456",
      status: "processed",
    });
    expect(result).toBe("updated");

    const row = db.query("SELECT * FROM emails WHERE id = ?").get("msg-upd") as EmailRow;
    expect(row.process_result).toBe("Uploaded to Paperless as doc #456");
    expect(row.processed_at).toBeTruthy();
    expect(row.status).toBe("processed");
  });

  test("returns not_found for nonexistent ID without source", () => {
    const result = updateEmail(db, "msg-nonexistent", { status: "failed" });
    expect(result).toBe("not_found");
  });

  test("silently ignores disallowed fields (id, source)", () => {
    const result = updateEmail(db, "msg-upd", {
      id: "hacked-id",
      source: "hacked-source",
      status: "classified",
    } as any);
    expect(result).toBe("updated");

    const row = db.query("SELECT * FROM emails WHERE id = ?").get("msg-upd") as EmailRow;
    // Original values should be preserved
    expect(row.id).toBe("msg-upd");
    expect(row.source).toBe("gmail");
    // Allowed field should be updated
    expect(row.status).toBe("classified");
  });

  test("does nothing when only disallowed fields are provided", () => {
    const result = updateEmail(db, "msg-upd", {
      id: "hacked",
      source: "hacked",
    } as any);
    // Row exists but no allowed fields to update — return "updated" (row was found)
    expect(result).toBe("updated");
    const row = db.query("SELECT * FROM emails WHERE id = ?").get("msg-upd") as EmailRow;
    expect(row.id).toBe("msg-upd");
    expect(row.source).toBe("gmail");
  });

  // --- Upsert behavior ---

  test("inserts new row when source is provided and row doesn't exist", () => {
    const result = updateEmail(
      db,
      "msg-new-adhoc",
      { status: "processed", process_result: "Uploaded manually" },
      "gmail",
    );
    expect(result).toBe("inserted");

    const row = db.query("SELECT * FROM emails WHERE id = ?").get("msg-new-adhoc") as EmailRow;
    expect(row).toBeTruthy();
    expect(row.id).toBe("msg-new-adhoc");
    expect(row.source).toBe("gmail");
    expect(row.status).toBe("processed");
    expect(row.process_result).toBe("Uploaded manually");
    expect(row.processed_at).toBeTruthy();
    expect(row.discovered_at).toBeTruthy(); // SQLite default
  });

  test("upsert updates existing row instead of inserting duplicate", () => {
    const result = updateEmail(
      db,
      "msg-upd",
      { status: "processed", process_result: "Done" },
      "gmail",
    );
    expect(result).toBe("updated");

    // Should still be only one row
    const rows = db.query("SELECT * FROM emails WHERE id = ?").all("msg-upd");
    expect(rows).toHaveLength(1);
    expect((rows[0] as EmailRow).status).toBe("processed");
  });

  test("upsert with classification sets classified_at on new row", () => {
    const result = updateEmail(
      db,
      "msg-classified-new",
      {
        status: "classified",
        classification: '{"action":"ignore"}',
        vendor: "TestVendor",
        confidence: "high",
      },
      "outlook",
    );
    expect(result).toBe("inserted");

    const row = db.query("SELECT * FROM emails WHERE id = ?").get("msg-classified-new") as EmailRow;
    expect(row.source).toBe("outlook");
    expect(row.classification).toBe('{"action":"ignore"}');
    expect(row.vendor).toBe("TestVendor");
    expect(row.classified_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// getRecentEmails
// ---------------------------------------------------------------------------
describe("getRecentEmails", () => {
  beforeEach(() => {
    // Insert emails with different timestamps by manipulating discovered_at directly
    const stmt = db.prepare(
      `INSERT INTO emails (id, source, sender, subject, status, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run("e1", "gmail", "a@example.com", "First", "new", "2026-03-25T08:00:00Z");
    stmt.run("e2", "outlook", "b@example.com", "Second", "classified", "2026-03-25T09:00:00Z");
    stmt.run("e3", "gmail", "c@example.com", "Third", "processed", "2026-03-25T10:00:00Z");
    stmt.run("e4", "outlook", "d@example.com", "Fourth", "new", "2026-03-25T11:00:00Z");
    stmt.run("e5", "gmail", "e@example.com", "Fifth", "failed", "2026-03-25T12:00:00Z");
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

  test("filters by status", () => {
    const rows = getRecentEmails(db, { status: "new" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "new")).toBe(true);
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

  test("combines filters", () => {
    const rows = getRecentEmails(db, { source: "gmail", status: "new" });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("e1");
  });
});

// ---------------------------------------------------------------------------
// getEmailStats
// ---------------------------------------------------------------------------
describe("getEmailStats", () => {
  test("returns correct counts grouped by status", () => {
    const stmt = db.prepare(
      `INSERT INTO emails (id, source, status, discovered_at) VALUES (?, ?, ?, ?)`
    );
    stmt.run("s1", "gmail", "new", "2026-03-25T08:00:00Z");
    stmt.run("s2", "gmail", "new", "2026-03-25T09:00:00Z");
    stmt.run("s3", "outlook", "classified", "2026-03-25T10:00:00Z");
    stmt.run("s4", "gmail", "processed", "2026-03-25T11:00:00Z");
    stmt.run("s5", "gmail", "processed", "2026-03-25T12:00:00Z");
    stmt.run("s6", "gmail", "processed", "2026-03-25T13:00:00Z");

    const stats = getEmailStats(db);
    const byStatus = Object.fromEntries(stats.map((s) => [s.status, s]));

    expect(byStatus["new"].count).toBe(2);
    expect(byStatus["classified"].count).toBe(1);
    expect(byStatus["processed"].count).toBe(3);
  });

  test("includes last_24h breakdown", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 2 * 3600_000).toISOString(); // 2 hours ago
    const old = "2020-01-01T00:00:00Z"; // way in the past

    const stmt = db.prepare(
      `INSERT INTO emails (id, source, status, discovered_at) VALUES (?, ?, ?, ?)`
    );
    stmt.run("r1", "gmail", "new", recent);
    stmt.run("r2", "gmail", "new", old);

    const stats = getEmailStats(db);
    const newStat = stats.find((s) => s.status === "new")!;
    expect(newStat.count).toBe(2);
    expect(newStat.last_24h).toBe(1);
  });

  test("returns empty array for empty database", () => {
    const stats = getEmailStats(db);
    expect(stats).toHaveLength(0);
  });
});
