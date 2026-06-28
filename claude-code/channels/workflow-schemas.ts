/**
 * Runtime schemas for workflow contract boundaries.
 *
 * These guard the dataflow between watchers, the workflow ledger, and the
 * worker. Validation runs in three places:
 *
 * 1. Watchers validate job input before calling `createJob` (catches
 *    malformed payloads at the source).
 * 2. `submitClassification` validates the classification result before
 *    storing it (rejects bad payloads from Claude before they corrupt the
 *    resume path).
 * 3. The worker validates step payloads when reading them back via
 *    `getCompletedSteps` (defense in depth — if a stored payload somehow
 *    diverges, we fail fast with a clear error instead of silently casting).
 *
 * Validators throw `WorkflowSchemaError` with `field`, `expected`, and `got`
 * filled in. Extra fields are tolerated for forward compatibility.
 *
 * No external dependencies — these are hand-rolled type guards. Adding zod
 * would pull in a runtime dep we don't otherwise need.
 */

// ── Error type ─────────────────────────────────────────────────────────

export class WorkflowSchemaError extends Error {
  constructor(
    public readonly schemaName: string,
    public readonly field: string,
    public readonly expected: string,
    public readonly got: unknown,
    public readonly context?: Record<string, unknown>,
    options?: { cause?: unknown; message?: string },
  ) {
    const gotDesc = describe(got);
    const ctx = context ? ` ${JSON.stringify(context)}` : "";
    const base =
      options?.message ??
      `${schemaName}: invalid field '${field}' — expected ${expected}, got ${gotDesc}${ctx}`;
    super(base, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WorkflowSchemaError";
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  const t = typeof v;
  if (t === "string") return `string("${(v as string).slice(0, 40)}")`;
  if (t === "number" || t === "boolean") return `${t}(${String(v)})`;
  if (Array.isArray(v)) return `array(len=${v.length})`;
  return t;
}

// ── Primitive guards ──────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireObject(name: string, v: unknown): Record<string, unknown> {
  if (!isObject(v)) {
    throw new WorkflowSchemaError(name, "<root>", "object", v);
  }
  return v;
}

function reqString(name: string, obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new WorkflowSchemaError(name, field, "non-empty string", v);
  }
  return v;
}

function optString(name: string, obj: Record<string, unknown>, field: string): string | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new WorkflowSchemaError(name, field, "string | null | undefined", v);
  }
  return v;
}

function reqEnum<T extends string>(
  name: string,
  obj: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const v = obj[field];
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new WorkflowSchemaError(
      name,
      field,
      `one of ${JSON.stringify(allowed)}`,
      v,
    );
  }
  return v as T;
}

function optEnum<T extends string>(
  name: string,
  obj: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new WorkflowSchemaError(
      name,
      field,
      `one of ${JSON.stringify(allowed)} | null`,
      v,
    );
  }
  return v as T;
}

function optNumberOrNull(
  name: string,
  obj: Record<string, unknown>,
  field: string,
): number | null | undefined {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new WorkflowSchemaError(name, field, "number | null", v);
  }
  return v;
}

function reqBool(name: string, obj: Record<string, unknown>, field: string): boolean {
  const v = obj[field];
  if (typeof v !== "boolean") {
    throw new WorkflowSchemaError(name, field, "boolean", v);
  }
  return v;
}

function optBool(name: string, obj: Record<string, unknown>, field: string): boolean | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") {
    throw new WorkflowSchemaError(name, field, "boolean | null | undefined", v);
  }
  return v;
}

// ── Job input schemas ─────────────────────────────────────────────────

export interface InvoiceIntakeInputSchema {
  email_source: "gmail" | "outlook";
  message_id: string;
  file_path?: string;
  force?: boolean;
  // Watcher-injected metadata. Present when the email-watcher created the
  // job (typical case); absent for manual jobs created via the
  // `create_invoice_intake_job` MCP tool. The submitClassification merge
  // step copies these into the classification result so the schema there
  // can validate the merged result and the worker can use them in the
  // resume path. See _tasks/_done/47-pipeline-hardening-followups/ Issue 1.
  sender?: string | null;
  subject?: string | null;
  received_at?: string | null;
}

export const EMAIL_SOURCES = ["gmail", "outlook"] as const;

