/**
 * Classification state helpers for the invoice/scan worker.
 *
 * The worker requests email/document classification from Claude via channel
 * notifications. While Claude runs the haiku subagent, the job parks in
 * `awaiting_classification`. When `submitClassification` arrives, the worker
 * resumes from where it left off.
 *
 * After task 64, the worker runs in pa-worker (no live Claude channel), so
 * the channel push happens entirely on the workflow-mcp side — this module
 * only writes the breadcrumb (`classification_request_meta` job event) and
 * transitions the job state. workflow-mcp's `pushPendingClassifications`
 * polls for breadcrumbs and emits the channel notification with the meta.
 */

import type { Database } from "bun:sqlite";

import { addJobEvent, requestClassification } from "../workflow-db";

export interface ClassificationRequestParams {
  /** Step name written into requestClassification + the channel meta. */
  step: "classify_email" | "classify_document";
  /** Payload stored on the parked job's step_started event. */
  parkedPayload: Record<string, unknown>;
  /** Channel notification meta — the worker reads `event_type` and `job_id`. */
  notificationMeta: Record<string, unknown>;
}

export interface ClassificationStateLogger {
  log(message: string): void;
}

/**
 * Park the job for classification and write the breadcrumb event that
 * workflow-mcp's push loop will replay as a channel notification.
 *
 * Sequence:
 *   1. requestClassification → state=`awaiting_classification`, step_started event.
 *   2. addJobEvent(`classification_request_meta`) → breadcrumb for the push loop.
 *
 * Returns nothing; the orchestrator should immediately return after
 * calling this so the job stays parked until Claude responds.
 */
export async function parkForClassification(
  db: Database,
  jobId: string,
  params: ClassificationRequestParams,
  logger: ClassificationStateLogger,
): Promise<void> {
  requestClassification(db, jobId, params.step, params.parkedPayload);
  addJobEvent(db, jobId, "classification_request_meta", params.notificationMeta);
  logger.log(`Job ${jobId} parked for ${params.step}`);
}
