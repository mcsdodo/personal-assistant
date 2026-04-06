import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";

import { validateClassificationByStep, WorkflowSchemaError } from "./workflow-schemas";

export type JobState =
  | "queued"
  | "running"
  | "retryable"
  | "awaiting_approval"
  | "awaiting_classification"
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

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(): string {
  return crypto.randomUUID();
}

export function openWorkflowDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  // Migrations — safe ADD COLUMN (ignore "duplicate column" error)
  try { db.exec("ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE jobs ADD COLUMN scheduled_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE jobs ADD COLUMN trace_id TEXT"); } catch {}
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_retryable ON jobs(state, scheduled_at)");

  return db;
}

export function addJobEvent(
  db: Database,
  jobId: string,
  eventType: string,
  payload?: unknown,
): void {
  db.prepare(
    `INSERT INTO job_events (job_id, event_type, payload_json)
     VALUES (?, ?, ?)`
  ).run(jobId, eventType, payload === undefined ? null : JSON.stringify(payload));
}

export function getJob(db: Database, id: string): JobRow | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  return (row as JobRow | null) ?? null;
}

export function getJobByIdempotencyKey(db: Database, key: string): JobRow | null {
  const row = db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(key);
  return (row as JobRow | null) ?? null;
}

export function createJob(db: Database, input: CreateJobInput): JobRow {
  const idempotencyKey = input.idempotencyKey ?? null;
  if (idempotencyKey) {
    const existing = getJobByIdempotencyKey(db, idempotencyKey);
    if (existing) {
      addJobEvent(db, existing.id, "idempotent_reuse", { idempotency_key: idempotencyKey });
      return existing;
    }
  }

  const id = randomId();
  db.prepare(
    `INSERT INTO jobs (
       id,
       workflow_type,
       state,
       source_ref,
       idempotency_key,
       input_json,
       requires_approval,
       trace_id,
       created_at,
       updated_at
     ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.workflowType,
    input.sourceRef ?? null,
    idempotencyKey,
    input.inputJson ?? null,
    input.requiresApproval ? 1 : 0,
    input.traceId ?? null,
    nowIso(),
    nowIso(),
  );

  addJobEvent(db, id, "created", {
    workflow_type: input.workflowType,
    source_ref: input.sourceRef ?? null,
    idempotency_key: idempotencyKey,
    requires_approval: Boolean(input.requiresApproval),
  });

  return getJob(db, id)!;
}

export function listJobs(
  db: Database,
  opts: { state?: JobState; workflowType?: string; limit?: number },
): JobRow[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (opts.state) {
    conditions.push("state = ?");
    params.push(opts.state);
  }
  if (opts.workflowType) {
    conditions.push("workflow_type = ?");
    params.push(opts.workflowType);
  }

  let sql = "SELECT * FROM jobs";
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }
  sql += " ORDER BY created_at DESC";
  if (opts.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }

  return db.prepare(sql).all(...params) as JobRow[];
}

export function getJobEvents(db: Database, jobId: string): JobEventRow[] {
  return db
    .prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC, id ASC")
    .all(jobId) as JobEventRow[];
}

export function claimNextQueuedJob(db: Database): JobRow | null {
  const now = nowIso();
  const candidate = db
    .prepare(
      `SELECT id
       FROM jobs
       WHERE state IN ('queued', 'retryable')
         AND (scheduled_at IS NULL OR scheduled_at <= ?)
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get(now) as { id: string } | null;

  if (!candidate) return null;

  const timestamp = nowIso();
  const result = db
    .prepare(
      `UPDATE jobs
       SET state = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND state IN ('queued', 'retryable')`
    )
    .run(timestamp, timestamp, candidate.id);

  if (result.changes === 0) return null;

  addJobEvent(db, candidate.id, "claimed", { at: timestamp });
  return getJob(db, candidate.id);
}

export function completeJob(db: Database, jobId: string, output?: unknown): boolean {
  const timestamp = nowIso();
  const result = db
    .prepare(
      `UPDATE jobs
       SET state = 'completed', output_json = ?, error_json = NULL,
           completed_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(output === undefined ? null : JSON.stringify(output), timestamp, timestamp, jobId);

  if (result.changes === 0) return false;
  addJobEvent(db, jobId, "completed", output);
  cleanupJobFiles(db, jobId);
  return true;
}

export function failJob(db: Database, jobId: string, error: unknown): boolean {
  const timestamp = nowIso();
  const result = db
    .prepare(
      `UPDATE jobs
       SET state = 'failed', error_json = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(JSON.stringify(error), timestamp, timestamp, jobId);

  if (result.changes === 0) return false;
  addJobEvent(db, jobId, "failed", error);
  cleanupJobFiles(db, jobId);
  return true;
}

export function requestJobApproval(
  db: Database,
  jobId: string,
  payload: unknown,
): boolean {
  const timestamp = nowIso();
  const result = db
    .prepare(
      `UPDATE jobs
       SET state = 'awaiting_approval', requires_approval = 1, updated_at = ?
       WHERE id = ?`
    )
    .run(timestamp, jobId);

  if (result.changes === 0) return false;
  addJobEvent(db, jobId, "approval_requested", payload);
  return true;
}

export function approveJob(
  db: Database,
  jobId: string,
  approvedBy: string | null,
  note?: string | null,
): boolean {
  const timestamp = nowIso();
  const result = db
    .prepare(
      `UPDATE jobs
       SET state = 'queued', requires_approval = 0, approved_by = ?, updated_at = ?
       WHERE id = ? AND state = 'awaiting_approval'`
    )
    .run(approvedBy ?? null, timestamp, jobId);

  if (result.changes === 0) return false;
  addJobEvent(db, jobId, "approved", { approved_by: approvedBy ?? null, note: note ?? null });
  return true;
}

export function cancelJob(db: Database, jobId: string, reason?: string | null): boolean {
  const timestamp = nowIso();
  const result = db
    .prepare(
      `UPDATE jobs
       SET state = 'cancelled', completed_at = ?, updated_at = ?
       WHERE id = ? AND state IN ('queued', 'running', 'awaiting_approval', 'awaiting_classification')`
    )
    .run(timestamp, timestamp, jobId);

  if (result.changes === 0) return false;
  addJobEvent(db, jobId, "cancelled", { reason: reason ?? null });
  cleanupJobFiles(db, jobId);
  return true;
}

export const MAX_RETRIES = parseInt(process.env.MAX_JOB_RETRIES ?? "3", 10);

export function shouldRetry(db: Database, jobId: string): boolean {
  const job = getJob(db, jobId);
  return !!job && job.retry_count < MAX_RETRIES;
}

export function scheduleRetry(db: Database, jobId: string, error: unknown): boolean {
  const job = getJob(db, jobId);
  if (!job) return false;
  const attempt = job.retry_count + 1;
  const delaySec = Math.pow(attempt, 4) * (0.9 + Math.random() * 0.2);
  const scheduledAt = new Date(Date.now() + delaySec * 1000).toISOString();
  const timestamp = nowIso();

  db.prepare(
    `UPDATE jobs
     SET state = 'retryable', retry_count = ?, scheduled_at = ?,
         error_json = ?, completed_at = NULL, updated_at = ?
     WHERE id = ?`
  ).run(attempt, scheduledAt, JSON.stringify(error), timestamp, jobId);

  addJobEvent(db, jobId, "retry_scheduled", {
    attempt,
    scheduled_at: scheduledAt,
    delay_seconds: Math.round(delaySec),
    last_error: error,
  });
  return true;
}

export function parseJobJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Park a running job in awaiting_classification state.
 * Writes a step_started event and transitions the job.
 */
export function requestClassification(
  db: Database,
  jobId: string,
  step: string,
  payload: unknown,
): boolean {
  const timestamp = nowIso();
  const result = db
    .prepare(
      `UPDATE jobs SET state = 'awaiting_classification', updated_at = ? WHERE id = ? AND state = 'running'`
    )
    .run(timestamp, jobId);
  if (result.changes === 0) return false;
  addJobEvent(db, jobId, "step_started", { step, ...((payload as object) ?? {}) });
  return true;
}

/**
 * Submit a classification result for a parked job.
 * Writes step_completed event and transitions back to running.
 * Idempotent: second call for same step is a no-op.
 *
 * Validates the payload against the schema for the named step before
 * persisting it. A malformed payload fails the job with `code:
 * "schema_validation_failed"` instead of corrupting the resume path.
 */
export function submitClassification(
  db: Database,
  jobId: string,
  step: string,
  classificationResult: unknown,
): boolean {
  const job = getJob(db, jobId);
  if (!job) return false;

  // Idempotent: if step already has step_completed, no-op
  const events = getJobEvents(db, jobId);
  const alreadyCompleted = events.some(
    (e) => e.event_type === "step_completed" && JSON.parse(e.payload_json ?? "{}").step === step,
  );
  if (alreadyCompleted) return true;

  // Validate step matches last step_started
  if (job.state !== "awaiting_classification") return false;
  const lastStarted = [...events].reverse().find((e) => e.event_type === "step_started");
  if (!lastStarted) return false;
  const startedPayload = JSON.parse(lastStarted.payload_json ?? "{}");
  if (startedPayload.step !== step) return false;

  // Validate the payload before storing it. A malformed payload from Claude
  // would silently corrupt the resume path otherwise.
  let validated: unknown;
  try {
    validated = validateClassificationByStep(step, classificationResult);
  } catch (err) {
    if (err instanceof WorkflowSchemaError) {
      failJob(db, jobId, {
        code: "schema_validation_failed",
        message: err.message,
        schema: err.schemaName,
        field: err.field,
        step,
      });
      return false;
    }
    throw err;
  }

  const timestamp = nowIso();
  addJobEvent(db, jobId, "step_completed", { step, result: validated });
  // Set to queued so the worker's claimNextQueuedJob picks it up on next tick.
  // The worker reads completed steps and resumes from where it left off.
  db.prepare(`UPDATE jobs SET state = 'queued', updated_at = ? WHERE id = ?`).run(timestamp, jobId);
  return true;
}

// ── Download cleanup ───────────────────────────────────────────────────
//
// Track downloaded files in `file_downloaded` job events so we can clean
// them up deterministically when a job reaches a terminal state. The worker
// is the only thing that creates downloads, so the worker is the only thing
// that needs to know about cleanup.
//
// Cleanup runs after `completeJob`, terminal `failJob`, and `cancelJob`.
// It does NOT run on `retryable`, `awaiting_classification`, or
// `awaiting_approval` because resuming the job needs the file on disk.

/**
 * Record that a file was downloaded for this job. The path should be the
 * absolute file path on disk.
 */
export function recordDownloadedFile(
  db: Database,
  jobId: string,
  filePath: string,
): void {
  addJobEvent(db, jobId, "file_downloaded", { file_path: filePath, at: nowIso() });
}

/**
 * Get the absolute paths of all files downloaded for a given job.
 * Returns paths in insertion order.
 */
export function getDownloadedFiles(db: Database, jobId: string): string[] {
  const events = getJobEvents(db, jobId);
  const out: string[] = [];
  for (const e of events) {
    if (e.event_type !== "file_downloaded") continue;
    try {
      const p = JSON.parse(e.payload_json ?? "{}");
      if (typeof p.file_path === "string" && p.file_path.length > 0) {
        out.push(p.file_path);
      }
    } catch { /* ignore malformed */ }
  }
  return out;
}

/**
 * Delete all files recorded for this job. Logs but does not throw on
 * delete failures (the file may already be gone if a previous cleanup
 * partially completed, or if the OS removed it). Returns the list of
 * paths actually deleted.
 */
export function cleanupJobFiles(
  db: Database,
  jobId: string,
  logger?: { log(message: string): void },
): string[] {
  const paths = getDownloadedFiles(db, jobId);
  const deleted: string[] = [];
  for (const p of paths) {
    try {
      unlinkSync(p);
      deleted.push(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger?.log(`cleanupJobFiles: failed to delete ${p}: ${(err as Error).message}`);
      }
    }
  }
  if (deleted.length > 0) {
    addJobEvent(db, jobId, "files_cleaned", { paths: deleted, count: deleted.length });
  }
  return deleted;
}

/**
 * Sweep the downloads directory and delete any file older than `maxAgeMs`
 * that is NOT referenced by an active (non-terminal) job. Defense in depth
 * for orphans left behind by crashes or aborted runs.
 *
 * Active states: queued, running, retryable, awaiting_classification,
 * awaiting_approval. Terminal states: completed, failed, cancelled.
 */
export function sweepOrphanedDownloads(
  db: Database,
  downloadDir: string,
  maxAgeMs: number,
  logger?: { log(message: string): void },
): { scanned: number; deleted: number; preserved: number } {
  let scanned = 0;
  let deleted = 0;
  let preserved = 0;

  let entries: string[];
  try {
    entries = readdirSync(downloadDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { scanned: 0, deleted: 0, preserved: 0 };
    }
    throw err;
  }

  // Build the set of file paths referenced by any non-terminal job.
  const activeStates = [
    "queued",
    "running",
    "retryable",
    "awaiting_classification",
    "awaiting_approval",
  ];
  const placeholders = activeStates.map(() => "?").join(",");
  const activeJobs = db
    .prepare(
      `SELECT j.id FROM jobs j WHERE j.state IN (${placeholders})`,
    )
    .all(...activeStates) as Array<{ id: string }>;

  const referenced = new Set<string>();
  for (const job of activeJobs) {
    for (const p of getDownloadedFiles(db, job.id)) {
      referenced.add(p);
    }
  }

  const cutoff = Date.now() - maxAgeMs;

  for (const name of entries) {
    const fullPath = join(downloadDir, name);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    scanned++;

    if (referenced.has(fullPath)) {
      preserved++;
      continue;
    }
    if (stat.mtimeMs > cutoff) {
      preserved++;
      continue;
    }
    try {
      unlinkSync(fullPath);
      deleted++;
      logger?.log(`sweep: deleted orphan ${fullPath}`);
    } catch (err) {
      logger?.log(`sweep: failed to delete ${fullPath}: ${(err as Error).message}`);
    }
  }

  return { scanned, deleted, preserved };
}
