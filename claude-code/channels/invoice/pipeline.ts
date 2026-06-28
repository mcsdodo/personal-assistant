/**
 * Pipeline functions extracted from invoice-worker.ts.
 *
 * Pure deterministic functions + step resume helper.
 *
 * These are deterministic, side-effect-free functions for:
 * - Classification merging (email + document classifier results)
 * - Month tag inference from classifier reasoning + dates + subject regex
 * - Tag name resolution from classification metadata
 * - Title generation from vendor + metadata
 *
 * Month tag resolution philosophy: the document-classifier (LLM with PDF
 * vision) is the authoritative decision-maker — it returns `accounting_period`
 * after reasoning about supply date, service period, doc type, and Slovak VAT
 * rules. The deterministic chain in `resolveMonthTag` is a hardened *safety
 * net*, not the primary logic. Subject regex is the last resort before
 * falling back to scan/email arrival dates, with negative lookarounds to
 * avoid matching numeric IDs like `#2940-6120-5985`.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface EmailClassification {
  vendor: string | null;
  total_amount: number | null;
  owner: string | null;
  doc_type: string | null;
  confidence: "high" | "medium" | "low" | null;
  is_fuel: boolean;
  order_id?: string | null;
  subtitle?: string | null;
  currency?: string | null;
}

/**
 * Document-classifier-only fields that are NOT part of EmailClassification.
 * mergeClassifications carries these forward from the doc result so that
 * downstream code can read them without Record<string, unknown> casts.
 */
export interface DocumentClassificationFields {
  /** Issue date as printed on the document ("YYYY-MM-DD" or "unknown"). */
  doc_date?: string | null;
  /** Slovak "deň dodania" — legal tax point per § 19 Zákon 222/2004. */
  supply_date?: string | null;
  /** ISO 8601 interval for subscriptions ("YYYY-MM-DD/YYYY-MM-DD"). */
  service_period?: string | null;
  /** LLM's reasoned accounting-period decision ("YYYY-MM"). */
  accounting_period?: string | null;
  /** Short reasoning string explaining the accounting_period choice. */
  accounting_period_reasoning?: string | null;
  /** Free-form classifier notes; required when any UNKNOWN_CAPABLE field is "unknown". */
  notes?: string | null;
  /** Fuel volume in litres; only set when is_fuel: true. */
  litres?: number | null;
  /** Receipt timestamp ("YYYY-MM-DDTHH:MM:SS"); null/missing when not extractable. */
  receipt_datetime?: string | null;
}

/** Inputs for {@link resolveMonthTag}. All fields optional — chain walks them in priority order. */
export interface MonthTagInputs {
  /** LLM's final answer from document-classifier — preferred when present and valid. */
  accountingPeriod?: string | null;
  /** Slovak "deň dodania" / "dátum dodania" — the legal tax point per § 19 Zákon 222/2004. */
  supplyDate?: string | null;
  /** Service-period start (subscription invoices, "Apr 6 – May 6, 2026" → "2026-04-06"). */
  servicePeriodStart?: string | null;
  /** Issue date as printed on the document. */
  docDate?: string | null;
  /** Email subject — last-resort scan with hardened regex. */
  subject?: string | null;
  /** Email received timestamp ISO. */
  receivedAt?: string | null;
  /** GDrive scan creation date as YYYY-MM — only used for the scan pipeline as final fallback. */
  scanFallback?: string | null;
}

// ── mergeClassifications ────────────────────────────────────────────────

/**
 * Merge document-classifier results on top of email-classifier results.
 * Non-null doc values override email values; null/undefined doc values
 * are ignored (email values preserved).
 *
 * The generic parameter T lets callers use a wider email type (e.g.
 * InvoiceClassification) while still getting a precisely typed return.
 * Doc-only fields (DocumentClassificationFields) are always carried
 * forward, so downstream code never needs `as Record<string, unknown>`.
 */
