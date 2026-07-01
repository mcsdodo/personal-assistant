import type { Database } from "bun:sqlite";

import {
  addJobEvent,
  claimNextQueuedJob,
  completeJob,
  failJob,
  getJob,
  MAX_RETRIES,
  parseJobJson,
  requestJobApproval,
  scheduleRetry,
  shouldRetry,
  type JobRow,
} from "./workflow-db";
import { executeInvoiceIntake, executeScanIntake } from "./invoice/intake-worker";
import { recordJobFailure } from "./metrics";
import { createPaperlessAdapter } from "./paperless-adapter";
import type { PaperlessFieldRegistry } from "./paperless-fields";
import type { NotifyFn } from "./telegram-notify";

import { getTracer, SpanStatusCode, remoteParentContext } from "./tracing";
import type { Span } from "./tracing";
/** Inlined from ./db (removed in task 62/task 8). */
function getEmailTraceId(db: import("bun:sqlite").Database, emailId: string): string | null {
  const row = db
    .prepare("SELECT trace_id FROM emails WHERE id = ? LIMIT 1")
    .get(emailId) as { trace_id: string | null } | null;
  return row?.trace_id ?? null;
}

const tracer = getTracer("workflow");

const EMAIL_DB_PATH = process.env.DB_PATH ?? "/data/email-watcher/emails.db";

export interface WorkflowLogger {
  log(message: string): void;
}

interface SyntheticInput {
  mode?: "success" | "fail" | "needs_approval";
  result?: unknown;
  error?: string;
  approval_reason?: string;
}

function executeSyntheticJob(db: Database, job: JobRow, logger: WorkflowLogger): void {
  const input = parseJobJson<SyntheticInput>(job.input_json) ?? {};
  const mode = input.mode ?? "success";

  addJobEvent(db, job.id, "synthetic_started", { mode });

  if (mode === "needs_approval" && !job.approved_by) {
    requestJobApproval(db, job.id, {
      reason: input.approval_reason ?? "Synthetic job requires approval before completion",
    });
    logger.log(`Job ${job.id} awaiting approval`);
    return;
  }

  if (mode === "fail") {
    failJob(db, job.id, {
      code: "synthetic_failure",
      message: input.error ?? "Synthetic workflow requested failure",
    });
    logger.log(`Job ${job.id} failed synthetically`);
    return;
  }

  completeJob(db, job.id, {
    mode,
    result: input.result ?? "ok",
  });
  logger.log(`Job ${job.id} completed synthetically`);
}

/**
 * Resolve the parent trace context for a job.
 * Uses the trace_id stored directly on the job (set by watchers at job creation).
 * Falls back to email DB lookup for jobs created before the trace_id column existed.
 */
function resolveJobTraceParent(job: JobRow) {
  // Prefer trace_id stored directly on the job
  if (job.trace_id) return remoteParentContext(job.trace_id);

  // Fallback: look up trace from email DB (legacy path for workflow-mcp-created jobs)
  const sourceRef = job.source_ref;
  if (!sourceRef) return undefined;
  const colonIdx = sourceRef.indexOf(":");
  if (colonIdx < 0) return undefined;
  const messageId = sourceRef.slice(colonIdx + 1);

  try {
    const { Database: BunDb } = require("bun:sqlite");
    const emailDb = new BunDb(EMAIL_DB_PATH, { readonly: true });
    const traceId = getEmailTraceId(emailDb, messageId);
    emailDb.close();
    if (traceId) return remoteParentContext(traceId);
  } catch {
    // Email DB not available — no parent trace
  }
  return undefined;
}

