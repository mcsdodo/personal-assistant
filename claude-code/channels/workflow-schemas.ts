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
    options?: { cause?: unknown },
  ) {
    const gotDesc = describe(got);
    const ctx = context ? ` ${JSON.stringify(context)}` : "";
    super(
      `${schemaName}: invalid field '${field}' — expected ${expected}, got ${gotDesc}${ctx}`,
      options,
    );
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
}

export const EMAIL_SOURCES = ["gmail", "outlook"] as const;

export function validateInvoiceIntakeInput(input: unknown): InvoiceIntakeInputSchema {
  const obj = requireObject("InvoiceIntakeInput", input);
  return {
    email_source: reqEnum("InvoiceIntakeInput", obj, "email_source", EMAIL_SOURCES),
    message_id: reqString("InvoiceIntakeInput", obj, "message_id"),
    file_path: optString("InvoiceIntakeInput", obj, "file_path"),
    force: optBool("InvoiceIntakeInput", obj, "force"),
  };
}

export interface ScanIntakeInputSchema {
  source: "gdrive";
  file_id: string;
  watch_folder: string;
  month_tag: string;
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
    filename: optString("ScanIntakeInput", obj, "filename"),
    file_path: optString("ScanIntakeInput", obj, "file_path"),
    force: optBool("ScanIntakeInput", obj, "force"),
  };
}

// ── Classification result schemas ─────────────────────────────────────
//
// IMPORTANT: these schemas reflect what the worker actually consumes, NOT
// the simplified shapes in design docs. The download_strategy enum and
// action enum match what email-classifier.md returns, plus the additional
// `subject`/`received_at`/`sender` fields the worker injects so it can build
// titles and month tags during the resume path.

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

export const OWNERS = ["techlab", "personal"] as const;

export interface EmailClassificationResultSchema {
  is_invoice: boolean;
  confidence: "high" | "medium" | "low";
  vendor: string;
  doc_type?: string;
  is_fuel: boolean;
  owner?: "techlab" | "personal";
  action: "download_and_upload" | "notify_user" | "ignore";
  download_strategy:
    | "attachment"
    | "claude_download"
    | "known_link"
    | "direct_url"
    | "browser_required"
    | "manual_review"
    | null;
  strategy_confidence: "high" | "medium" | "low";
  requires_review: boolean;
  order_id: string | null;
  subtitle?: string | null;
  total_amount: number | null;
  currency: string | null;
  /** Worker-injected so the resume path can rebuild titles and month tags. */
  subject: string;
  received_at: string;
  sender: string;
}

export function validateEmailClassificationResult(input: unknown): EmailClassificationResultSchema {
  const obj = requireObject("EmailClassificationResult", input);

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

  return {
    is_invoice: reqBool("EmailClassificationResult", obj, "is_invoice"),
    confidence: reqEnum("EmailClassificationResult", obj, "confidence", CONFIDENCE_LEVELS),
    vendor: reqString("EmailClassificationResult", obj, "vendor"),
    doc_type: optString("EmailClassificationResult", obj, "doc_type"),
    is_fuel: reqBool("EmailClassificationResult", obj, "is_fuel"),
    owner: optEnum("EmailClassificationResult", obj, "owner", OWNERS),
    action: reqEnum("EmailClassificationResult", obj, "action", EMAIL_ACTIONS),
    download_strategy,
    strategy_confidence: reqEnum(
      "EmailClassificationResult",
      obj,
      "strategy_confidence",
      CONFIDENCE_LEVELS,
    ),
    requires_review: reqBool("EmailClassificationResult", obj, "requires_review"),
    order_id: nullableString("EmailClassificationResult", obj, "order_id"),
    subtitle: nullableString("EmailClassificationResult", obj, "subtitle", { allowMissing: true }),
    total_amount: nullableNumber("EmailClassificationResult", obj, "total_amount"),
    currency: nullableString("EmailClassificationResult", obj, "currency"),
    subject: reqString("EmailClassificationResult", obj, "subject"),
    received_at: reqString("EmailClassificationResult", obj, "received_at"),
    sender: reqString("EmailClassificationResult", obj, "sender"),
  };
}

export interface DocumentClassificationResultSchema {
  doc_type: string;
  vendor: string;
  total_amount: number | null;
  currency: string | null;
  is_fuel: boolean;
  owner: "techlab" | "personal";
  confidence: "high" | "medium" | "low";
  order_id: string | null;
  subtitle: string | null;
  doc_date: string | null;
  supply_date?: string | null;
  service_period?: string | null;
  accounting_period?: string | null;
  accounting_period_reasoning?: string | null;
}

export function validateDocumentClassificationResult(input: unknown): DocumentClassificationResultSchema {
  const obj = requireObject("DocumentClassificationResult", input);
  return {
    doc_type: reqString("DocumentClassificationResult", obj, "doc_type"),
    vendor: reqString("DocumentClassificationResult", obj, "vendor"),
    total_amount: nullableNumber("DocumentClassificationResult", obj, "total_amount"),
    currency: nullableString("DocumentClassificationResult", obj, "currency"),
    is_fuel: reqBool("DocumentClassificationResult", obj, "is_fuel"),
    owner: reqEnum("DocumentClassificationResult", obj, "owner", OWNERS),
    confidence: reqEnum("DocumentClassificationResult", obj, "confidence", CONFIDENCE_LEVELS),
    order_id: nullableString("DocumentClassificationResult", obj, "order_id"),
    subtitle: nullableString("DocumentClassificationResult", obj, "subtitle"),
    doc_date: nullableString("DocumentClassificationResult", obj, "doc_date"),
    supply_date: nullableString("DocumentClassificationResult", obj, "supply_date", { allowMissing: true }),
    service_period: nullableString("DocumentClassificationResult", obj, "service_period", { allowMissing: true }),
    accounting_period: nullableString("DocumentClassificationResult", obj, "accounting_period", { allowMissing: true }),
    accounting_period_reasoning: nullableString(
      "DocumentClassificationResult",
      obj,
      "accounting_period_reasoning",
      { allowMissing: true },
    ),
  };
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
export function validateClassificationByStep(step: string, result: unknown): unknown {
  try {
    if (step === "classify_email") return validateEmailClassificationResult(result);
    if (step === "classify_document") return validateDocumentClassificationResult(result);
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
