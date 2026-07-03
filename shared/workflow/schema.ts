import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export type JobState =
  | "queued"
  | "running"
  | "retryable"
  | "awaiting_approval"
  | "awaiting_classification"
  | "awaiting_user_guidance"
  | "completed"
  | "failed"
  | "cancelled";

export interface CreateJobInput {
  workflowType: string;
  inputJson?: string | null;
  sourceRef?: string | null;
  idempotencyKey?: string | null;
  requiresApproval?: boolean;
  traceId?: string | null;
}

export interface JobRow {
  id: string;
  workflow_type: string;
  state: JobState;
  source_ref: string | null;
  idempotency_key: string | null;
  input_json: string | null;
  output_json: string | null;
  error_json: string | null;
  requires_approval: number;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  retry_count: number;
  scheduled_at: string | null;
  trace_id: string | null;
  last_reminder_at: string | null;
}

export interface JobEventRow {
  id: number;
  job_id: string;
  event_type: string;
  payload_json: string | null;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  source_ref TEXT,
  idempotency_key TEXT UNIQUE,
  input_json TEXT,
  output_json TEXT,
  error_json TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_state_created_at
  ON jobs(state, created_at);

CREATE INDEX IF NOT EXISTS idx_job_events_job_id_created_at
  ON job_events(job_id, created_at, id);
`;

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomId(): string {
  return crypto.randomUUID();
}

export function openWorkflowDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  // Two writers (pa-worker + workflow-mcp's push loop, both ticking on
  // WORKFLOW_POLL_MS) plus the pollers all share this file. WAL allows
  // concurrent readers but only one writer; default busy_timeout=0 returns
  // SQLITE_BUSY immediately on contention. 5s is conservative — actual
  // writes are sub-millisecond.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);

  // Migrations — safe ADD COLUMN (ignore "duplicate column" error)
  try { db.exec("ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE jobs ADD COLUMN scheduled_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE jobs ADD COLUMN trace_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE jobs ADD COLUMN paperless_doc_id INTEGER"); } catch {}
  try { db.exec("ALTER TABLE jobs ADD COLUMN last_reminder_at TEXT"); } catch {}
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_retryable ON jobs(state, scheduled_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_paperless_doc_id ON jobs(paperless_doc_id)");
  // Backfill from the established output field name `paperless_document_id`
  // (used by InvoiceIntakeResult, telegram-notify, and tests).
  db.exec(
    `UPDATE jobs SET paperless_doc_id = json_extract(output_json, '$.paperless_document_id')
     WHERE output_json IS NOT NULL
       AND json_extract(output_json, '$.paperless_document_id') IS NOT NULL
       AND paperless_doc_id IS NULL`,
  );

  return db;
}