export function mergeClassifications<T>(
  email: T,
  doc: Partial<EmailClassification> & Partial<DocumentClassificationFields>,
): T & DocumentClassificationFields {
  // Implementation uses `any` for the generic mutation; type safety is enforced
  // by the function signature. Callers get T & DocumentClassificationFields back.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merged: any = { ...email };
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (value != null) merged[key] = value;
  }
  return merged as T & DocumentClassificationFields;
}

// ── Month tag validation + helpers ──────────────────────────────────────

/**
 * Validate a candidate `YYYY-MM` tag.
 *
 * Accepts only:
 * - Format `^\d{4}-(0[1-9]|1[0-2])$` (no junk, no letters, no extra digits)
 * - Year in `[2000, currentYear + 1]` (rejects 2940, 0023, etc.)
 *
 * Returns the validated tag or `null`. This is the boundary guard — anything
 * the worker passes to Paperless MUST go through this function first.
 */
export function validMonthTag(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const nowYear = new Date().getUTCFullYear();
  if (year < 2000 || year > nowYear + 1) return null;
  return s;
}

// ── resolveOwner ────────────────────────────────────────────────────────

/**
 * Resolve the canonical owner for a document, given a raw owner guess and
 * the document's classified type.
 *
 * This is the single point of enforcement for document-kind → owner rules
 * that short-circuit raw owner inputs. Called by the intake worker BEFORE
 * `buildTagNames` and `resolveStoragePathId` so both downstream decisions
 * use the same authoritative value.
 *
 * Rules:
 * - `doc_type === "payslip"` → always `"personal"`. A payslip is a personal
 *   income record for the named individual regardless of which company
 *   issued it. The business-identifier check in the document-classifier
 *   would otherwise misfire because the employer's name + IČO appear on
 *   every payslip.
 * - Otherwise: return `"business"` iff `rawOwner === "business"`, else
 *   `"personal"`. Matches the pre-existing `buildTagNames` default.
 *
 * Extend this function when new personal-income doc types are introduced
 * (dividend voucher, interest statement, brokerage statement). Do NOT
 * scatter rules across callers.
 */
export function resolveOwner(
  rawOwner: string | null | undefined,
  docType: string | null | undefined,
): "business" | "personal" {
  if (docType === "payslip") return "personal";
  return rawOwner === "business" ? "business" : "personal";
}

/** Convert an ISO date string (or any Date-parseable string) to a validated `YYYY-MM` tag. */
function monthFromDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const candidate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return validMonthTag(candidate);
}

/**
 * Parse the start date of an ISO 8601 service-period interval (`YYYY-MM-DD/YYYY-MM-DD`).
 *
 * The document-classifier returns service ranges in this format. Returns the
 * left side as a date string suitable for `monthFromDate`, or `null` if not
 * a recognised interval.
 */
export function parseServicePeriodStart(period: string | null | undefined): string | null {
  if (!period) return null;
  const m = period.match(/^(\d{4}-\d{2}-\d{2})\/\d{4}-\d{2}-\d{2}$/);
  return m ? m[1] : null;
}

/**
 * Hardened subject regex extraction. Used only as a fallback when no document
 * dates are available. Rejects matches inside arbitrary numeric IDs.
 *
 * Negative lookarounds `(?<![\d-])` and `(?![\d-])` ensure that `2940-61`
 * inside `#2940-6120-5985` is NOT matched (the surrounding digits/dash
 * disqualify it). Year range and month range are then validated.
 */
function extractMonthFromSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  // YYYY-MM with no adjacent digit or dash on either side
  const yyyyMm = subject.match(/(?<![\d-])(\d{4})-(0[1-9]|1[0-2])(?![\d-])/);
  if (yyyyMm) {
    const candidate = `${yyyyMm[1]}-${yyyyMm[2]}`;
    const validated = validMonthTag(candidate);
    if (validated) return validated;
  }
  // MM/YYYY with no adjacent digit or slash on either side
  const mmYyyy = subject.match(/(?<![\d/])(0[1-9]|1[0-2])\/(\d{4})(?![\d/])/);
  if (mmYyyy) {
    const candidate = `${mmYyyy[2]}-${mmYyyy[1]}`;
    const validated = validMonthTag(candidate);
    if (validated) return validated;
  }
  return null;
}