export function validateInvoiceIntakeInput(input: unknown): InvoiceIntakeInputSchema {
  const obj = requireObject("InvoiceIntakeInput", input);
  return {
    email_source: reqEnum("InvoiceIntakeInput", obj, "email_source", EMAIL_SOURCES),
    message_id: reqString("InvoiceIntakeInput", obj, "message_id"),
    file_path: optString("InvoiceIntakeInput", obj, "file_path"),
    force: optBool("InvoiceIntakeInput", obj, "force"),
    sender: nullableString("InvoiceIntakeInput", obj, "sender", { allowMissing: true }),
    subject: nullableString("InvoiceIntakeInput", obj, "subject", { allowMissing: true }),
    received_at: nullableString("InvoiceIntakeInput", obj, "received_at", { allowMissing: true }),
  };
}

/** Owner roles accepted on a scan job (task 96 — resolved by the poller). */
export const SCAN_OWNERS = ["business", "personal"] as const;
/** Bucket types accepted on a scan job (task 96). */
export const SCAN_BUCKETS = ["accounting", "documents"] as const;

export interface ScanIntakeInputSchema {
  source: "gdrive";
  file_id: string;
  watch_folder: string;
  month_tag: string;
  /**
   * Owner ROLE resolved once by the gdrive-poller (task 96). The poller maps
   * the Drive owner-folder name → role (folder == OWNER_BUSINESS_LABEL →
   * "business"; "personal" → "personal"). Enum-gated here so a misconfigured
   * owner fails loud at job creation rather than silently misrouting (B3).
   */
  owner: "business" | "personal";
  /** Bucket resolved by the poller — drives the accounting tag + content override (B1). */
  bucket: "accounting" | "documents";
  /** Resolved Drive folder ID of the bucket folder. Used directly as the move
   *  parent so processed/errors resolution is unambiguous across owners (B2). */
  folder_id: string;
  filename?: string;
  file_path?: string;
  force?: boolean;
}

export function validateScanIntakeInput(input: unknown): ScanIntakeInputSchema {
  const obj = requireObject("ScanIntakeInput", input);
  return {
    source: reqEnum("ScanIntakeInput", obj, "source", ["gdrive"] as const),
    file_id: reqString("ScanIntakeInput", obj, "file_id"),
    watch_folder: reqString("ScanIntakeInput", obj, "watch_folder"),
    month_tag: reqString("ScanIntakeInput", obj, "month_tag"),
    owner: reqEnum("ScanIntakeInput", obj, "owner", SCAN_OWNERS),
    bucket: reqEnum("ScanIntakeInput", obj, "bucket", SCAN_BUCKETS),
    folder_id: reqString("ScanIntakeInput", obj, "folder_id"),
    filename: optString("ScanIntakeInput", obj, "filename"),
    file_path: optString("ScanIntakeInput", obj, "file_path"),
    force: optBool("ScanIntakeInput", obj, "force"),
  };
}

// ── Classification result schemas ─────────────────────────────────────
//
// IMPORTANT: these schemas reflect what the worker actually consumes, NOT
// the simplified shapes in design docs. The download_strategy enum and
// action enum match what email-classifier.md returns. The `subject` /
// `received_at` / `sender` fields are NOT from the email-classifier — they
// come from `input_json` (written by the watcher at job creation time) and
// are merged into the classification result by `submitClassification` in
// `workflow-db.ts` BEFORE schema validation runs. They're listed here as
// part of the schema because the worker uses them during the resume path
// (title generation, month-tag inference, download routing).
// See _tasks/_done/47-pipeline-hardening-followups/ Issue 1.

export const DOWNLOAD_STRATEGIES = [
  "attachment",
  "claude_download",
  "known_link",
  "direct_url",
  "browser_required",
  "manual_review",
] as const;

export const EMAIL_ACTIONS = ["download_and_upload", "notify_user", "ignore"] as const;

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export const OWNERS = ["business", "personal"] as const;

/**
 * Owners accepted by the document classifier. "unknown" is allowed when the
 * classifier cannot determine ownership from the document (e.g. no IČO
 * printed, buyer name only) — the worker pauses the job and requests user
 * guidance instead of guessing. See task 57.
 */
export const DOC_OWNERS = ["business", "personal", "unknown"] as const;

