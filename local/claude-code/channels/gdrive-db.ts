import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileRow {
  id: string;
  filename: string | null;
  mime_type: string | null;
  created_at: string | null;
  status: string;
  job_id: string | null;
  error: string | null;
  discovered_at: string;
  processed_at: string | null;
  classification: string | null;
  action: string | null;
  process_result: string | null;
  updated_at: string;
}

export interface InsertFile {
  id: string;
  filename: string | null;
  mime_type: string | null;
  created_at: string | null;
  status: string;
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
  status          TEXT NOT NULL DEFAULT 'new',
  job_id          TEXT,
  error           TEXT,
  discovered_at   TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at    TEXT,
  classification  TEXT,
  action          TEXT,
  process_result  TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gdrive_files_status ON gdrive_files(status);
CREATE INDEX IF NOT EXISTS idx_gdrive_files_discovered ON gdrive_files(discovered_at);
`;

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function insertFile(db: Database, file: InsertFile): void {
  db.prepare(
    `INSERT OR IGNORE INTO gdrive_files (id, filename, mime_type, created_at, status, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(file.id, file.filename, file.mime_type, file.created_at, file.status);
}

export function fileExists(db: Database, id: string): boolean {
  const row = db.prepare("SELECT 1 FROM gdrive_files WHERE id = ?").get(id);
  return row != null;
}

export function hasAnyFiles(db: Database): boolean {
  const row = db.prepare("SELECT 1 FROM gdrive_files LIMIT 1").get();
  return row != null;
}

export function updateFile(
  db: Database,
  id: string,
  fields: Record<string, string | null>
): boolean {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(val);
  }
  sets.push("updated_at = datetime('now')");

  if (fields.status === "completed" || fields.status === "failed") {
    sets.push("processed_at = datetime('now')");
  }

  const sql = `UPDATE gdrive_files SET ${sets.join(", ")} WHERE id = ?`;
  values.push(id);
  const result = db.prepare(sql).run(...values);
  return (result as any).changes > 0;
}

export function getRecentFiles(
  db: Database,
  opts: { limit?: number; status?: string }
): FileRow[] {
  let sql = "SELECT * FROM gdrive_files";
  const params: (string | number)[] = [];
  const wheres: string[] = [];

  if (opts.status) {
    wheres.push("status = ?");
    params.push(opts.status);
  }

  if (wheres.length > 0) sql += " WHERE " + wheres.join(" AND ");
  sql += " ORDER BY discovered_at DESC LIMIT ?";
  params.push(opts.limit ?? 20);

  return db.prepare(sql).all(...params) as FileRow[];
}

export function getFileStats(db: Database): Record<string, number> {
  const rows = db
    .prepare("SELECT status, COUNT(*) as count FROM gdrive_files GROUP BY status")
    .all() as { status: string; count: number }[];
  const stats: Record<string, number> = {};
  for (const row of rows) {
    stats[row.status] = row.count;
  }
  return stats;
}
