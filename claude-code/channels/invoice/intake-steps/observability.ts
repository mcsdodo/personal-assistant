/**
 * Observability instrumentation for intake pipeline (metrics + tracing).
 *
 * Extracted from intake-worker.ts as part of Phase 2 decomposition (task 102).
 */

import { getTracer, getMeter, type Tracer } from "../../tracing";
import type { Span } from "../../tracing";
import { TraceFlags, context, trace } from "@opentelemetry/api";
import { recordJobFailure } from "../../metrics";
import {
  failJob,
  getJobEvents,
  type JobEventRow,
  type JobRow,
  addJobEvent,
} from "../../workflow-db";
import type { Database } from "bun:sqlite";

const tracer = getTracer("invoice-worker");
const meter = getMeter("invoice-worker");
const correspondentsCounter = meter.createCounter("invoice_worker_correspondents_total", {
  description: "Completed invoices by normalized Paperless correspondent",
});
const missingMonthTagCounter = meter.createCounter("invoice_worker_missing_month_tag_total", {
  description: "Documents uploaded without a valid YYYY-MM accounting period (operator must tag manually)",
});
const sampleSkippedCounter = meter.createCounter("invoice_worker_sample_skipped_total", {
  description: "Sample/preview (non-tax-document) invoices detected and skipped before Paperless upload, by vendor",
});
const accountantSkippedCounter = meter.createCounter("invoice_worker_accountant_skipped_total", {
  description: "Accountant non-invoice emails (questions, payslips, payment orders, close) skipped before upload, by reason",
});
const ACCOUNTANT_SKIP_REASONS = ["query", "payslip", "payment_order", "close", "other"] as const;

/**
 * failJob + failure-metric increment. Use this at every terminal-failure site.
 * Retryable paths call scheduleRetry (not failJob) and must NOT be metered.
 */
function failJobMetered(
  db: Database,
  jobId: string,
  payload: { code: string; message: string; [k: string]: unknown },
  workflow_type: "invoice_intake" | "scan_intake",
): void {
  failJob(db, jobId, payload);
  recordJobFailure(payload.code, workflow_type);
}

// ── Classification-wait sentinel span ─────────────────────────────────
//
// The ~60s gap while a job is parked for Claude classification is invisible
// in traces. emitSentinelSpan closes that gap retroactively at resume time
// by reading the stored traceId/spanId/startMs from the classification_request_meta
// event and emitting a child span with the stored start time.
function emitSentinelSpan(
  tracer: Tracer,
  events: ReturnType<typeof getJobEvents>,
  step: "classify_email" | "classify_document",
): void {
  const meta = events.find(
    (e) =>
      e.event_type === "classification_request_meta" &&
      (JSON.parse(e.payload_json ?? "{}")?.step as string) === step,
  );
  if (!meta) return;
  const d = JSON.parse(meta.payload_json ?? "{}") as Record<string, unknown>;
  const traceId = d["sentinel_trace_id"] as string | undefined;
  const parentSpanId = d["sentinel_parent_span_id"] as string | undefined;
  // sentinel_start_ms is serialized as a string in the channel meta (Claude
  // Code's channel protocol rejects non-string meta values — task 98 regression).
  const rawStartMs = d["sentinel_start_ms"];
  const startMs = rawStartMs !== undefined ? Number(rawStartMs) : undefined;
  if (!traceId || !parentSpanId || !startMs || Number.isNaN(startMs)) return;

  const ctx = trace.setSpanContext(context.active(), {
    traceId,
    spanId: parentSpanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
  context.with(ctx, () => {
    const s = tracer.startSpan("classification-wait", {
      startTime: startMs,
      attributes: { "classification.step": step },
    });
    s.end(); // end=now → duration = now − park time (the classification wait)
  });
}

let counterSeeded = false;
function seedCounterFromDb(db: Database): void {
  if (counterSeeded) return;
  counterSeeded = true;
  try {
    const rows = db.query(
      `SELECT json_extract(output_json, '$.correspondent') AS correspondent, COUNT(*) AS count
       FROM jobs
       WHERE state = 'completed'
         AND json_extract(output_json, '$.correspondent') IS NOT NULL
       GROUP BY correspondent`
    ).all() as Array<{ correspondent: string; count: number }>;
    for (const row of rows) {
      correspondentsCounter.add(row.count, { correspondent: row.correspondent });
    }
  } catch {}
}

export {
  tracer,
  meter,
  correspondentsCounter,
  missingMonthTagCounter,
  sampleSkippedCounter,
  accountantSkippedCounter,
  ACCOUNTANT_SKIP_REASONS,
  failJobMetered,
  emitSentinelSpan,
  seedCounterFromDb,
};