export interface EmailClassificationResultSchema {
  is_invoice: boolean;
  confidence: "high" | "medium" | "low";
  /** Null when action=ignore (non-invoice) — the classifier has no counterparty. */
  vendor: string | null;
  doc_type?: string;
  is_fuel: boolean;
  owner?: "business" | "personal";
  action: "download_and_upload" | "notify_user" | "ignore";
  download_strategy:
    | "attachment"
    | "claude_download"
    | "known_link"
    | "direct_url"
    | "browser_required"
    | "manual_review"
    | null;
  /** Null when action=ignore — there's no strategy to have confidence in. */
  strategy_confidence: "high" | "medium" | "low" | null;
  requires_review: boolean;
  order_id: string | null;
  subtitle?: string | null;
  total_amount: number | null;
  currency: string | null;
  /**
   * Worker-injected from `input_json` by `submitClassification`'s merge step.
   * Watcher writes them at job-creation time. Manual jobs (created via the
   * `create_invoice_intake_job` MCP tool) may have these as null. Downstream
   * code (`extractInvoiceLinks`, `resolveMonthTag`, `generateTitle`) handles
   * null values.
   */
  subject: string | null;
  received_at: string | null;
  sender: string | null;
  /** Set by the email-classifier ONLY for accountant senders it decides to skip
   *  (action="ignore"). One of: query | payslip | payment_order | close | other.
   *  Null for all other emails. Drives the accountant_non_invoice_skipped outcome. */
  skip_reason: string | null;
}

export function validateEmailClassificationResult(input: unknown): EmailClassificationResultSchema {
  const obj = requireObject("EmailClassificationResult", input);

  // Validate action first — some fields are conditionally nullable when action=ignore.
  const action = reqEnum("EmailClassificationResult", obj, "action", EMAIL_ACTIONS);
  const isIgnore = action === "ignore";

  // download_strategy: string from the enum, or null when action is ignore
  const ds = obj.download_strategy;
  let download_strategy: EmailClassificationResultSchema["download_strategy"];
  if (ds === null || ds === undefined) {
    download_strategy = null;
  } else if (typeof ds === "string" && (DOWNLOAD_STRATEGIES as readonly string[]).includes(ds)) {
    download_strategy = ds as EmailClassificationResultSchema["download_strategy"];
  } else {
    throw new WorkflowSchemaError(
      "EmailClassificationResult",
      "download_strategy",
      `one of ${JSON.stringify(DOWNLOAD_STRATEGIES)} | null`,
      ds,
    );
  }

  // vendor: non-empty string for real invoices; nullable for ignore. Task 48
  // post-deploy fix — the classifier shouldn't have to invent a vendor for
  // newsletters, personal emails, etc. that aren't being processed anyway.
  let vendor: string | null;
  if (isIgnore && (obj.vendor === null || obj.vendor === undefined)) {
    vendor = null;
  } else {
    vendor = reqString("EmailClassificationResult", obj, "vendor");
  }

  // strategy_confidence: same treatment — null when action=ignore.
  let strategy_confidence: EmailClassificationResultSchema["strategy_confidence"];
  if (isIgnore && (obj.strategy_confidence === null || obj.strategy_confidence === undefined)) {
    strategy_confidence = null;
  } else {
    strategy_confidence = reqEnum(
      "EmailClassificationResult",
      obj,
      "strategy_confidence",
      CONFIDENCE_LEVELS,
    );
  }

  return {
    is_invoice: reqBool("EmailClassificationResult", obj, "is_invoice"),
    confidence: reqEnum("EmailClassificationResult", obj, "confidence", CONFIDENCE_LEVELS),
    vendor,
    doc_type: optString("EmailClassificationResult", obj, "doc_type"),
    is_fuel: reqBool("EmailClassificationResult", obj, "is_fuel"),
    owner: optEnum("EmailClassificationResult", obj, "owner", OWNERS),
    action,
    download_strategy,
    strategy_confidence,
    requires_review: reqBool("EmailClassificationResult", obj, "requires_review"),
    order_id: nullableString("EmailClassificationResult", obj, "order_id"),
    subtitle: nullableString("EmailClassificationResult", obj, "subtitle", { allowMissing: true }),
    total_amount: nullableNumber("EmailClassificationResult", obj, "total_amount"),
    currency: nullableString("EmailClassificationResult", obj, "currency"),
    // These three are watcher-injected via `submitClassification`'s merge
    // step (or null for manual jobs). They must be present in the merged
    // object — `nullableString` without `allowMissing` enforces that — but
    // their value can be null.
    subject: nullableString("EmailClassificationResult", obj, "subject"),
    received_at: nullableString("EmailClassificationResult", obj, "received_at"),
    sender: nullableString("EmailClassificationResult", obj, "sender"),
    skip_reason: nullableString("EmailClassificationResult", obj, "skip_reason", { allowMissing: true }),
  };
}

