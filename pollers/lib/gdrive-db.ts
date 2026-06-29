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
  /** Owner role resolved by the poller. Null on rows written before the v3 migration. */
  owner: string | null;
  /** Bucket resolved by the poller. Null on rows written before the v3 migration. */
  bucket: string | null;
  /** Resolved Drive ID of the bucket folder. Null on rows written before the v3 migration. */
  folder_id: string | null;
  discovered_at: string;
}

export interface InsertFile {
  id: string;
  filename: string | null;
  mime_type: string | null;
  created_at: string | null;
  watch_folder: string;
  /** Owner role resolved by the poller (carried so the manual reprocess path can rebuild the job). */
  owner: string;
  /** Bucket resolved by the poller. */
  bucket: string;
  /** Resolved Drive ID of the bucket folder. */
  folder_id: string;
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
  owner           TEXT,
  bucket          TEXT,
  folder_id       TEXT,
  discovered_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gdrive_files_discovered ON gdrive_files(discovered_at);
`;

const MIGRATIONS = [
  // Add watch_folder column (v1 → v2)
  `ALTER TABLE gdrive_files ADD COLUMN watch_folder TEXT;`,
  // Carry the poller's resolved owner/bucket/folder_id (v2 → v3) so the manual
  // create_scan_intake_job path can rebuild a schema-valid job from the audit row.
  `ALTER TABLE gdrive_files ADD COLUMN owner TEXT;`,
  `ALTER TABLE gdrive_files ADD COLUMN bucket TEXT;`,
  `ALTER TABLE gdrive_files ADD COLUMN folder_id TEXT;`,
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
    `INSERT OR IGNORE INTO gdrive_files (id, filename, mime_type, created_at, watch_folder, owner, bucket, folder_id, discovered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(file.id, file.filename, file.mime_type, file.created_at, file.watch_folder, file.owner, file.bucket, file.folder_id);
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

