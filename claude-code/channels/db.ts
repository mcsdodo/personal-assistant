import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InsertEmail {
  id: string;
  source: string; // 'gmail' | 'outlook'
  sender?: string | null;
  subject?: string | null;
  preview?: string | null;
  hasAttachments?: boolean;
  receivedAt?: string | null;
  status: "new" | "seed";
}

export interface EmailRow {
  id: string;
  source: string;
  sender: string | null;
  subject: string | null;
  preview: string | null;
  has_attachments: number;
  received_at: string | null;
  discovered_at: string;
  classified_at: string | null;
  classification: string | null;
  action: string | null;
  vendor: string | null;
  confidence: string | null;
  processed_at: string | null;
  process_result: string | null;
  status: string;
}

export interface StatRow {
  status: string;
  count: number;
  last_24h: number;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  sender TEXT,
  subject TEXT,
  preview TEXT,
  has_attachments INTEGER DEFAULT 0,
  received_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  classified_at TEXT,
  classification TEXT,
  action TEXT,
  vendor TEXT,
  confidence TEXT,
  processed_at TEXT,
  process_result TEXT,
  status TEXT NOT NULL DEFAULT 'new'
);
`;

// ---------------------------------------------------------------------------
// Allowed fields for updateEmail
// ---------------------------------------------------------------------------

const ALLOWED_UPDATE_FIELDS = new Set([
  "status",
  "classification",
  "classified_at",
  "action",
  "vendor",
  "confidence",
  "process_result",
  "processed_at",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Opens (or creates) the SQLite database at `path`, runs schema migration,
 * and enables WAL journal mode.
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

/**
 * Inserts an email row. Uses INSERT OR IGNORE so duplicates are silently
 * skipped (idempotent).
 */
export function insertEmail(db: Database, email: InsertEmail): void {
  db.prepare(
    `INSERT OR IGNORE INTO emails
       (id, source, sender, subject, preview, has_attachments, received_at, status)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    email.id,
    email.source,
    email.sender ?? null,
    email.subject ?? null,
    email.preview ?? null,
    email.hasAttachments ? 1 : 0,
    email.receivedAt ?? null,
    email.status,
  );
}

/**
 * Returns true if an email with the given `id` exists in the database.
 */
export function emailExists(db: Database, id: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM emails WHERE id = ? LIMIT 1")
    .get(id);
  return row !== null;
}

/**
 * Returns true if the emails table has any rows at all.
 * Useful for first-scan detection.
 */
export function hasAnyEmails(db: Database): boolean {
  const row = db
    .prepare("SELECT 1 FROM emails LIMIT 1")
    .get();
  return row !== null;
}

/**
 * Returns true if the emails table has any rows for a specific source.
 * Used for per-source seeding: each source (gmail, outlook) seeds
 * independently on its first successful poll.
 */
export function hasAnyEmailsForSource(db: Database, source: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM emails WHERE source = ? LIMIT 1")
    .get(source);
  return row !== null;
}

/**
 * Updates allowed fields on an email row. Disallowed fields (e.g. `id`,
 * `source`) are silently ignored.
 *
 * Auto-sets `classified_at` when `classification` is provided.
 * Auto-sets `processed_at` when `process_result` is provided.
 *
 * Returns `true` if the row was found (regardless of whether anything changed).
 */
export function updateEmail(
  db: Database,
  id: string,
  fields: Partial<Record<string, string | null>>,
): boolean {
  // Filter to allowed fields only
  const filtered: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_UPDATE_FIELDS.has(key)) {
      filtered[key] = value ?? null;
    }
  }

  // Auto-set timestamps
  if ("classification" in filtered && !("classified_at" in filtered)) {
    filtered.classified_at = new Date().toISOString();
  }
  if ("process_result" in filtered && !("processed_at" in filtered)) {
    filtered.processed_at = new Date().toISOString();
  }

  const keys = Object.keys(filtered);
  if (keys.length === 0) {
    // Nothing to update — check if the row exists
    const row = db.prepare("SELECT 1 FROM emails WHERE id = ? LIMIT 1").get(id);
    return row !== null;
  }

  const setClauses = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => filtered[k]);

  const result = db
    .prepare(`UPDATE emails SET ${setClauses} WHERE id = ?`)
    .run(...values, id);

  return result.changes > 0;
}

/**
 * Returns recent emails with optional filters, ordered by discovered_at DESC.
 */
export function getRecentEmails(
  db: Database,
  opts: { limit?: number; status?: string; source?: string },
): EmailRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts.source) {
    conditions.push("source = ?");
    params.push(opts.source);
  }

  let sql = "SELECT * FROM emails";
  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY discovered_at DESC";
  if (opts.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }

  return db.prepare(sql).all(...params) as EmailRow[];
}

/**
 * Returns email counts grouped by status, with a last_24h breakdown.
 */
export function getEmailStats(db: Database): StatRow[] {
  return db
    .prepare(
      `SELECT
         status,
         COUNT(*) as count,
         SUM(CASE WHEN discovered_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) as last_24h
       FROM emails
       GROUP BY status`
    )
    .all() as StatRow[];
}