export interface DocumentClassificationResultSchema {
  doc_type: string;
  vendor: string;
  total_amount: number | "unknown" | null;
  currency: string | null;
  is_fuel: boolean;
  owner: "business" | "personal" | "unknown";
  /**
   * Proof string for the `owner` classification.
   *
   * Required (non-empty string) when `owner === "business"`: the literal
   * substring from the document that matched one of the configured
   * `BUSINESS_*` identifiers (company name, tax ID, CRN, or license plate).
   * Must be `null` when `owner === "personal"` or `owner === "unknown"`.
   *
   * The classifier prompt instructs Haiku to quote the matched identifier
   * before claiming `business` — this is enforced here so a `business`
   * classification without proof gets rejected at submitClassification time.
   * Missing on backward-compat replay of old stored payloads (validator only
   * runs on new submissions). See task 83.
   */
  owner_match_evidence?: string | null;
  confidence: "high" | "medium" | "low";
  order_id: string | null;
  subtitle: string | null;
  doc_date: string | null;
  supply_date?: string | null;
  service_period?: string | null;
  accounting_period?: string | null;
  accounting_period_reasoning?: string | null;
  /**
   * Free-form explanation written by the classifier. Required (non-empty)
   * whenever any other UNKNOWN_CAPABLE_FIELDS entry is set to the string
   * literal `"unknown"`. See task 57 — the worker uses this to craft the
   * Telegram guidance prompt that asks the user for help.
   */
  notes?: string | null;
  /** Fuel volume in litres. Set only when is_fuel: true. Null/missing otherwise. */
  litres?: number | null;
  /**
   * Receipt timestamp.
   * - Full datetime: "YYYY-MM-DDTHH:MM:SS" — always emitted with time part.
   * - Date-only input ("YYYY-MM-DD") is coerced to "YYYY-MM-DDT00:00:00" so
   *   downstream consumers (kniha-jazd) always see a uniform format.
   * - Null/missing when neither date nor time was extractable.
   */
  receipt_datetime?: string | null;
}

/**
 * Fields in DocumentClassificationResult that may take the literal string
 * `"unknown"` when the classifier cannot determine them. See task 57.
 */
const UNKNOWN_CAPABLE_FIELDS = [
  "owner",
  "doc_type",
  "total_amount",
  "doc_date",
  "supply_date",
  "service_period",
  "accounting_period",
] as const;

/**
 * Accept either the normal validator output or the literal string
 * `"unknown"`. Used for doc_type (non-empty string otherwise) and the
 * date/period fields (nullable string otherwise).
 */
function stringOrUnknown(
  name: string,
  obj: Record<string, unknown>,
  field: string,
  opts: { allowNull?: boolean; allowMissing?: boolean } = {},
): string | null {
  if (!(field in obj)) {
    if (opts.allowMissing) return null;
    throw new WorkflowSchemaError(name, field, "string | null", undefined);
  }
  const v = obj[field];
  if (v === "unknown") return "unknown";
  if (v === null || v === undefined) {
    if (opts.allowNull) return null;
    throw new WorkflowSchemaError(name, field, "non-empty string", v);
  }
  if (typeof v !== "string" || v.length === 0) {
    throw new WorkflowSchemaError(name, field, opts.allowNull ? "string | null" : "non-empty string", v);
  }
  return v;
}

/**
 * Accept `number`, `null`, or the literal string `"unknown"`. Matches the
 * task 57 "unknown values" contract for total_amount.
 */
