import { Database } from "bun:sqlite";

import { nowIso, randomId, type CreateJobInput, type JobRow, type JobState } from "./schema";
import { addJobEvent } from "./events";
import { cleanupJobFiles } from "./downloads";

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
  // Mirror `output.paperless_document_id` into the indexed column so the
  // dedup service can look up source-email received_at by doc id without
  // parsing output_json on every check (task 59 multi-stage refresh path).
  const docId =
    output && typeof output === "object" &&
    typeof (output as { paperless_document_id?: unknown }).paperless_document_id === "number"
      ? ((output as { paperless_document_id: number }).paperless_document_id)
      : null;
  const result = db
    .prepare(
      `UPDATE jobs
       SET state = 'completed', output_json = ?, error_json = NULL,
           completed_at = ?, updated_at = ?,
           paperless_doc_id = COALESCE(?, paperless_doc_id)
       WHERE id = ?`
    )
    .run(output === undefined ? null : JSON.stringify(output), timestamp, timestamp, docId, jobId);

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

/**
 * Low-level state setter. Most transitions should go through dedicated
 * helpers (completeJob, failJob, approveJob, requestClassification,
 * pauseForGuidance). This exists for state machine plumbing that doesn't
 * yet have a higher-level wrapper.
 */
export function setJobState(db: Database, jobId: string, state: JobState): boolean {
  const timestamp = nowIso();
  const result = db
    .prepare(`UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?`)
    .run(state, timestamp, jobId);
  return result.changes > 0;
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
