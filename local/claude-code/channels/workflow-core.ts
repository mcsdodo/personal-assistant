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

import { getTracer, SpanStatusCode } from "./tracing";
import type { Span } from "./tracing";

const tracer = getTracer("workflow");

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

export async function executeNextJob(
  db: Database,
  logger: WorkflowLogger,
  registry: PaperlessFieldRegistry,
): Promise<JobRow | null> {
  const job = claimNextQueuedJob(db);
  if (!job) return null;

  return tracer.startActiveSpan("workflow.execute_job", {
    attributes: {
      "job.id": job.id,
      "job.type": job.workflow_type,
    },
  }, async (span: Span) => {
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
  });
}