function numberOrUnknown(
  name: string,
  obj: Record<string, unknown>,
  field: string,
): number | "unknown" | null {
  if (!(field in obj)) {
    throw new WorkflowSchemaError(name, field, 'number | null | "unknown"', undefined);
  }
  const v = obj[field];
  if (v === "unknown") return "unknown";
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new WorkflowSchemaError(name, field, 'number | null | "unknown"', v);
  }
  return v;
}

/**
 * Validate `owner_match_evidence` against the resolved `owner`.
 *
 * Task 83. The classifier prompt requires Haiku to quote the literal
 * substring it matched from the document before claiming `owner: "business"`.
 * The validator rejects business classifications that lack proof, and
 * rejects evidence on personal/unknown classifications (which have nothing
 * to prove).
 *
 * Missing key is tolerated and treated as null — this matters for replay
 * of stored payloads written before task 83 shipped (the validator runs
 * via `getCompletedSteps` defense-in-depth path). For NEW classifier
 * outputs, the prompt enforces presence; if Haiku omits the field on a
 * business claim, the `null` fallback triggers the proof-required throw
 * below.
 */
function validateOwnerMatchEvidence(
  obj: Record<string, unknown>,
  owner: "business" | "personal" | "unknown",
  ownerEvidenceOptional = false,
): string | null {
  const raw = "owner_match_evidence" in obj ? obj.owner_match_evidence : null;

  // Non-string type is always rejected, regardless of the flag.
  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    throw new WorkflowSchemaError(
      "DocumentClassificationResult",
      "owner_match_evidence",
      "string | null",
      raw,
    );
  }

  const value = raw === undefined || raw === null ? null : (raw as string);

  if (owner === "business") {
    // Scan path: owner is folder-authoritative, so a flaky null evidence from
    // the classifier must not fail the job. ownerEvidenceOptional=true skips
    // the proof-required gate for scan_intake jobs. Default (false) preserves
    // the email-path hard-fail (task 83).
    if (value === null || value.trim().length === 0) {
      if (ownerEvidenceOptional) return null;
      throw new WorkflowSchemaError(
        "DocumentClassificationResult",
        "owner_match_evidence",
        "non-empty string when owner=business",
        value,
        undefined,
        {
          message:
            "DocumentClassificationResult: owner_match_evidence required when owner=business — the classifier must quote the literal BUSINESS_* substring it matched",
        },
      );
    }
    return value;
  }

  // owner is "personal" or "unknown" — evidence must be absent regardless of the flag.
  if (value !== null) {
    throw new WorkflowSchemaError(
      "DocumentClassificationResult",
      "owner_match_evidence",
      `null when owner=${owner}`,
      value,
    );
  }
  return null;
}

/**
 * Validate receipt_datetime. Always emits "YYYY-MM-DDTHH:MM:SS" downstream:
 * a bare "YYYY-MM-DD" from the classifier is coerced to "YYYY-MM-DDT00:00:00"
 * so kniha-jazd and other consumers see one uniform shape. Null/missing
 * passes through.
 */
