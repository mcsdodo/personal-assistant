import { Database } from "bun:sqlite";

import { validateClassificationByStep, WorkflowSchemaError } from "../workflow-schemas";

import { nowIso } from "./schema";
import { addJobEvent, getJobEvents } from "./events";
import { failJob, getJob } from "./jobs";
import { recordJobFailure } from "../metrics";

/**
 * Park a running job in awaiting_classification state.
 * Writes a step_started event and transitions the job.
 */
export function requestClassification(
  db: Database,
  jobId: string,
  step: string,
  payload: unknown,
): boolean {
  const timestamp = nowIso();
  const result = db
    .prepare(
      `UPDATE jobs SET state = 'awaiting_classification', updated_at = ? WHERE id = ? AND state = 'running'`
    )
    .run(timestamp, jobId);
  if (result.changes === 0) return false;
  addJobEvent(db, jobId, "step_started", { step, ...((payload as object) ?? {}) });
  return true;
}

/**
 * Submit a classification result for a parked job.
 * Writes step_completed event and transitions back to running.
 * Idempotent: second call for same step is a no-op.
 *
 * Validates the payload against the schema for the named step before
 * persisting it. A malformed payload fails the job with `code:
 * "schema_validation_failed"` instead of corrupting the resume path.
 */
export function submitClassification(
  db: Database,
  jobId: string,
  step: string,
  classificationResult: unknown,
): boolean {
  const job = getJob(db, jobId);
  if (!job) return false;

  // Idempotent: if step already has step_completed, no-op
  const events = getJobEvents(db, jobId);
  const alreadyCompleted = events.some(
    (e) => e.event_type === "step_completed" && JSON.parse(e.payload_json ?? "{}").step === step,
  );
  if (alreadyCompleted) return true;

  // Validate step matches last step_started
  if (job.state !== "awaiting_classification") return false;
  const lastStarted = [...events].reverse().find((e) => e.event_type === "step_started");
  if (!lastStarted) return false;
  const startedPayload = JSON.parse(lastStarted.payload_json ?? "{}");
  if (startedPayload.step !== step) return false;

  // For classify_email, the schema requires `sender`, `subject`, and
  // `received_at` — but these are NOT classifier output. They're structural
  // metadata that the watcher writes into `input_json` at job-creation time.
  // Merge them into Claude's classification result here, BEFORE validation,
  // so the schema can validate the merged result. Watcher-injected fields
  // override anything Claude may have included (defensive against rolling
  // upgrades; normally Claude won't include these at all). For manual jobs
  // where `input_json` lacks the metadata, the merged values will be null
  // and downstream code (`extractInvoiceLinks`, etc.) handles the null path.
  // See _tasks/_done/47-pipeline-hardening-followups/ Issue 1.
  let mergedResult: unknown = classificationResult;
  if (step === "classify_email") {
    let inputMeta: Record<string, unknown> = {};
    if (job.input_json) {
      try {
        const parsed = JSON.parse(job.input_json);
        if (parsed && typeof parsed === "object") {
          inputMeta = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed input_json — proceed with empty inputMeta. Schema
        // validation will surface a clear error if Claude also didn't
        // provide the fields.
      }
    }
    const claudeObj = (classificationResult && typeof classificationResult === "object")
      ? (classificationResult as Record<string, unknown>)
      : {};
    // Watcher-injected fields take precedence WHEN PRESENT in input_json
    // (even if explicitly null — the watcher writes null when the source MCP
    // didn't return a sender, and that null is the source of truth). When
    // the watcher didn't write the field at all (manual jobs from the legacy
    // input_json shape), fall back to whatever Claude returned. Final null
    // fallback if neither provided.
    const pickField = (key: string) =>
      key in inputMeta ? (inputMeta[key] ?? null) : (claudeObj[key] ?? null);
    mergedResult = {
      ...claudeObj,
      sender: pickField("sender"),
      subject: pickField("subject"),
      received_at: pickField("received_at"),
    };
  }

  // Validate the payload before storing it. A malformed payload from Claude
  // would silently corrupt the resume path otherwise.
  // On the scan path the owner is folder-authoritative (executeScanIntake uses
  // input.owner and ignores the classifier owner). So a flaky null
  // owner_match_evidence from the document-classifier must not fail a scan job
  // (task 96-fix). ownerEvidenceOptional defaults to false, preserving the
  // email-path hard-fail (task 83) for all other workflow types.
  let validated: unknown;
  try {
    validated = validateClassificationByStep(step, mergedResult, {
      ownerEvidenceOptional: job.workflow_type === "scan_intake",
    });
  } catch (err) {
    if (err instanceof WorkflowSchemaError) {
      failJob(db, jobId, {
        code: "schema_validation_failed",
        message: err.message,
        schema: err.schemaName,
        field: err.field,
        step,
      });
      recordJobFailure("schema_validation_failed", job.workflow_type);
      return false;
    }
    throw err;
  }

  const timestamp = nowIso();
  addJobEvent(db, jobId, "step_completed", { step, result: validated });
  // Set to queued so the worker's claimNextQueuedJob picks it up on next tick.
  // The worker reads completed steps and resumes from where it left off.
  db.prepare(`UPDATE jobs SET state = 'queued', updated_at = ? WHERE id = ?`).run(timestamp, jobId);
  return true;
}
