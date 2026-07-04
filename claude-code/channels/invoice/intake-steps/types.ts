/**
 * Intake pipeline type definitions.
 *
 * Extracted from intake-worker.ts as part of Phase 2 decomposition (task 102).
 */

import type {
  DownloadedFile as ServiceDownloadedFile,
} from "../download-service";

export type DownloadStrategy =
  | "attachment"
  | "known_link"
  | "direct_url"
  | "browser_required"
  | "manual_review"
  | "claude_download";


/** Classification fields produced by the email-classifier + document-classifier channel roundtrips.
 *  Stored in step_completed events, read back via getCompletedSteps. */
export interface InvoiceClassification {
  should_file: boolean;
  confidence: "high" | "medium" | "low";
  /** Null when action=ignore — the classifier has no counterparty for non-invoices. */
  vendor: string | null;
  doc_type: string;
  is_fuel: boolean;
  owner?: "business" | "personal";
  action: string;
  download_strategy: DownloadStrategy | null;
  /** Null when action=ignore — no strategy to have confidence in. */
  strategy_confidence: "high" | "medium" | "low" | null;
  requires_review: boolean;
  order_id: string | null;
  subtitle: string | null;
  total_amount: number | null;
  currency: string | null;
  /**
   * Email subject — worker-injected from input_json by submitClassification
   * before validation. Null for manual jobs that lacked the metadata.
   * Used for month_tag inference and title generation; downstream null-safe.
   */
  subject: string | null;
  /**
   * Email received timestamp ISO — worker-injected from input_json. Null
   * for manual jobs. Used as a month_tag fallback; downstream null-safe.
   */
  received_at: string | null;
  /**
   * Email sender — worker-injected from input_json. Null for manual jobs.
   * Used for vendor-specific link extraction rules; extractInvoiceLinks
   * gracefully degrades when null.
   */
  sender: string | null;
  /** Accountant intent-skip marker, set by the email-classifier for accountant
   *  senders only (action="ignore"). query | payslip | payment_order | close | other.
   *  Null/absent for every other email. */
  skip_reason?: string | null;
}

export interface ScanIntakeInput {
  source: "gdrive";
  file_id: string;
  /** Human-readable label only (e.g. "techlab/accounting"). Owner/bucket are
   *  carried explicitly below; this is for audit/display, no longer parsed. */
  watch_folder: string;
  /** YYYY-MM tag from scan date — fallback if document classifier has no doc_date */
  month_tag: string;
  /** Owner ROLE resolved by the poller (task 96). Drives tags + storage path. */
  owner: "business" | "personal";
  /** Bucket resolved by the poller — drives accounting tag + content override. */
  bucket: "accounting" | "documents";
  /** Resolved Drive folder ID of the bucket folder — the move parent (B2 fix). */
  folder_id: string;
  /** Original filename from GDrive (for title fallback) */
  filename?: string;
  /** Path to pre-downloaded file on disk (worker reads instead of downloading from GDrive) */
  file_path?: string;
  /** Force reprocess: if dedup finds an existing Paperless doc, PATCH it in place
   *  instead of short-circuiting. Set by `create_scan_intake_job(force=true)`. */
  force?: boolean;
}

/** Classification fields produced by the document-classifier for scan intake.
 *  Stored in step_completed event, read back via getCompletedSteps. */
export interface ScanClassification {
  doc_type: string;
  vendor: string;
  total_amount: number | null;
  currency: string | null;
  is_fuel: boolean;
  owner?: "business" | "personal";
  confidence: string;
  order_id: string | null;
  subtitle: string | null;
  doc_date: string | null;
  /** Slovak "deň dodania" — legal tax point per § 19 Zákon 222/2004. Optional. */
  supply_date?: string | null;
  /** ISO 8601 interval for subscriptions/billing periods, "YYYY-MM-DD/YYYY-MM-DD". Optional. */
  service_period?: string | null;
  /** LLM's reasoned accounting-period decision, "YYYY-MM". Preferred over date inference. Optional. */
  accounting_period?: string | null;
  /** Short reasoning string explaining the accounting_period choice. Optional. */
  accounting_period_reasoning?: string | null;
  /** Free-form classifier notes; required when any UNKNOWN_CAPABLE field is "unknown". */
  notes?: string | null;
  /** Fuel volume in litres; only set when is_fuel: true. */
  litres?: number | null;
  /** Receipt timestamp ("YYYY-MM-DDTHH:MM:SS"); null/missing when not extractable. */
  receipt_datetime?: string | null;
}

export interface InvoiceIntakeResult {
  outcome: "uploaded" | "refreshed" | "duplicate" | "duplicate_likely" | "paused" | "failed";
  title?: string;
  paperless_document_id?: number;
  correspondent?: string;
  tags?: string[];
  total_amount?: number | null;
  duplicate_of?: number;
  duplicate_message?: string;
  error?: string;
}

// `DownloadedFile` is owned by the download service so the worker, the
// service, and any future caller share one shape.
export type DownloadedFile = ServiceDownloadedFile;

export interface WorkerLogger {
  log(message: string): void;
}