export async function executeNextJob(
  db: Database,
  logger: WorkflowLogger,
  registry?: PaperlessFieldRegistry,
  notify?: NotifyFn,
): Promise<JobRow | null> {
  const job = claimNextQueuedJob(db);
  if (!job) return null;

  const spanName = `workflow.execute_job`;
  const spanOpts = { attributes: { "job.id": job.id, "job.type": job.workflow_type, "job.retry_attempt": job.retry_count } };

  // Try to link to the watcher trace via job.trace_id (or email DB fallback)
  const parentCtx = resolveJobTraceParent(job);

  // Use 4-arg form with parent context if available, otherwise 3-arg form
  const spanFn = async (span: Span) => {
    logger.log(`Claimed job ${job.id} (${job.workflow_type})`);

    try {
      switch (job.workflow_type) {
        case "synthetic":
          executeSyntheticJob(db, job, logger);
          break;
        case "invoice_intake": {
          // Build the Paperless adapter once per executor invocation. The
          // executors thread this same instance into every postprocess-service
          // / dedup-service / paperless-adapter call site — the lazy singleton
          // it replaces existed only to bridge the registry-per-call API to
          // the stateless executor body. Construction is cheap (no I/O).
          const adapter = createPaperlessAdapter(registry!);
          await executeInvoiceIntake(db, job, logger, registry!, adapter, notify);
          break;
        }
        case "scan_intake": {
          const adapter = createPaperlessAdapter(registry!);
          await executeScanIntake(db, job, logger, registry!, adapter, notify);
          break;
        }
        default:
          failJob(db, job.id, {
            code: "unsupported_workflow_type",
            message: `Unsupported workflow type: ${job.workflow_type}`,
          });
          recordJobFailure("unsupported_workflow_type", job.workflow_type);
          logger.log(`Job ${job.id} failed: unsupported workflow type`);
          break;
      }
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      const errPayload = {
        code: "worker_exception",
        message: error instanceof Error ? error.message : String(error),
      };
      if (shouldRetry(db, job.id)) {
        scheduleRetry(db, job.id, errPayload);
        const updated = getJob(db, job.id);
        logger.log(`Job ${job.id} scheduled for retry (attempt ${updated?.retry_count})`);
      } else {
        failJob(db, job.id, errPayload);
        recordJobFailure("worker_exception", job.workflow_type);
        logger.log(`Job ${job.id} failed permanently after ${MAX_RETRIES} attempts`);
      }
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
    } finally {
      span.end();
    }

    return job;
  };

  if (parentCtx) {
    return tracer.startActiveSpan(spanName, spanOpts, parentCtx, spanFn);
  }
  return tracer.startActiveSpan(spanName, spanOpts, spanFn);
}

/**
 * Scan for stale running/awaiting_classification jobs and reclaim or fail them.
 * Called on every worker tick alongside executeNextJob.
 */
export function reclaimStaleJobs(db: Database, logger: WorkflowLogger): void {
  const staleMinutes = parseInt(process.env.STALE_JOB_MINUTES ?? "5", 10);
  // updated_at is wrapped in datetime() to normalize both ISO 8601 (T/Z, written
  // by nowIso()) and space-separated (schema default) formats to a single
  // canonical form before lexicographic comparison. Without this, same-date ISO
  // timestamps ('2026-04-11T...') always sort greater than space-form cutoffs
  // ('2026-04-11 ...') and the query never matches any row code has ever updated.
  const stale = db.prepare(
    `SELECT id, workflow_type FROM jobs
     WHERE state IN ('running', 'awaiting_classification')
       AND datetime(updated_at) < datetime('now', '-' || ? || ' minutes')`
  ).all(staleMinutes) as { id: string; workflow_type: string }[];

  for (const { id, workflow_type } of stale) {
    if (shouldRetry(db, id)) {
      scheduleRetry(db, id, { code: "stale_timeout", message: `Job stale for ${staleMinutes}+ minutes` });
      logger.log(`Reclaimed stale job ${id}`);
    } else {
      failJob(db, id, { code: "stale_timeout", message: `Job stale for ${staleMinutes}+ minutes, max retries exhausted` });
      recordJobFailure("stale_timeout", workflow_type);
      logger.log(`Failed stale job ${id} (max retries)`);
    }
  }
}
