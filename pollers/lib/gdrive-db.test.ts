import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  openDb,
  insertFile,
  fileExists,
  hasAnyFiles,
  getRecentFiles,
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
    owner: "business",
    bucket: "accounting",
    folder_id: "drive-folder-abc",
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
    expect(row.discovered_at).toBeTruthy();
  });

  test("persists owner, bucket, and folder_id (manual-reprocess carry)", () => {
    insertFile(db, {
      id: "gdrive-personal",
      filename: "scan.pdf",
      mime_type: "application/pdf",
      created_at: null,
      watch_folder: "personal/accounting",
      owner: "personal",
      bucket: "accounting",
      folder_id: "drive-folder-personal-acct",
    });
    const row = db.query("SELECT * FROM gdrive_files WHERE id = ?").get("gdrive-personal") as FileRow;
    expect(row.owner).toBe("personal");
    expect(row.bucket).toBe("accounting");
    expect(row.folder_id).toBe("drive-folder-personal-acct");
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
      owner: "business",
      bucket: "documents",
      folder_id: "drive-folder-docs",
    });
    const row = db.query("SELECT * FROM gdrive_files WHERE id = ?").get("gdrive-minimal") as FileRow;
    expect(row.filename).toBeNull();
    expect(row.mime_type).toBeNull();
    expect(row.created_at).toBeNull();
    expect(row.watch_folder).toBe("techlab/documents");
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
      owner: "business",
      bucket: "accounting",
      folder_id: "drive-folder-abc",
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
      owner: "business",
      bucket: "accounting",
      folder_id: "drive-folder-abc",
    });
    expect(hasAnyFiles(db)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getRecentFiles
// ---------------------------------------------------------------------------
describe("getRecentFiles", () => {
  beforeEach(() => {
    const stmt = db.prepare(
      `INSERT INTO gdrive_files (id, filename, mime_type, watch_folder, discovered_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run("f1", "scan1.pdf", "application/pdf", "techlab/invoicing", "2026-03-25T08:00:00Z");
    stmt.run("f2", "scan2.pdf", "application/pdf", "techlab/documents", "2026-03-25T09:00:00Z");
    stmt.run("f3", "scan3.pdf", "application/pdf", "techlab/invoicing", "2026-03-25T10:00:00Z");
    stmt.run("f4", "scan4.jpg", "image/jpeg", "techlab/invoicing", "2026-03-25T11:00:00Z");
    stmt.run("f5", "scan5.pdf", "application/pdf", "techlab/documents", "2026-03-25T12:00:00Z");
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

  test("returns empty array when no files", () => {
    // Use a fresh DB
    const freshDir = mkdtempSync(join(tmpdir(), "gdrive-db-test-empty-"));
    const freshDb = openDb(join(freshDir, "gdrive.db"));
    const rows = getRecentFiles(freshDb, {});
    expect(rows).toHaveLength(0);
    freshDb.close();
    try { rmSync(freshDir, { recursive: true, force: true }); } catch {}
  });

  test("returns full FileRow shape", () => {
    const rows = getRecentFiles(db, { limit: 1 });
    const row = rows[0];
    expect(row).toHaveProperty("id");
    expect(row).toHaveProperty("filename");
    expect(row).toHaveProperty("mime_type");
    expect(row).toHaveProperty("created_at");
    expect(row).toHaveProperty("watch_folder");
    expect(row).toHaveProperty("discovered_at");
  });
});