// ── resolveMonthTag ─────────────────────────────────────────────────────

/**
 * Resolve a `YYYY-MM` accounting-period tag from classifier output and email
 * metadata. The chain walks evidence in priority order, returning the first
 * candidate that passes {@link validMonthTag}. Returns `null` if nothing
 * resolves — caller should upload without a month tag and alert the user.
 *
 * Priority:
 * 1. `accountingPeriod` — LLM's reasoned decision (highest authority)
 * 2. `supplyDate` — Slovak "deň dodania", legal tax point
 * 3. `servicePeriodStart` — start of subscription period
 * 4. `docDate` — issue date printed on the document
 * 5. `subject` regex — hardened, last-resort scan
 * 6. `receivedAt` — email arrival timestamp
 * 7. `scanFallback` — GDrive scan creation date (scan pipeline only)
 */
export function resolveMonthTag(inputs: MonthTagInputs): string | null {
  return (
    validMonthTag(inputs.accountingPeriod) ??
    monthFromDate(inputs.supplyDate) ??
    monthFromDate(inputs.servicePeriodStart) ??
    monthFromDate(inputs.docDate) ??
    extractMonthFromSubject(inputs.subject) ??
    monthFromDate(inputs.receivedAt) ??
    validMonthTag(inputs.scanFallback) ??
    null
  );
}

// ── buildTagNames ───────────────────────────────────────────────────────

/**
 * Build the list of tag NAMES from classification metadata.
 * This is the pure half — actual Paperless tag ID resolution is separate (I/O).
 *
 * The `monthTag` argument is defensively re-validated here so a malformed value
 * (e.g. `"2940-61"` from a buggy upstream caller) cannot leak into Paperless and
 * silently auto-create a junk tag. If invalid, the document is tagged without a
 * month — better than fabricating one.
 */
export function buildTagNames(
  classification: { owner: string | null; doc_type: string | null; is_fuel: boolean },
  monthTag: string | null,
): string[] {
  const tags: string[] = [];
  tags.push(classification.owner === "business" ? "techlab" : "personal");
  if (classification.owner === "business") tags.push("accounting");
  if (classification.doc_type === "credit_note") tags.push("credit-note");
  if (classification.doc_type === "account_statement") tags.push("account-statement");
  if (classification.is_fuel) tags.push("fuel");
  const validatedMonth = validMonthTag(monthTag);
  if (validatedMonth) tags.push(validatedMonth);
  return tags;
}

/**
 * Build tag names for a GDrive scan. Tags are derived from the watch_folder
 * path — owner from LEVEL1, accounting from LEVEL2 — not from classification.
 */
export function buildScanTagNames(
  watchFolder: string,
  classification: { doc_type: string | null; is_fuel: boolean },
  monthTag: string | null,
): string[] {
  const [owner, level2] = watchFolder.split("/").filter(Boolean);
  const tags: string[] = [owner];
  if (level2 === "accounting") tags.push("accounting");
  if (classification.doc_type === "credit_note") tags.push("credit-note");
  if (classification.doc_type === "account_statement") tags.push("account-statement");
  if (classification.is_fuel) tags.push("fuel");
  const validatedMonth = validMonthTag(monthTag);
  if (validatedMonth) tags.push(validatedMonth);
  return tags;
}

/**
 * Apply folder-driven overrides to a scan classification. The watch_folder
 * LEVEL2 segment expresses user intent and overrides content-based classifier
 * decisions: a file dropped in `documents` is a non-monetary document even if
 * the classifier visually identifies it as an invoice. Forces `doc_type` to
 * `"document"` and nulls `total_amount` / `order_id` to maintain the
 * non-monetary invariants. No-op for other folders (e.g. `accounting`).
 *
 * Pure / immutable — does not mutate the input.
 */
