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
import { executeInvoiceIntake, executeScanIntake } from "./invoice-worker";
import type { PaperlessFieldRegistry } from "./paperless-fields";
import type { NotifyFn } from "./telegram-notify";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { getTracer, SpanStatusCode, remoteParentContext } from "./tracing";
import type { Span } from "./tracing";
import { getEmailTraceId } from "./db";

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
  channel?: Server,
): Promise<JobRow | null> {
  const job = claimNextQueuedJob(db);
  if (!job) return null;

  // Span name — vendor comes from classification (scan intake input or invoice completed steps)
  const spanName = `workflow.execute_job ${job.workflow_type}`;
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
        case "invoice_intake":
          await executeInvoiceIntake(db, job, logger, registry!, notify, channel);
          break;
        case "scan_intake":
          await executeScanIntake(db, job, logger, registry!, notify, channel);
          break;
        default:
          failJob(db, job.id, {
            code: "unsupported_workflow_type",
            message: `Unsupported workflow type: ${job.workflow_type}`,
          });
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
  const stale = db.prepare(
    `SELECT id FROM jobs
     WHERE state IN ('running', 'awaiting_classification')
       AND updated_at < datetime('now', '-' || ? || ' minutes')`
  ).all(staleMinutes) as { id: string }[];

  for (const { id } of stale) {
    if (shouldRetry(db, id)) {
      scheduleRetry(db, id, { code: "stale_timeout", message: `Job stale for ${staleMinutes}+ minutes` });
      logger.log(`Reclaimed stale job ${id}`);
    } else {
      failJob(db, id, { code: "stale_timeout", message: `Job stale for ${staleMinutes}+ minutes, max retries exhausted` });
      logger.log(`Failed stale job ${id} (max retries)`);
    }
  }
}