function receiptDatetimeOrNull(
  name: string,
  obj: Record<string, unknown>,
  field: string,
): string | null {
  if (!(field in obj)) return null;
  const v = obj[field];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new WorkflowSchemaError(name, field, "string | null", v);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00`;
  throw new WorkflowSchemaError(
    name,
    field,
    'string matching "YYYY-MM-DDTHH:MM:SS" (date-only "YYYY-MM-DD" also accepted, coerced to T00:00:00)',
    v,
  );
}

export function validateDocumentClassificationResult(
  input: unknown,
  opts: { ownerEvidenceOptional?: boolean } = {},
): DocumentClassificationResultSchema {
  const obj = requireObject("DocumentClassificationResult", input);
  const owner = reqEnum("DocumentClassificationResult", obj, "owner", DOC_OWNERS);
  const owner_match_evidence = validateOwnerMatchEvidence(obj, owner, opts.ownerEvidenceOptional ?? false);
  const result: DocumentClassificationResultSchema = {
    doc_type: stringOrUnknown("DocumentClassificationResult", obj, "doc_type") as string,
    vendor: reqString("DocumentClassificationResult", obj, "vendor"),
    total_amount: numberOrUnknown("DocumentClassificationResult", obj, "total_amount"),
    currency: nullableString("DocumentClassificationResult", obj, "currency"),
    is_fuel: reqBool("DocumentClassificationResult", obj, "is_fuel"),
    owner,
    owner_match_evidence,
    confidence: reqEnum("DocumentClassificationResult", obj, "confidence", CONFIDENCE_LEVELS),
    order_id: nullableString("DocumentClassificationResult", obj, "order_id"),
    subtitle: nullableString("DocumentClassificationResult", obj, "subtitle"),
    doc_date: stringOrUnknown("DocumentClassificationResult", obj, "doc_date", { allowNull: true }),
    supply_date: stringOrUnknown("DocumentClassificationResult", obj, "supply_date", {
      allowNull: true,
      allowMissing: true,
    }),
    service_period: stringOrUnknown("DocumentClassificationResult", obj, "service_period", {
      allowNull: true,
      allowMissing: true,
    }),
    accounting_period: stringOrUnknown("DocumentClassificationResult", obj, "accounting_period", {
      allowNull: true,
      allowMissing: true,
    }),
    accounting_period_reasoning: nullableString(
      "DocumentClassificationResult",
      obj,
      "accounting_period_reasoning",
      { allowMissing: true },
    ),
    notes: nullableString("DocumentClassificationResult", obj, "notes", { allowMissing: true }),
    litres: optNumberOrNull("DocumentClassificationResult", obj, "litres") ?? null,
    receipt_datetime: receiptDatetimeOrNull("DocumentClassificationResult", obj, "receipt_datetime"),
  };

  // Cross-field check: if any UNKNOWN_CAPABLE field resolved to the literal
  // "unknown", notes must be a non-empty string explaining why. The worker
  // uses this text to craft the Telegram guidance prompt (task 57).
  const hasUnknown = UNKNOWN_CAPABLE_FIELDS.some(
    (f) => (result as unknown as Record<string, unknown>)[f] === "unknown",
  );
  if (hasUnknown && (!result.notes || !result.notes.trim())) {
    throw new WorkflowSchemaError(
      "DocumentClassificationResult",
      "notes",
      "non-empty string",
      result.notes,
      undefined,
      { message: 'DocumentClassificationResult: notes required when any field is "unknown"' },
    );
  }

  return result;
}

// ── Step dispatch ─────────────────────────────────────────────────────

/**
 * Validate a classification result for a given step name.
 *
 * Used by `submitClassification` to reject malformed payloads before they
 * enter the durable step_completed event log, and by the worker resume path
 * to fail fast if a stored payload no longer matches the schema.
 *
 * Returns the validated, narrowed object on success. Throws
 * `WorkflowSchemaError` with the step name in the context on failure.
 */
export function validateClassificationByStep(
  step: string,
  result: unknown,
  opts: { ownerEvidenceOptional?: boolean } = {},
): unknown {
  try {
    if (step === "classify_email") return validateEmailClassificationResult(result);
    if (step === "classify_document") return validateDocumentClassificationResult(result, opts);
    // Unknown step — pass through. Future steps should add cases above.
    return result;
  } catch (err) {
    if (err instanceof WorkflowSchemaError) {
      // Re-throw with the step name added to the context. Pass `cause` so the
      // original stack trace and error chain are preserved (Node.js prints
      // "Caused by:" frames when this is logged).
      throw new WorkflowSchemaError(
        err.schemaName,
        err.field,
        err.expected,
        err.got,
        { ...(err.context ?? {}), step },
        { cause: err },
      );
    }
    throw err;
  }
}

// ── nullable helpers (allow `null` but require the key to be present) ──

interface NullableOpts {
  /** Treat a missing key the same as an explicit null. */
  allowMissing?: boolean;
}

function nullableString(
  name: string,
  obj: Record<string, unknown>,
  field: string,
  opts: NullableOpts = {},
): string | null {
  if (!(field in obj)) {
    if (opts.allowMissing) return null;
    throw new WorkflowSchemaError(name, field, "string | null", undefined);
  }
  const v = obj[field];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new WorkflowSchemaError(name, field, "string | null", v);
  }
  return v;
}

function nullableNumber(
  name: string,
  obj: Record<string, unknown>,
  field: string,
): number | null {
  if (!(field in obj)) {
    throw new WorkflowSchemaError(name, field, "number | null", undefined);
  }
  const v = obj[field];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new WorkflowSchemaError(name, field, "number | null", v);
  }
  return v;
}