export function applyScanFolderOverrides<T extends {
  doc_type: string | null;
  total_amount?: number | null;
  order_id?: string | null;
}>(classification: T, watchFolder: string): T {
  const level2 = watchFolder.split("/").filter(Boolean)[1];
  if (level2 === "documents") {
    return { ...classification, doc_type: "document", total_amount: null, order_id: null };
  }
  return classification;
}

// ── generateTitle ───────────────────────────────────────────────────────

/**
 * Build document title from vendor + best available identifier.
 * Priority: order_id > subtitle > cleaned subject > "invoice" fallback.
 */
export function generateTitle(
  vendor: string,
  orderId: string | null | undefined,
  subtitle: string | null | undefined,
  subject: string | null | undefined,
): string {
  if (orderId) {
    return `${vendor} - ${orderId}`;
  }
  if (subtitle) {
    return `${vendor} - ${subtitle}`;
  }
  if (subject) {
    const cleaned = subject
      .replace(/^(Fwd|Re|FW):\s*/gi, "")
      .trim()
      .slice(0, 80);
    return `${vendor} - ${cleaned}`;
  }
  return `${vendor} - invoice`;
}

// ── Unknown field detection + guidance actions ─────────────────────────

/**
 * Union of field names the classifier is permitted to mark as `"unknown"`.
 * All of these are present in both InvoiceClassification & DocumentClassificationFields
 * (invoice path) and ScanClassification (scan path), so using this type as the
 * array element type lets callers index a classification object without a
 * `Record<string, unknown>` cast.
 *
 * Keep in sync with the permissive-`"unknown"` additions in
 * `workflow-schemas.ts` (task 57, Task 1.2).
 */
export type UnknownCapableField =
  | "owner"
  | "doc_type"
  | "total_amount"
  | "doc_date"
  | "supply_date"
  | "service_period"
  | "accounting_period";

export const UNKNOWN_FIELDS: UnknownCapableField[] = [
  "owner",
  "doc_type",
  "total_amount",
  "doc_date",
  "supply_date",
  "service_period",
  "accounting_period",
];

/**
 * Build a suggested-action list for the Telegram guidance prompt given
 * the classifier's missing fields. The worker surfaces these as button
 * vocabulary so the user can patch the unknowns with a single tap.
 *
 * Rules:
 *   - `owner` unknown → `set:owner=personal`, `set:owner=business`
 *   - `doc_type` unknown → three doc-type buttons
 *   - always finish with `skip` so the user can abort without patching
 */
export function buildSuggestedActions(
  unknownFields: string[],
  _classification: { doc_type?: string | null },
): string[] {
  const actions: string[] = [];
  if (unknownFields.includes("owner")) {
    actions.push("set:owner=personal", "set:owner=business");
  }
  if (unknownFields.includes("doc_type")) {
    actions.push(
      "set:doc_type=invoice",
      "set:doc_type=receipt",
      "set:doc_type=account_statement",
    );
  }
  actions.push("skip");
  return actions;
}

// ── Step resume ─────────────────────────────────────────────────────────

import { getJobEvents, type JobEventRow } from "../workflow-db";
import type { Database } from "bun:sqlite";

/**
 * Read all step_completed events for a job and build a map of step → payload.
 * Used by the worker to skip already-completed steps on resume.
 *
 * Callers may pass a pre-read `events` array (T11: per-tick read coalescing)
 * to avoid a redundant full scan of `job_events`. When omitted, the function
 * performs a fresh read itself — this fallback keeps unit tests
 * (workflow-resume.test.ts) and any future direct caller working without
 * having to materialize events first.
 */
export function getCompletedSteps(
  db: Database,
  jobId: string,
  events?: JobEventRow[],
): Map<string, Record<string, unknown>> {
  const evts = events ?? getJobEvents(db, jobId);
  const completed = new Map<string, Record<string, unknown>>();
  for (const evt of evts) {
    if (evt.event_type === "step_completed" && evt.payload_json) {
      const payload = JSON.parse(evt.payload_json);
      if (payload.step) completed.set(payload.step, payload);
    }
  }
  return completed;
}
