import type { Database } from "bun:sqlite";

import {
  addJobEvent,
  claimNextQueuedJob,
  completeJob,
  failJob,
  parseJobJson,
  requestJobApproval,
  type JobRow,
} from "./workflow-db";
import { executeInvoiceIntake, executeScanIntake } from "./invoice-worker";
import type { PaperlessFieldRegistry } from "./paperless-fields";

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
 * Look up the trace_id from the email DB for a given source_ref.
 * Returns a parent context to continue the email-watcher trace, or undefined.
 */
function resolveEmailTraceParent(sourceRef: string | null) {
  if (!sourceRef) return undefined;
  const colonIdx = sourceRef.indexOf(":");
  if (colonIdx < 0) return undefined;
  const messageId = sourceRef.slice(colonIdx + 1);

  try {
    // Open email DB read-only to look up the trace_id stored by email-watcher
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
  registry: PaperlessFieldRegistry,
): Promise<JobRow | null> {
  const job = claimNextQueuedJob(db);
  if (!job) return null;

  const spanOpts = { attributes: { "job.id": job.id, "job.type": job.workflow_type } };

  // Try to link to the email-watcher trace via the email DB
  const parentCtx = resolveEmailTraceParent(job.source_ref);

  // Use 4-arg form with parent context if available, otherwise 3-arg form
  const spanFn = async (span: Span) => {
    logger.log(`Claimed job ${job.id} (${job.workflow_type})`);

    try {
      switch (job.workflow_type) {
        case "synthetic":
          executeSyntheticJob(db, job, logger);
          break;
        case "invoice_intake":
          await executeInvoiceIntake(db, job, logger, registry);
          break;
        case "scan_intake":
          await executeScanIntake(db, job, logger, registry);
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
      failJob(db, job.id, {
        code: "worker_exception",
        message: error instanceof Error ? error.message : String(error),
      });
      logger.log(`Job ${job.id} crashed during execution`);
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
    return tracer.startActiveSpan("workflow.execute_job", spanOpts, parentCtx, spanFn);
  }
  return tracer.startActiveSpan("workflow.execute_job", spanOpts, spanFn);
}
