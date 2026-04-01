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
  status: "new";
  traceId?: string | null;
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

const SOURCE_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS source_state (
  source TEXT PRIMARY KEY,
  last_checked TEXT NOT NULL
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
  db.exec(SOURCE_STATE_SCHEMA);
  // Migration: add trace_id column if missing
  try { db.exec("ALTER TABLE emails ADD COLUMN trace_id TEXT;"); } catch { /* already exists */ }
  return db;
}

/**
 * Inserts an email row. Uses INSERT OR IGNORE so duplicates are silently
 * skipped (idempotent).
 */
export function insertEmail(db: Database, email: InsertEmail): void {
  db.prepare(
    `INSERT OR IGNORE INTO emails
       (id, source, sender, subject, preview, has_attachments, received_at, status, trace_id)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    email.id,
    email.source,
    email.sender ?? null,
    email.subject ?? null,
    email.preview ?? null,
    email.hasAttachments ? 1 : 0,
    email.receivedAt ?? null,
    email.status,
    email.traceId ?? null,
  );
}

/**
 * Get the trace_id for an email by its source and message ID.
 * Used by workflow-core to continue the trace from email-watcher.
 */
export function getEmailTraceId(db: Database, emailId: string): string | null {
  const row = db
    .prepare("SELECT trace_id FROM emails WHERE id = ? LIMIT 1")
    .get(emailId) as { trace_id: string | null } | null;
  return row?.trace_id ?? null;
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
 * Updates allowed fields on an email row. Disallowed fields (e.g. `id`,
 * `source`) are silently ignored.
 *
 * Auto-sets `classified_at` when `classification` is provided.
 * Auto-sets `processed_at` when `process_result` is provided.
 *
 * When `source` is provided and the row doesn't exist, inserts a new row
 * (upsert behavior). Without `source`, returns `"not_found"` for missing rows.
 *
 * Returns `"updated"` if an existing row was changed, `"inserted"` if a new
 * row was created, or `"not_found"` if the row doesn't exist and no `source`
 * was provided for upsert.
 */
export function updateEmail(
  db: Database,
  id: string,
  fields: Partial<Record<string, string | null>>,
  source?: string,
): "updated" | "inserted" | "not_found" {
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
    return row !== null ? "updated" : "not_found";
  }

  // Try UPDATE first
  const setClauses = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => filtered[k]);

  const result = db
    .prepare(`UPDATE emails SET ${setClauses} WHERE id = ?`)
    .run(...values, id);

  if (result.changes > 0) {
    return "updated";
  }

  // Row doesn't exist — upsert if source is provided
  if (!source) {
    return "not_found";
  }

  const insertFields: Record<string, string | null> = {
    id,
    source,
    ...filtered,
  };
  const insertKeys = Object.keys(insertFields);
  const insertPlaceholders = insertKeys.map(() => "?").join(", ");
  const insertValues = insertKeys.map((k) => insertFields[k]);

  db.prepare(
    `INSERT INTO emails (${insertKeys.join(", ")}) VALUES (${insertPlaceholders})`,
  ).run(...insertValues);

  return "inserted";
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

/**
 * Returns the last_checked timestamp for a given source, or null if not yet tracked.
 */
export function getLastChecked(db: Database, source: string): string | null {
  const row = db
    .prepare("SELECT last_checked FROM source_state WHERE source = ? LIMIT 1")
    .get(source) as { last_checked: string } | null;
  return row?.last_checked ?? null;
}

/**
 * Upserts the last_checked timestamp for a given source.
 */
export function setLastChecked(db: Database, source: string, timestamp: string): void {
  db.prepare(
    `INSERT INTO source_state (source, last_checked) VALUES (?, ?)
     ON CONFLICT(source) DO UPDATE SET last_checked = excluded.last_checked`
  ).run(source, timestamp);
}
