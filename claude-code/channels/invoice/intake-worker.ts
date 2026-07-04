/**
 * Invoice/scan intake pipeline orchestrator — public barrel.
 *
 * Drives the full processing pipeline deterministically:
 *
 * invoice_intake (email):
 *   classify_email (park→channel) → action gate → download → classify_document
 *   (park→channel) → merge → month_tag → correspondent → dedup → tags →
 *   doc type → storage path → upload → custom fields → notify
 *
 * scan_intake (GDrive):
 *   download → classify_document (park→channel) → month_tag → correspondent →
 *   dedup → tags → doc type → storage path → upload → custom fields →
 *   move file → notify
 *
 * Classification steps park the job (awaiting_classification) and push a
 * channel notification to Claude. Claude runs a haiku subagent and calls
 * submit_classification() to resume. Step results are cached in job_events
 * for resume on retry.
 *
 * The two executors live in `./invoice-intake.ts` and `./scan-intake.ts`;
 * this file only re-exports the stable public surface (task 102, phase 2).
 */

export { executeInvoiceIntake } from "./invoice-intake";
export { executeScanIntake } from "./scan-intake";
export type {
  DownloadStrategy,
  InvoiceClassification,
  ScanIntakeInput,
  ScanClassification,
  InvoiceIntakeResult,
} from "./intake-steps/types";
