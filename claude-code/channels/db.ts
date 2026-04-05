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
  traceId?: string | null;
  invoiceLinks?: string | null; // JSON-serialized InvoiceLink[]
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
  invoice_links: string | null;
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
  discovered_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const SOURCE_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS source_state (
  source TEXT PRIMARY KEY,
  last_checked TEXT NOT NULL
);
`;

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
  // Migration: add invoice_links column if missing
  try { db.exec("ALTER TABLE emails ADD COLUMN invoice_links TEXT;"); } catch { /* already exists */ }
  return db;
}

/**
 * Inserts an email row. Uses INSERT OR IGNORE so duplicates are silently
 * skipped (idempotent).
 */
export function insertEmail(db: Database, email: InsertEmail): void {
  db.prepare(
    `INSERT OR IGNORE INTO emails
       (id, source, sender, subject, preview, has_attachments, received_at, trace_id, invoice_links)
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
    email.traceId ?? null,
    email.invoiceLinks ?? null,
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
 * Returns recent emails with optional filters, ordered by discovered_at DESC.
 */
export function getRecentEmails(
  db: Database,
  opts: { limit?: number; source?: string },
): EmailRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

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
