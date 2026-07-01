import { getMeter } from "./tracing";

const workflowMeter = getMeter("workflow");

/**
 * Counter for jobs paused in `awaiting_user_guidance`, labelled by trigger reason
 * (classifier_unknown, encrypted_pdf, ...). Incremented by pauseAndNotify in
 * invoice/intake-worker.ts. The Grafana panel reads this as a stacked bar (panel id 41).
 *
 * Metric name is stable — changing it would break existing Grafana dashboards.
 */
export const guidanceRequestsTotal = workflowMeter.createCounter(
  "personal_assistant_guidance_requests_total",
  { description: "Job pauses for user guidance, by trigger reason" },
);

/**
 * Terminal job failures by `reason` (the failJob code) and `workflow_type`.
 * Incremented at every terminal failJob site across the worker — intake-worker
 * (invalid_input/schema_validation_failed/missing_owner/invoice_intake_error/
 * scan_intake_error) AND the dispatcher/classification/timeout paths
 * (unsupported_workflow_type/worker_exception/stale_timeout/timed_out). NOT
 * incremented for intentional user cancels (/fail → user_cancelled) or the
 * synthetic test path. Zero-seeded so the pa-job-failed alert never NoData-fires
 * before the first failure.
 */
export const jobFailedCounter = workflowMeter.createCounter("invoice_worker_failed_total", {
  description: "Terminal job failures by reason (failJob code) and workflow_type",
});

const FAILED_REASONS = [
  "invalid_input", "schema_validation_failed", "missing_owner",
  "invoice_intake_error", "scan_intake_error",
  "unsupported_workflow_type", "worker_exception", "stale_timeout", "timed_out",
] as const;
for (const workflow_type of ["invoice_intake", "scan_intake"] as const) {
  for (const reason of FAILED_REASONS) {
    jobFailedCounter.add(0, { reason, workflow_type });
  }
}

/** failJob + failure-metric increment. reason = the failJob `code`. */
export function recordJobFailure(reason: string, workflow_type: string): void {
  jobFailedCounter.add(1, { reason, workflow_type });
}
