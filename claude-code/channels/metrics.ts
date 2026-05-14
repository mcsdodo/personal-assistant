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
