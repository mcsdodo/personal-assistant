import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileRow {
  id: string;
  filename: string | null;
  mime_type: string | null;
  created_at: string | null;
  watch_folder: string | null;
  discovered_at: string;
}

export interface InsertFile {
  id: string;
  filename: string | null;
  mime_type: string | null;
  created_at: string | null;
  watch_folder: string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gdrive_files (
  id              TEXT PRIMARY KEY,
  filename        TEXT,
  mime_type       TEXT,
  created_at      TEXT,
  watch_folder    TEXT,
  discovered_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gdrive_files_discovered ON gdrive_files(discovered_at);
`;

const MIGRATIONS = [
  // Add watch_folder column (v1 → v2)
  `ALTER TABLE gdrive_files ADD COLUMN watch_folder TEXT;`,
];

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec(SCHEMA);

  // Run migrations (idempotent — silently skip already-applied)
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  return db;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function insertFile(db: Database, file: InsertFile): void {
  db.prepare(
    `INSERT OR IGNORE INTO gdrive_files (id, filename, mime_type, created_at, watch_folder, discovered_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(file.id, file.filename, file.mime_type, file.created_at, file.watch_folder);
}

export function fileExists(db: Database, id: string): boolean {
  const row = db.prepare("SELECT 1 FROM gdrive_files WHERE id = ?").get(id);
  return row != null;
}

export function hasAnyFiles(db: Database): boolean {
  const row = db.prepare("SELECT 1 FROM gdrive_files LIMIT 1").get();
  return row != null;
}

export function getRecentFiles(
  db: Database,
  opts: { limit?: number }
): FileRow[] {
  const sql = "SELECT * FROM gdrive_files ORDER BY discovered_at DESC LIMIT ?";
  return db.prepare(sql).all(opts.limit ?? 20) as FileRow[];
}

