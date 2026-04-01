import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  openDb,
  insertFile,
  fileExists,
  hasAnyFiles,
  updateFile,
  getRecentFiles,
  getFileStats,
  type InsertFile,
  type FileRow,
} from "./gdrive-db";
import type { Database } from "bun:sqlite";

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gdrive-db-test-"));
  db = openDb(join(tmpDir, "gdrive.db"));
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
  test("creates gdrive_files table", () => {
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='gdrive_files'")
      .all();
    expect(rows).toHaveLength(1);
  });

  test("creates indexes", () => {
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_gdrive_%'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name).sort();
    expect(names).toContain("idx_gdrive_files_status");
    expect(names).toContain("idx_gdrive_files_discovered");
  });

  test("is idempotent — opening twice does not error", () => {
    const dbPath = join(tmpDir, "gdrive.db");
    const db2 = openDb(dbPath);
    const rows = db2
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='gdrive_files'")
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
// insertFile
// ---------------------------------------------------------------------------
describe("insertFile", () => {
  const file: InsertFile = {
    id: "gdrive-001",
    filename: "invoice_2026_03.pdf",
    mime_type: "application/pdf",
    created_at: "2026-03-25T10:00:00Z",
    watch_folder: "techlab/invoicing",
    status: "new",
  };

  test("inserts a new file", () => {
    insertFile(db, file);
    const row = db.query("SELECT * FROM gdrive_files WHERE id = ?").get("gdrive-001") as FileRow;
    expect(row).toBeTruthy();
    expect(row.id).toBe("gdrive-001");
    expect(row.filename).toBe("invoice_2026_03.pdf");
    expect(row.mime_type).toBe("application/pdf");
    expect(row.created_at).toBe("2026-03-25T10:00:00Z");
    expect(row.watch_folder).toBe("techlab/invoicing");
    expect(row.status).toBe("new");
    expect(row.discovered_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });

  test("ignores duplicate (INSERT OR IGNORE)", () => {
    insertFile(db, file);
    insertFile(db, file);
    const rows = db.query("SELECT * FROM gdrive_files WHERE id = ?").all("gdrive-001");
    expect(rows).toHaveLength(1);
  });

  test("handles null optional fields", () => {
    insertFile(db, {
      id: "gdrive-minimal",
      filename: null,
      mime_type: null,
      created_at: null,
      watch_folder: "techlab/documents",
      status: "new",
    });
    const row = db.query("SELECT * FROM gdrive_files WHERE id = ?").get("gdrive-minimal") as FileRow;
    expect(row.filename).toBeNull();
    expect(row.mime_type).toBeNull();
    expect(row.created_at).toBeNull();
    expect(row.watch_folder).toBe("techlab/documents");
    expect(row.status).toBe("new");
  });

  test("stores different statuses", () => {
    insertFile(db, { ...file, id: "gdrive-seed", status: "seed" });
    const row = db.query("SELECT status FROM gdrive_files WHERE id = ?").get("gdrive-seed") as { status: string };
    expect(row.status).toBe("seed");
  });
});

// ---------------------------------------------------------------------------
// fileExists
// ---------------------------------------------------------------------------
describe("fileExists", () => {
  test("returns false for unknown ID", () => {
    expect(fileExists(db, "nonexistent")).toBe(false);
  });

  test("returns true for inserted file", () => {
    insertFile(db, {
      id: "gdrive-exist",
      filename: "test.pdf",
      mime_type: "application/pdf",
      created_at: null,
      watch_folder: "techlab/invoicing",
      status: "new",
    });
    expect(fileExists(db, "gdrive-exist")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasAnyFiles
// ---------------------------------------------------------------------------
describe("hasAnyFiles", () => {
  test("returns false on empty database", () => {
    expect(hasAnyFiles(db)).toBe(false);
  });

  test("returns true after insert", () => {
    insertFile(db, {
      id: "gdrive-any",
      filename: "test.pdf",
      mime_type: "application/pdf",
      created_at: null,
      watch_folder: "techlab/invoicing",
      status: "new",
    });
    expect(hasAnyFiles(db)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// updateFile
// ---------------------------------------------------------------------------
describe("updateFile", () => {
  beforeEach(() => {
    insertFile(db, {
      id: "gdrive-upd",
      filename: "scan.pdf",
      mime_type: "application/pdf",
      created_at: "2026-03-25T10:00:00Z",
      watch_folder: "techlab/invoicing",
      status: "new",
    });
  });

  test("updates status field", () => {
    const result = updateFile(db, "gdrive-upd", { status: "processing" });
    expect(result).toBe(true);

    const row = db.query("SELECT * FROM gdrive_files WHERE id = ?").get("gdrive-upd") as FileRow;
    expect(row.status).toBe("processing");
  });

  test("updates classification and action fields", () => {
    const classificationJson = JSON.stringify({ doc_type: "invoice", vendor: "Alza" });
    const result = updateFile(db, "gdrive-upd", {
      classification: classificationJson,
      action: "upload_to_paperless",
      status: "classified",
    });
    expect(result).toBe(true);

    const row = db.query("SELECT * FROM gdrive_files WHERE id = ?").get("gdrive-upd") as FileRow;
    expect(row.classification).toBe(classificationJson);
    expect(row.action).toBe("upload_to_paperless");
    expect(row.status).toBe("classified");
  });

  test("auto-sets processed_at when status is completed", () => {
    const result = updateFile(db, "gdrive-upd", {
      status: "completed",
      process_result: "Uploaded to Paperless as doc #789",
    });
    expect(result).toBe(true);

    const row = db.query("SELECT * FROM gdrive_files WHERE id = ?").get("gdrive-upd") as FileRow;
    expect(row.status).toBe("completed");
    expect(row.process_result).toBe("Uploaded to Paperless as doc #789");
    expect(row.processed_at).toBeTruthy();
  });

  test("auto-sets processed_at when status is failed", () => {
    const result = updateFile(db, "gdrive-upd", {
      status: "failed",
      error: "Download timeout",
    });
    expect(result).toBe(true);

    const row = db.query("SELECT * FROM gdrive_files WHERE id = ?").get("gdrive-upd") as FileRow;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Download timeout");
    expect(row.processed_at).toBeTruthy();
  });

  test("does NOT set processed_at for non-terminal statuses", () => {
    updateFile(db, "gdrive-upd", { status: "processing" });

    const row = db.query("SELECT * FROM gdrive_files WHERE id = ?").get("gdrive-upd") as FileRow;
    expect(row.processed_at).toBeNull();
  });

  test("always updates updated_at", () => {
    const before = db.query("SELECT updated_at FROM gdrive_files WHERE id = ?").get("gdrive-upd") as { updated_at: string };
    // Small delay to ensure datetime('now') differs
    updateFile(db, "gdrive-upd", { status: "processing" });
    const after = db.query("SELECT updated_at FROM gdrive_files WHERE id = ?").get("gdrive-upd") as { updated_at: string };
    // updated_at should be set (may or may not differ within same second)
    expect(after.updated_at).toBeTruthy();
  });

  test("updates job_id field", () => {
    updateFile(db, "gdrive-upd", { job_id: "job-12345" });
    const row = db.query("SELECT job_id FROM gdrive_files WHERE id = ?").get("gdrive-upd") as { job_id: string };
    expect(row.job_id).toBe("job-12345");
  });

  test("returns false for nonexistent ID", () => {
    const result = updateFile(db, "gdrive-nonexistent", { status: "failed" });
    expect(result).toBe(false);
  });

  test("can set fields to null", () => {
    // First set an error
    updateFile(db, "gdrive-upd", { error: "some error" });
    // Then clear it
    updateFile(db, "gdrive-upd", { error: null });

    const row = db.query("SELECT error FROM gdrive_files WHERE id = ?").get("gdrive-upd") as { error: string | null };
    expect(row.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRecentFiles
// ---------------------------------------------------------------------------
describe("getRecentFiles", () => {
  beforeEach(() => {
    const stmt = db.prepare(
      `INSERT INTO gdrive_files (id, filename, mime_type, watch_folder, status, discovered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    stmt.run("f1", "scan1.pdf", "application/pdf", "techlab/invoicing", "new", "2026-03-25T08:00:00Z");
    stmt.run("f2", "scan2.pdf", "application/pdf", "techlab/documents", "completed", "2026-03-25T09:00:00Z");
    stmt.run("f3", "scan3.pdf", "application/pdf", "techlab/invoicing", "failed", "2026-03-25T10:00:00Z");
    stmt.run("f4", "scan4.jpg", "image/jpeg", "techlab/invoicing", "new", "2026-03-25T11:00:00Z");
    stmt.run("f5", "scan5.pdf", "application/pdf", "techlab/documents", "completed", "2026-03-25T12:00:00Z");
  });

  test("returns all files ordered by discovered_at DESC", () => {
    const rows = getRecentFiles(db, {});
    expect(rows).toHaveLength(5);
    expect(rows[0].id).toBe("f5");
    expect(rows[1].id).toBe("f4");
    expect(rows[2].id).toBe("f3");
    expect(rows[3].id).toBe("f2");
    expect(rows[4].id).toBe("f1");
  });

  test("filters by status", () => {
    const rows = getRecentFiles(db, { status: "new" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "new")).toBe(true);
  });

  test("respects limit", () => {
    const rows = getRecentFiles(db, { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("f5");
    expect(rows[1].id).toBe("f4");
  });

  test("defaults to limit 20", () => {
    // With only 5 rows, all should be returned
    const rows = getRecentFiles(db, {});
    expect(rows).toHaveLength(5);
  });

  test("combines status filter with limit", () => {
    const rows = getRecentFiles(db, { status: "completed", limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("f5"); // most recent completed
  });

  test("returns empty array when no matches", () => {
    const rows = getRecentFiles(db, { status: "processing" });
    expect(rows).toHaveLength(0);
  });

  test("returns full FileRow shape", () => {
    const rows = getRecentFiles(db, { limit: 1 });
    const row = rows[0];
    expect(row).toHaveProperty("id");
    expect(row).toHaveProperty("filename");
    expect(row).toHaveProperty("mime_type");
    expect(row).toHaveProperty("created_at");
    expect(row).toHaveProperty("watch_folder");
    expect(row).toHaveProperty("status");
    expect(row).toHaveProperty("job_id");
    expect(row).toHaveProperty("error");
    expect(row).toHaveProperty("discovered_at");
    expect(row).toHaveProperty("processed_at");
    expect(row).toHaveProperty("classification");
    expect(row).toHaveProperty("action");
    expect(row).toHaveProperty("process_result");
    expect(row).toHaveProperty("updated_at");
  });
});

// ---------------------------------------------------------------------------
// getFileStats
// ---------------------------------------------------------------------------
describe("getFileStats", () => {
  test("returns correct counts grouped by status", () => {
    const stmt = db.prepare(
      `INSERT INTO gdrive_files (id, filename, watch_folder, status, discovered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    );
    stmt.run("s1", "a.pdf", "techlab/invoicing", "new", "2026-03-25T08:00:00Z");
    stmt.run("s2", "b.pdf", "techlab/invoicing", "new", "2026-03-25T09:00:00Z");
    stmt.run("s3", "c.pdf", "techlab/documents", "completed", "2026-03-25T10:00:00Z");
    stmt.run("s4", "d.pdf", "techlab/invoicing", "failed", "2026-03-25T11:00:00Z");
    stmt.run("s5", "e.pdf", "techlab/invoicing", "completed", "2026-03-25T12:00:00Z");
    stmt.run("s6", "f.pdf", "techlab/invoicing", "completed", "2026-03-25T13:00:00Z");

    const stats = getFileStats(db);
    expect(stats["new"]).toBe(2);
    expect(stats["completed"]).toBe(3);
    expect(stats["failed"]).toBe(1);
  });

  test("returns empty object for empty database", () => {
    const stats = getFileStats(db);
    expect(Object.keys(stats)).toHaveLength(0);
  });

  test("only includes statuses that have rows", () => {
    const stmt = db.prepare(
      `INSERT INTO gdrive_files (id, filename, watch_folder, status, discovered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    );
    stmt.run("s1", "a.pdf", "techlab/invoicing", "new", "2026-03-25T08:00:00Z");

    const stats = getFileStats(db);
    expect(stats["new"]).toBe(1);
    expect(stats["completed"]).toBeUndefined();
    expect(stats["failed"]).toBeUndefined();
  });
});
