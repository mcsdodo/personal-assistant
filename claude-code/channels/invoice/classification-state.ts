/**
 * Classification state helpers for the invoice/scan worker.
 *
 * The worker requests email/document classification from Claude via channel
 * notifications. While Claude runs the haiku subagent, the job parks in
 * `awaiting_classification`. When `submitClassification` arrives, the worker
 * resumes from where it left off.
 *
 * This module owns the small but error-prone boilerplate around that:
 *
 *  - building and pushing the channel notification with the right meta
 *  - calling requestClassification (which transitions the job state)
 *  - returning a uniform "parked" signal so the orchestrator can early-return
 *
 * The cache *check* (getCompletedSteps) and the *use* of the cached value
 * stay in the orchestrator — they're a single line each and pulling them out
 * would obscure the resume flow.
 */

import type { Database } from "bun:sqlite";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { addJobEvent, requestClassification } from "../workflow-db";

export interface ClassificationRequestParams {
  /** Step name written into requestClassification + the channel meta. */
  step: "classify_email" | "classify_document";
  /** Payload stored on the parked job's step_started event. */
  parkedPayload: Record<string, unknown>;
  /** Optional MCP channel server (omitted in tests that don't exercise notifications). */
  channel?: Server;
  /** Channel notification body content shown to Claude. */
  notificationContent: string;
  /** Channel notification meta — the worker reads `event_type` and `job_id`. */
  notificationMeta: Record<string, unknown>;
}

export interface ClassificationStateLogger {
  log(message: string): void;
}

/**
 * Park the job for classification and push the channel notification.
 *
 * Sequence:
 *   1. requestClassification(db, jobId, step, parkedPayload)
 *      → transitions the job to `awaiting_classification` and writes
 *        a `step_started` event with the parked payload.
 *   2. channel.notification({...}) — pushes the request to Claude.
 *   3. logger.log + return.
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
  // Breadcrumb so workflow-mcp can replay channel notifications written by
  // the soon-to-be-extracted pa-worker container, which has no MCP server
  // attached to a live Claude session. Backwards-compatible — existing
  // channel push path still emits the notification below; the dedupe lives
  // on the workflow-mcp side via a `classification_pushed` event.
  addJobEvent(db, jobId, "classification_request_meta", params.notificationMeta);
  if (params.channel) {
    await params.channel.notification({
      method: "notifications/claude/channel",
      params: {
        content: params.notificationContent,
        meta: params.notificationMeta,
      },
    });
  }
  logger.log(`Job ${jobId} parked for ${params.step}`);
}
