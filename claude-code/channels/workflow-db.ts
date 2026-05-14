/**
 * Back-compat barrel.
 *
 * The workflow.db SQLite layer used to live in this single 767-line file.
 * Task 79 §4.2 split it into focused submodules under `./workflow/`:
 *
 *  - workflow/schema.ts        — SCHEMA + openWorkflowDb + migrations
 *  - workflow/jobs.ts          — createJob/getJob/listJobs/lifecycle
 *  - workflow/events.ts        — addJobEvent/getJobEvents/parseJobJson
 *  - workflow/classification.ts — requestClassification/submitClassification
 *  - workflow/guidance.ts      — pauseForGuidance + GuidanceRequestPayload
 *  - workflow/downloads.ts     — file recording + cleanup + sweep
 *  - workflow/queries.ts       — cross-cutting reads (received_at, doc_id)
 *
 * Existing callers import from `"./workflow-db"` or `"../workflow-db"` and
 * continue to work unchanged via the re-exports below. New code should
 * prefer the submodule paths directly.
 */

export type {
  JobState,
  CreateJobInput,
  JobRow,
  JobEventRow,
} from "./workflow/schema";
export { openWorkflowDb } from "./workflow/schema";

export {
  addJobEvent,
  getJobEvents,
  parseJobJson,
} from "./workflow/events";

export {
  getLatestReceivedAtForDoc,
  getPaperlessDocIdForSource,
} from "./workflow/queries";

export {
  getJob,
  getJobByIdempotencyKey,
  createJob,
  listJobs,
  claimNextQueuedJob,
  completeJob,
  failJob,
  requestJobApproval,
  approveJob,
  setJobState,
  cancelJob,
  shouldRetry,
  scheduleRetry,
  MAX_RETRIES,
} from "./workflow/jobs";

export {
  recordDownloadedFile,
  getDownloadedFiles,
  cleanupJobFiles,
  sweepOrphanedDownloads,
} from "./workflow/downloads";

export type { GuidanceRequestPayload } from "./workflow/guidance";
export { pauseForGuidance } from "./workflow/guidance";

export {
  requestClassification,
  submitClassification,
} from "./workflow/classification";
