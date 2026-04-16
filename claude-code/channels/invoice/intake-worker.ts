/**
 * Invoice/scan intake pipeline orchestrator.
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
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "fs";

import { getTracer, getMeter, SpanStatusCode } from "../tracing";
import type { Span } from "../tracing";

import {
  addJobEvent,
  completeJob,
  failJob,
  getJobEvents,
  parseJobJson,
  pauseForGuidance,
  recordDownloadedFile,
  requestJobApproval,
  scheduleRetry,
  shouldRetry,
  type JobEventRow,
  type JobRow,
} from "../workflow-db";
import type { PaperlessFieldRegistry } from "../paperless-fields";
import { PaperlessAdapter, type CorrespondentInfo } from "../paperless-adapter";
import {
  downloadInvoice as downloadInvoiceImpl,
  downloadFromGdrive as downloadFromGdriveImpl,
  type DownloadedFile as ServiceDownloadedFile,
} from "./download-service";
import { checkDuplicate as checkDuplicateImpl, type DedupeResult } from "./dedup-service";
import { parkForClassification } from "./classification-state";
import {
  buildScanTitle,
  moveGdriveFile as moveGdriveFileImpl,
  patchExistingDocument,
  resolveCorrespondent as resolveCorrespondentImpl,
  resolveDocumentTypeId,
  resolveStoragePathId,
  resolveTagIds,
  setDocumentCustomFields as setDocumentCustomFieldsImpl,
  uploadToPaperless as uploadToPaperlessImpl,
  type CustomFieldResult,
  type UploadResult,
} from "./postprocess-service";
import * as downloadHelper from "../download-helper";
import { readFileAsDownload } from "../download-helper";
import { formatNotification, type NotifyFn } from "../telegram-notify";
import {
  buildSuggestedActions,
  buildTagNames,
  generateTitle,
  getCompletedSteps,
  mergeClassifications,
  parseServicePeriodStart,
  resolveMonthTag,
  resolveOwner,
  UNKNOWN_FIELDS,
} from "../invoice-pipeline";
import {
  validateInvoiceIntakeInput,
  validateScanIntakeInput,
  WorkflowSchemaError,
} from "../workflow-schemas";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// ── Types ──────────────────────────────────────────────────────────────

export type DownloadStrategy =
  | "attachment"
  | "known_link"
  | "direct_url"
  | "browser_required"
  | "manual_review"
  | "claude_download";

export interface InvoiceIntakeInput {
  /** "gmail" or "outlook" */
  email_source: string;
  /** Email message ID from the email provider */
  message_id: string;
  /** Path to pre-downloaded file on disk (worker reads instead of downloading via MCP) */
  file_path?: string;
  /** Force reprocess: if dedup finds an existing Paperless doc, PATCH it in place
   *  instead of short-circuiting. Set by `create_invoice_intake_job(force=true)`. */
  force?: boolean;
}

/** Classification fields produced by the email-classifier + document-classifier channel roundtrips.
 *  Stored in step_completed events, read back via getCompletedSteps. */
export interface InvoiceClassification {
  is_invoice: boolean;
  confidence: "high" | "medium" | "low";
  /** Null when action=ignore — the classifier has no counterparty for non-invoices. */
  vendor: string | null;
  doc_type: string;
  is_fuel: boolean;
  owner?: "techlab" | "personal";
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
}

export interface ScanIntakeInput {
  source: "gdrive";
  file_id: string;
  /** Watch folder path (e.g. "techlab/invoicing") — segments become Paperless tags */
  watch_folder: string;
  /** YYYY-MM tag from scan date — fallback if document classifier has no doc_date */
  month_tag: string;
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
  owner?: "techlab" | "personal";
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
type DownloadedFile = ServiceDownloadedFile;

interface WorkerLogger {
  log(message: string): void;
}

// ── MCP Server URLs ────────────────────────────────────────────────────

const OUTLOOK_MCP_URL = process.env.OUTLOOK_MCP_URL ?? "http://outlook-mcp:8002/mcp";
const GMAIL_MCP_URL = process.env.GMAIL_MCP_URL ?? "http://gmail-mcp:8000/mcp";
const GOOGLE_EMAIL = process.env.GMAIL_EMAIL ?? "";
const PAPERLESS_MCP_URL = process.env.PAPERLESS_MCP_URL ?? "http://paperless-mcp:3000/mcp";

// ── Paperless adapter (lazy singleton) ──────────────────────────────────
//
// The adapter unifies the two Paperless transports (paperless-mcp HTTP for
// CRUD + direct REST API for upload/dedup/PATCH/tasks). It depends on the
// PaperlessFieldRegistry which the worker receives per call, so the singleton
// is rebuilt whenever the registry instance changes (e.g. between tests).
let _paperlessAdapter: PaperlessAdapter | null = null;
let _paperlessAdapterRegistry: PaperlessFieldRegistry | null = null;
function getPaperlessAdapter(registry: PaperlessFieldRegistry): PaperlessAdapter {
  if (_paperlessAdapter && _paperlessAdapterRegistry === registry) {
    return _paperlessAdapter;
  }
  const paperlessUrl = process.env.PAPERLESS_URL;
  if (!paperlessUrl) throw new Error("PAPERLESS_URL environment variable is required");
  _paperlessAdapter = new PaperlessAdapter({
    paperlessUrl,
    paperlessToken: process.env.PAPERLESS_API_TOKEN ?? "",
    paperlessMcpUrl: PAPERLESS_MCP_URL,
    fieldRegistry: registry,
  });
  _paperlessAdapterRegistry = registry;
  return _paperlessAdapter;
}

const tracer = getTracer("invoice-worker");
const meter = getMeter("invoice-worker");
const correspondentsCounter = meter.createCounter("invoice_worker_correspondents_total", {
  description: "Completed invoices by normalized Paperless correspondent",
});
const missingMonthTagCounter = meter.createCounter("invoice_worker_missing_month_tag_total", {
  description: "Documents uploaded without a valid YYYY-MM accounting period (operator must tag manually)",
});

// ── Guidance resume helpers ────────────────────────────────────────────
//
// When a user answers a `guidance_request`, `provide_guidance` writes a
// `guidance_applied` event (patch payload or retry marker) and flips the
// job back to `queued`. On next tick the worker runs again from the top
// of `executeInvoiceIntake` / `executeScanIntake`; it must:
//
//   1. Find the most recent `guidance_applied` event that has NOT been
//      consumed yet (no matching `guidance_applied_consumed` event
//      with the same event id after it).
//   2. Apply `patch` to the merged classification (Trigger A resume)
//      or force the classify_document step to re-run (`retry`).
//   3. Write a `guidance_applied_consumed` event so subsequent ticks
//      don't double-apply.
//
// Using a `guidance_applied_consumed` marker is simpler than rewriting
// the `guidance_applied` row — sqlite rows are append-only here and
// consumption is a boolean-per-event, not a state modification.
interface GuidanceApplied {
  eventId: number;
  action: "patch" | "retry" | "skip" | "fail";
  patch?: Record<string, unknown>;
}

/**
 * Return the most recent unconsumed `guidance_applied` event, or null
 * if every guidance_applied has been consumed (or none exist). The
 * "unconsumed" signal is a `guidance_applied_consumed` event whose
 * `source_event_id` payload field equals the guidance_applied's row
 * id. Walk events in reverse chronological order and return the first
 * guidance_applied that is NOT referenced by a later consumed marker.
 */
function findUnconsumedGuidance(events: JobEventRow[]): GuidanceApplied | null {
  const consumedIds = new Set<number>();
  for (const e of events) {
    if (e.event_type !== "guidance_applied_consumed") continue;
    try {
      const p = JSON.parse(e.payload_json ?? "{}");
      if (typeof p.source_event_id === "number") consumedIds.add(p.source_event_id);
    } catch { /* ignore malformed */ }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event_type !== "guidance_applied") continue;
    if (consumedIds.has(e.id)) continue;
    try {
      const p = JSON.parse(e.payload_json ?? "{}");
      const action = p.action;
      if (action === "patch" || action === "retry") {
        return { eventId: e.id, action, patch: p.patch ?? undefined };
      }
      // skip/fail are applied by provide_guidance directly (completeJob/failJob);
      // the worker should never re-run these jobs, so ignore.
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

let counterSeeded = false;
function seedCounterFromDb(db: import("bun:sqlite").Database): void {
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

// ── Main executor ──────────────────────────────────────────────────────

export async function executeInvoiceIntake(
  db: Database,
  job: JobRow,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
  notify?: NotifyFn,
  channel?: Server,
): Promise<void> {
  seedCounterFromDb(db);
  const rawInput = parseJobJson<unknown>(job.input_json);
  if (!rawInput) {
    failJob(db, job.id, { code: "invalid_input", message: "Missing or invalid input_json" });
    return;
  }
  let input: InvoiceIntakeInput;
  try {
    // Validate input_json against the schema. This catches drift between
    // the watcher and the worker, and rejects manually-edited workflow.db
    // entries that don't match the contract.
    input = validateInvoiceIntakeInput(rawInput) as InvoiceIntakeInput;
  } catch (err) {
    if (err instanceof WorkflowSchemaError) {
      failJob(db, job.id, {
        code: "schema_validation_failed",
        message: err.message,
        schema: err.schemaName,
        field: err.field,
      });
      return;
    }
    throw err;
  }

  await tracer.startActiveSpan(`invoice-worker.execute`, {
    attributes: {
      "job.id": job.id,
      "job.type": "invoice_intake",
      // Message identifiers on the top-level span so traces are immediately
      // self-identifying in Tempo without drilling. See task 48, Issue 4.
      "email.source": input.email_source,
      "email.message_id": input.message_id,
      "email.subject": input.subject ?? "",
      "email.sender": input.sender ?? "",
    },
  }, async (span: Span) => {
    let outcome = "unknown";
    let vendorForSpan = "unknown";
    try {
      // Resume logic — read completed steps to skip on re-entry
      const completedSteps = getCompletedSteps(db, job.id);

      // Step 0: Email classification via channel
      const cachedEmailClass = completedSteps.get("classify_email");
      if (!cachedEmailClass?.result) {
        await parkForClassification(db, job.id, {
          step: "classify_email",
          parkedPayload: {
            email_source: input.email_source,
            message_id: input.message_id,
          },
          channel,
          notificationContent: `Classification request: invoke email-classifier with the meta from this event, then call submit_classification with its output.`,
          notificationMeta: {
            event_type: "classify_email",
            job_id: job.id,
            email_source: input.email_source,
            message_id: input.message_id,
            // gmail tools require user_google_email; outlook tools don't.
            // Pre-resolve here so the subagent can fetch the body in one turn
            // (matches the strict maxTurns: 2 contract: one MCP call + final JSON).
            ...(input.email_source === "gmail" ? { user_google_email: GOOGLE_EMAIL } : {}),
          },
        }, logger);
        outcome = "awaiting_classification";
        span.setAttribute("invoice.outcome", "awaiting_classification");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      const classification = cachedEmailClass.result as InvoiceClassification;
      // `vendor` is nullable when action=ignore — the classifier has no
      // counterparty for non-invoices. Coerce to "unknown" for span attributes
      // and vendorForSpan so downstream observability code doesn't trip on null.
      vendorForSpan = classification.vendor ?? "unknown";
      span.setAttribute("invoice.vendor", vendorForSpan);
      span.setAttribute("invoice.download_strategy", String(classification.download_strategy));

      // Handle ignore action
      if (classification.action === "ignore") {
        completeJob(db, job.id, { outcome: "ignored", classification });
        logger.log(`Job ${job.id} completed: ignored by email classifier`);
        outcome = "ignored";
        span.setAttribute("invoice.outcome", "ignored");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Step 1: Download file and persist to disk
      const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/workspace/downloads";
      const cachedDownload = completedSteps.get("download") ?? completedSteps.get("read_from_disk");
      let filePath: string;
      let file: DownloadedFile;

      if (cachedDownload) {
        // Resume: file already downloaded in a previous tick
        filePath = (cachedDownload as { file_path?: string }).file_path
          ?? `${DOWNLOAD_DIR}/${(cachedDownload as { filename?: string }).filename ?? "unknown"}`;
        file = readFileAsDownload(filePath);
        logger.log(`Resuming: reusing file from ${filePath}`);
      } else if (input.file_path && existsSync(input.file_path)) {
        // Pre-existing file on disk (e.g. tests)
        filePath = input.file_path;
        file = readFileAsDownload(filePath);
        addJobEvent(db, job.id, "step_started", { step: "read_from_disk", file_path: filePath });
        addJobEvent(db, job.id, "step_completed", {
          step: "read_from_disk",
          file_path: filePath,
          filename: file.filename,
          size: file.size,
        });
      } else {
        // Download from email MCP, save to disk
        const strategy = classification.download_strategy;
        if (strategy === "browser_required" || strategy === "manual_review") {
          requestJobApproval(db, job.id, {
            reason: `Download strategy "${strategy}" requires manual intervention`,
            vendor: classification.vendor,
          });
          logger.log(`Job ${job.id} paused: ${strategy}`);
          outcome = "paused";
          span.setAttribute("invoice.outcome", "paused");
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }
        addJobEvent(db, job.id, "step_started", { step: "download", strategy });
        file = await downloadInvoice(input, classification, logger);
        mkdirSync(DOWNLOAD_DIR, { recursive: true });
        filePath = `${DOWNLOAD_DIR}/${file.filename}`;
        writeFileSync(filePath, Buffer.from(file.content_base64, "base64"));
        recordDownloadedFile(db, job.id, filePath);
        addJobEvent(db, job.id, "step_completed", {
          step: "download",
          file_path: filePath,
          filename: file.filename,
          size: file.size,
          content_type: file.content_type,
        });
      }

      // Step 1.1: Try to decrypt the PDF if it's password-protected.
      // No-op when BANK_PDF_PASSWORD is unset or the file isn't encrypted.
      // Closes the gap between the email and GDrive paths (task 57). Task 2.4
      // adds the encrypted-PDF guidance pause on top of this hook.
      downloadHelper.tryDecrypt(filePath);

      // Step 1.5: Document classification via channel (non-blocking)
      const cachedDocClassification = completedSteps.get("classify_document");
      if (!cachedDocClassification?.result) {
        await parkForClassification(db, job.id, {
          step: "classify_document",
          parkedPayload: { file_path: filePath },
          channel,
          notificationContent: `Classification request: run document-classifier on the downloaded file and call submit_classification.`,
          notificationMeta: {
            event_type: "classify_document",
            job_id: job.id,
            file_path: filePath,
            vendor: classification.vendor,
          },
        }, logger);
        outcome = "awaiting_classification";
        span.setAttribute("invoice.outcome", "awaiting_classification");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Merge doc classification into email classification
      const docResult = cachedDocClassification.result as Partial<InvoiceClassification> & Record<string, unknown>;
      const mergedClassification: Partial<InvoiceClassification> & Record<string, unknown> = {
        ...mergeClassifications(classification, docResult),
      };
      // Carry forward doc-only fields (doc_date, supply_date, service_period,
      // accounting_period, accounting_period_reasoning, notes) that
      // mergeClassifications doesn't know about but Trigger A / month_tag
      // derivation below rely on.
      for (const k of Object.keys(docResult)) {
        if (!(k in mergedClassification)) {
          mergedClassification[k] = docResult[k];
        }
      }

      // Trigger A resume — apply the most recent unconsumed `guidance_applied`
      // event. For `patch`, merge the user-supplied fields into the cached
      // classification so downstream steps see the real owner/doc_type/etc.
      // For `retry`, we consume the marker and fall through; the plan calls
      // for re-running classify, which at worst produces another unknown.
      // Emitting `guidance_applied_consumed` immediately prevents double-apply
      // on subsequent ticks.
      const allEvents = getJobEvents(db, job.id);
      const unconsumed = findUnconsumedGuidance(allEvents);
      if (unconsumed) {
        if (unconsumed.action === "patch" && unconsumed.patch) {
          Object.assign(mergedClassification, unconsumed.patch);
          logger.log(`Applied guidance patch to classification: ${JSON.stringify(unconsumed.patch)}`);
        } else if (unconsumed.action === "retry") {
          logger.log(`guidance_applied action=retry — consumed marker, continuing with cached classification`);
        }
        addJobEvent(db, job.id, "guidance_applied_consumed", {
          source_event_id: unconsumed.eventId,
        });
      }

      const merged = mergedClassification as InvoiceClassification;
      logger.log(`Merged doc classification (owner=${merged.owner})`);

      // Trigger A: classifier returned `"unknown"` for at least one required
      // field. Pause the job and ask the user via Telegram. Task 57, Trigger A.
      const unknownFields = UNKNOWN_FIELDS.filter(
        (f) => (mergedClassification as Record<string, unknown>)[f] === "unknown",
      );
      if (unknownFields.length > 0) {
        pauseForGuidance(db, job.id, {
          step: "post_classification",
          reason: "classifier_unknown",
          missing_fields: unknownFields,
          suggested_actions: buildSuggestedActions(unknownFields, {
            doc_type: (mergedClassification.doc_type as string | null | undefined) ?? null,
          }),
          context: {
            filename: file.filename,
            sender: classification.sender,
            subject: classification.subject,
            vendor: mergedClassification.vendor ?? null,
            total_amount: mergedClassification.total_amount ?? null,
            doc_date: (mergedClassification as Record<string, unknown>).doc_date ?? null,
            classifier_notes:
              ((mergedClassification as Record<string, unknown>).notes as string | undefined) ?? null,
          },
        });
        logger.log(
          `Job ${job.id} paused (classifier_unknown: ${unknownFields.join(", ")})`,
        );
        outcome = "awaiting_user_guidance";
        span.setAttribute("invoice.outcome", "awaiting_user_guidance");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Step 3.5: Derive month_tag from classification metadata.
      // Document-classifier is the authority — its `accounting_period` reflects
      // explicit reasoning over supply date / service period / doc type / Slovak
      // VAT rules. The deterministic chain is a hardened safety net only.
      const docExt = docResult as {
        doc_date?: string | null;
        supply_date?: string | null;
        service_period?: string | null;
        accounting_period?: string | null;
        accounting_period_reasoning?: string | null;
      };
      if (docExt.accounting_period_reasoning) {
        logger.log(`accounting_period: ${docExt.accounting_period} — ${docExt.accounting_period_reasoning}`);
      }
      const monthTag = resolveMonthTag({
        accountingPeriod: docExt.accounting_period,
        supplyDate: docExt.supply_date,
        servicePeriodStart: parseServicePeriodStart(docExt.service_period),
        docDate: docExt.doc_date,
        subject: classification.subject,
        receivedAt: classification.received_at,
      });
      if (!monthTag) {
        missingMonthTagCounter.add(1, { workflow_type: "invoice_intake" });
        logger.log(`⚠ Job ${job.id}: no valid accounting period resolved — uploading without month tag`);
        if (notify) {
          await notify(`⚠ ${merged.vendor ?? "Document"}: no accounting period detected. Tag manually in Paperless.`).catch(() => {});
        }
      }

      // Step 2: Resolve correspondent
      addJobEvent(db, job.id, "step_started", { step: "resolve_correspondent" });
      const correspondent = await resolveCorrespondent(merged.vendor, logger, registry);
      addJobEvent(db, job.id, "step_completed", {
        step: "resolve_correspondent",
        correspondent,
      });

      // Step 3: Deduplicate
      // If force=true is set, dedup hits do NOT short-circuit — instead the
      // worker captures forceTargetDocId and the upload step PATCHes the
      // existing Paperless document in place. This is the operator's path for
      // "reprocess this and update the doc with the new tags/title/period".
      addJobEvent(db, job.id, "step_started", { step: "deduplicate" });
      const dedupeResult = await checkDuplicate(merged, correspondent, logger, registry);
      let forceTargetDocId: number | undefined;
      if (dedupeResult) {
        addJobEvent(db, job.id, "step_completed", {
          step: "deduplicate",
          ...dedupeResult,
        });

        if (input.force) {
          forceTargetDocId = dedupeResult.existing_id;
          logger.log(`force=true: will refresh existing doc #${forceTargetDocId} (${dedupeResult.outcome}) instead of skipping`);
          span.setAttribute("invoice.force_refresh", true);
          span.setAttribute("invoice.force_target_doc_id", forceTargetDocId);
        } else if (dedupeResult.outcome === "duplicate") {
          const result: InvoiceIntakeResult = {
            outcome: "duplicate",
            duplicate_of: dedupeResult.existing_id,
            duplicate_message: dedupeResult.message,
          };
          completeJob(db, job.id, result);
          logger.log(`Job ${job.id} completed: duplicate of doc #${dedupeResult.existing_id}`);
          outcome = "duplicate";
          span.setAttribute("invoice.outcome", "duplicate");
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        } else if (dedupeResult.outcome === "duplicate_likely") {
          requestJobApproval(db, job.id, {
            reason: dedupeResult.message,
            existing_document_id: dedupeResult.existing_id,
          });
          logger.log(`Job ${job.id} paused: likely duplicate`);
          outcome = "paused";
          span.setAttribute("invoice.outcome", "paused");
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }
      } else {
        addJobEvent(db, job.id, "step_completed", {
          step: "deduplicate",
          outcome: "no_duplicate",
        });
      }

      // Step 4: Resolve tags — derived deterministically from merged classification
      addJobEvent(db, job.id, "step_started", { step: "resolve_tags" });
      const rawOwner = merged.owner;
      if (!rawOwner) {
        const msg = "Missing owner field — document-classifier did not return owner.";
        failJob(db, job.id, { code: "missing_owner", message: msg });
        logger.log(`Job ${job.id} failed: missing owner`);
        outcome = "failed";
        span.setAttribute("invoice.outcome", "failed");
        span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
        return;
      }

      // Single-point owner resolution: payslip → personal, regardless of
      // what the classifier's business-identifier check produced. See
      // invoice-pipeline.ts resolveOwner for the rule.
      const owner = resolveOwner(rawOwner, merged.doc_type);
      span.setAttribute("invoice.owner.raw", rawOwner);
      span.setAttribute("invoice.owner.resolved", owner);

      const allTagNames = buildTagNames(
        { owner, doc_type: merged.doc_type, is_fuel: merged.is_fuel },
        monthTag,
      );
      const tagIds = await resolveTags(allTagNames, logger, registry);
      addJobEvent(db, job.id, "step_completed", { step: "resolve_tags", tags: tagIds });

      // Step 5: Resolve document type
      const documentTypeId = await resolveDocumentType(merged.doc_type, logger, registry);

      // Step 5b: Resolve storage path (uses the SAME resolved owner as tags)
      const storagePathId = await resolveStoragePath(owner, merged.doc_type, logger, registry);

      // Step 6: Upload to Paperless — or PATCH the existing doc if force-refresh.
      addJobEvent(db, job.id, "step_started", { step: "upload" });
      const title = generateTitle(merged.vendor, merged.order_id, merged.subtitle, classification.subject);
      let finalDocId: number | undefined;
      let finalOutcome: "uploaded" | "refreshed";

      if (forceTargetDocId) {
        // Force-refresh path: PATCH the existing doc with fresh metadata.
        // Single request handles title/correspondent/document_type/tags/storage_path/custom_fields.
        const patchResult = await patchPaperlessDocument({
          documentId: forceTargetDocId,
          title,
          correspondentId: correspondent.id,
          tagIds,
          documentTypeId,
          storagePathId,
          totalAmount: merged.total_amount,
          orderId: merged.order_id,
        }, logger, registry);
        addJobEvent(db, job.id, "step_completed", {
          step: "upload",
          mode: "patch",
          document_id: patchResult.document_id,
          title: patchResult.title,
        });
        finalDocId = patchResult.document_id;
        finalOutcome = "refreshed";
      } else {
        const uploadResult = await uploadToPaperless({
          title,
          file,
          correspondentId: correspondent.id,
          tagIds,
          documentTypeId,
          storagePathId,
          totalAmount: merged.total_amount,
          orderId: merged.order_id,
        }, logger, registry);
        addJobEvent(db, job.id, "step_completed", {
          step: "upload",
          mode: "post",
          ...uploadResult,
        });

        // Step 7: Set custom fields (total_amount, order_id) if available.
        // post_document doesn't accept custom fields in multipart, so we PATCH after
        // consumption. The force-refresh path already set them in the single PATCH above.
        if (merged.total_amount != null || merged.order_id) {
          addJobEvent(db, job.id, "step_started", { step: "set_custom_fields" });
          const cfResult = await setDocumentCustomFields(
            uploadResult.task_uuid,
            merged.total_amount,
            merged.order_id,
            logger,
            registry,
          );
          addJobEvent(db, job.id, "step_completed", { step: "set_custom_fields", ...cfResult });
        }
        finalDocId = uploadResult.document_id;
        finalOutcome = "uploaded";
      }

      const result: InvoiceIntakeResult = {
        outcome: finalOutcome,
        title,
        paperless_document_id: finalDocId,
        correspondent: correspondent.name,
        tags: allTagNames,
        total_amount: merged.total_amount,
      };
      completeJob(db, job.id, result);
      logger.log(`Job ${job.id} completed: ${finalOutcome} "${title}" → doc #${finalDocId ?? "?"}`);
      correspondentsCounter.add(1, { correspondent: correspondent.name });
      if (notify) {
        const msg = formatNotification({
          outcome: finalOutcome,
          vendor: correspondent.name,
          total_amount: merged.total_amount,
          currency: merged.currency,
          doc_type: merged.doc_type,
          owner: owner ?? null,
          month_tag: monthTag,
          paperless_document_id: finalDocId,
        });
        if (msg) await notify(msg).catch((e) => {
          span.addEvent("notification_failed", { error: e instanceof Error ? e.message : String(e) });
        });
      }
      outcome = finalOutcome;
      span.setAttribute("invoice.outcome", finalOutcome);
      span.setAttribute("paperless.document_id", finalDocId ?? 0);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errPayload = { code: "invoice_intake_error", message, step: "unknown" };
      if (shouldRetry(db, job.id)) {
        scheduleRetry(db, job.id, errPayload);
        logger.log(`Job ${job.id} scheduled for retry: ${message}`);
        outcome = "retryable";
        span.setAttribute("invoice.outcome", "retryable");
      } else {
        failJob(db, job.id, errPayload);
        logger.log(`Job ${job.id} failed permanently: ${message}`);
        if (notify) {
          const msg = formatNotification({
            outcome: "failed",
            vendor: vendorForSpan,
            total_amount: null,
            currency: null,
            doc_type: null,
            owner: null,
            error: message,
          });
          if (msg) await notify(msg).catch((e) => {
            span.addEvent("notification_failed", { error: e instanceof Error ? e.message : String(e) });
          });
        }
        outcome = "failed";
        span.setAttribute("invoice.outcome", "failed");
      }
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.recordException(error instanceof Error ? error : new Error(message));
    } finally {
      span.setAttribute("invoice.vendor", vendorForSpan ?? "unknown");
      span.setAttribute("invoice.outcome", outcome);
      span.end();
    }
  });
}

// ── Download step ──────────────────────────────────────────────────────
//
// All download logic now lives in `./invoice/download-service.ts`. This
// thin wrapper preserves the in-file call signature so the orchestrator
// (executeInvoiceIntake) doesn't need to know about MCP URLs.

function downloadInvoice(
  input: InvoiceIntakeInput,
  classification: InvoiceClassification,
  logger: WorkerLogger,
): Promise<DownloadedFile> {
  return downloadInvoiceImpl(
    { email_source: input.email_source, message_id: input.message_id },
    {
      sender: classification.sender,
      subject: classification.subject,
      download_strategy: classification.download_strategy,
    },
    { gmail: GMAIL_MCP_URL, outlook: OUTLOOK_MCP_URL },
    GOOGLE_EMAIL,
    logger,
  );
}

// ── Paperless operation wrappers ───────────────────────────────────────
// All Paperless interaction lives in postprocess-service / paperless-adapter.
// These thin wrappers preserve the orchestrator call shape (no need to thread
// the adapter through every step site).

function resolveCorrespondent(
  vendor: string | null,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<CorrespondentInfo> {
  return resolveCorrespondentImpl(vendor, getPaperlessAdapter(registry), logger);
}

function checkDuplicate(
  classification: { order_id: string | null; total_amount: number | null },
  correspondent: CorrespondentInfo,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<DedupeResult | null> {
  return checkDuplicateImpl(classification, correspondent, getPaperlessAdapter(registry), registry, logger);
}

function resolveTags(
  tagNames: string[],
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<number[]> {
  return resolveTagIds(tagNames, getPaperlessAdapter(registry), logger);
}

function resolveDocumentType(
  docType: string,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<number | undefined> {
  return resolveDocumentTypeId(docType, getPaperlessAdapter(registry), logger);
}

function resolveStoragePath(
  owner: string,
  docType: string,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<number | undefined> {
  return resolveStoragePathId(owner, docType, getPaperlessAdapter(registry), logger);
}

interface UploadParams {
  title: string;
  file: DownloadedFile;
  correspondentId: number;
  tagIds: number[];
  documentTypeId?: number;
  storagePathId?: number;
  totalAmount?: number | null;
  orderId?: string | null;
}

function uploadToPaperless(
  params: UploadParams,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<UploadResult> {
  return uploadToPaperlessImpl(
    {
      title: params.title,
      file: params.file,
      correspondentId: params.correspondentId,
      tagIds: params.tagIds,
      documentTypeId: params.documentTypeId,
      storagePathId: params.storagePathId,
      totalAmount: params.totalAmount,
      orderId: params.orderId,
    },
    getPaperlessAdapter(registry),
    logger,
  );
}

interface PatchParams {
  documentId: number;
  title: string;
  correspondentId: number;
  tagIds: number[];
  documentTypeId?: number;
  storagePathId?: number;
  totalAmount?: number | null;
  orderId?: string | null;
}

function patchPaperlessDocument(
  params: PatchParams,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<{ document_id: number; title: string }> {
  return patchExistingDocument(params, getPaperlessAdapter(registry), registry, logger);
}

// ── Scan intake (GDrive) ──────────────────────────────────────────────

export async function executeScanIntake(
  db: Database,
  job: JobRow,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
  notify?: NotifyFn,
  channel?: Server,
): Promise<void> {
  seedCounterFromDb(db);
  const rawInput = parseJobJson<unknown>(job.input_json);
  if (!rawInput) {
    failJob(db, job.id, { code: "invalid_input", message: "Missing or invalid input_json" });
    return;
  }
  let input: ScanIntakeInput;
  try {
    input = validateScanIntakeInput(rawInput) as ScanIntakeInput;
  } catch (err) {
    if (err instanceof WorkflowSchemaError) {
      failJob(db, job.id, {
        code: "schema_validation_failed",
        message: err.message,
        schema: err.schemaName,
        field: err.field,
      });
      return;
    }
    throw err;
  }

  const { file_id, watch_folder, month_tag } = input;

  await tracer.startActiveSpan(`scan-worker.execute`, {
    attributes: {
      "job.id": job.id,
      "job.type": "scan_intake",
      "source": "gdrive",
      // Filename + file_id surfaced on the top-level span so traces are
      // immediately self-identifying in Tempo without drilling into child
      // spans. See task 48, Issue 4.
      "scan.file_id": file_id,
      "scan.filename": input.filename ?? "",
      "scan.watch_folder": watch_folder,
      "gdrive.watch_folder": watch_folder,
    },
  }, async (span: Span) => {
    let outcome = "unknown";
    let vendorForSpan = "unknown";
    try {
      const completedSteps = getCompletedSteps(db, job.id);
      const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/workspace/downloads";

      // Step 1: Download file from GDrive (or read from disk)
      const cachedDownload = completedSteps.get("download") ?? completedSteps.get("read_from_disk");
      let filePath: string;
      let file: DownloadedFile;

      if (cachedDownload) {
        filePath = (cachedDownload as { file_path?: string }).file_path
          ?? `${DOWNLOAD_DIR}/${(cachedDownload as { filename?: string }).filename ?? "unknown"}`;
        file = readFileAsDownload(filePath);
        logger.log(`Resuming: reusing file from ${filePath}`);
      } else if (input.file_path && existsSync(input.file_path)) {
        filePath = input.file_path;
        file = readFileAsDownload(filePath);
        addJobEvent(db, job.id, "step_started", { step: "read_from_disk", file_path: filePath });
        addJobEvent(db, job.id, "step_completed", {
          step: "read_from_disk",
          file_path: filePath,
          filename: file.filename,
          size: file.size,
        });
      } else {
        addJobEvent(db, job.id, "step_started", { step: "download", source: "gdrive" });
        file = await downloadFromGdrive(file_id, input.filename, logger);
        mkdirSync(DOWNLOAD_DIR, { recursive: true });
        filePath = `${DOWNLOAD_DIR}/${file.filename}`;
        writeFileSync(filePath, Buffer.from(file.content_base64, "base64"));
        recordDownloadedFile(db, job.id, filePath);
        addJobEvent(db, job.id, "step_completed", {
          step: "download",
          file_path: filePath,
          filename: file.filename,
          size: file.size,
          content_type: file.content_type,
        });
      }

      // Step 2: Document classification via channel
      const cachedDocClassification = completedSteps.get("classify_document");
      if (!cachedDocClassification?.result) {
        await parkForClassification(db, job.id, {
          step: "classify_document",
          parkedPayload: { file_path: filePath },
          channel,
          notificationContent: `Classification request: run document-classifier on the scanned file and call submit_classification.`,
          notificationMeta: {
            event_type: "classify_document",
            job_id: job.id,
            file_path: filePath,
            source: "gdrive",
          },
        }, logger);
        outcome = "awaiting_classification";
        span.setAttribute("invoice.outcome", "awaiting_classification");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      const classification = cachedDocClassification.result as ScanClassification;
      vendorForSpan = classification.vendor;
      span.setAttribute("invoice.vendor", classification.vendor);

      // Derive month_tag — document-classifier's reasoned accounting_period wins.
      // GDrive scan creation date is only the *last* fallback (a scanned invoice
      // photographed weeks after issue should NOT be tagged by the scan date).
      if (classification.accounting_period_reasoning) {
        logger.log(`accounting_period: ${classification.accounting_period} — ${classification.accounting_period_reasoning}`);
      }
      const resolvedMonthTag = resolveMonthTag({
        accountingPeriod: classification.accounting_period,
        supplyDate: classification.supply_date,
        servicePeriodStart: parseServicePeriodStart(classification.service_period),
        docDate: classification.doc_date,
        scanFallback: month_tag,
      });
      if (!resolvedMonthTag) {
        missingMonthTagCounter.add(1, { workflow_type: "scan_intake" });
        logger.log(`⚠ Job ${job.id}: no valid accounting period resolved — uploading without month tag`);
        if (notify) {
          await notify(`⚠ ${classification.vendor ?? "Scan"}: no accounting period detected. Tag manually in Paperless.`).catch(() => {});
        }
      } else if (resolvedMonthTag !== month_tag) {
        logger.log(`month_tag overridden: ${month_tag} → ${resolvedMonthTag}`);
      }

      // Step 3: Resolve correspondent
      addJobEvent(db, job.id, "step_started", { step: "resolve_correspondent" });
      const correspondent = await resolveCorrespondent(classification.vendor, logger, registry);
      addJobEvent(db, job.id, "step_completed", {
        step: "resolve_correspondent",
        correspondent,
      });

      // Step 4: Deduplicate. force=true switches dedup hits from short-circuit
      // to in-place PATCH (forceTargetDocId captured here, used by upload step).
      addJobEvent(db, job.id, "step_started", { step: "deduplicate" });
      const dedupeResult = await checkDuplicate(classification, correspondent, logger, registry);
      let forceTargetDocId: number | undefined;
      if (dedupeResult) {
        addJobEvent(db, job.id, "step_completed", { step: "deduplicate", ...dedupeResult });

        if (input.force) {
          forceTargetDocId = dedupeResult.existing_id;
          logger.log(`force=true: will refresh existing doc #${forceTargetDocId} (${dedupeResult.outcome}) instead of skipping`);
          span.setAttribute("invoice.force_refresh", true);
          span.setAttribute("invoice.force_target_doc_id", forceTargetDocId);
        } else if (dedupeResult.outcome === "duplicate") {
          completeJob(db, job.id, {
            outcome: "duplicate",
            duplicate_of: dedupeResult.existing_id,
            duplicate_message: dedupeResult.message,
          });
          await moveGdriveFile(file_id, "processed", watch_folder, logger);
          logger.log(`Job ${job.id} completed: duplicate`);
          outcome = "duplicate";
          span.setAttribute("invoice.outcome", "duplicate");
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        } else if (dedupeResult.outcome === "duplicate_likely") {
          requestJobApproval(db, job.id, {
            reason: dedupeResult.message,
            existing_document_id: dedupeResult.existing_id,
          });
          logger.log(`Job ${job.id} paused: likely duplicate`);
          outcome = "paused";
          span.setAttribute("invoice.outcome", "paused");
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }
      } else {
        addJobEvent(db, job.id, "step_completed", { step: "deduplicate", outcome: "no_duplicate" });
      }

      // Step 5: Resolve tags — owner from watch folder LEVEL1
      addJobEvent(db, job.id, "step_started", { step: "resolve_tags" });
      const scanTagOwner = watch_folder.split("/").filter(Boolean)[0];
      const allTagNames = buildTagNames(
        { owner: scanTagOwner, doc_type: classification.doc_type, is_fuel: classification.is_fuel },
        resolvedMonthTag,
      );
      const tagIds = await resolveTags(allTagNames, logger, registry);
      addJobEvent(db, job.id, "step_completed", { step: "resolve_tags", tags: tagIds });

      // Step 6: Resolve document type + storage path
      const documentTypeId = await resolveDocumentType(classification.doc_type, logger, registry);
      const storagePathId = await resolveStoragePath(scanTagOwner, classification.doc_type, logger, registry);

      // Step 7: Upload to Paperless — or PATCH the existing doc if force-refresh.
      addJobEvent(db, job.id, "step_started", { step: "upload" });
      const title = buildScanTitle(classification.vendor, classification.order_id, classification.subtitle, input.filename);
      let finalDocId: number | undefined;
      let finalOutcome: "uploaded" | "refreshed";

      if (forceTargetDocId) {
        const patchResult = await patchPaperlessDocument({
          documentId: forceTargetDocId,
          title,
          correspondentId: correspondent.id,
          tagIds,
          documentTypeId,
          storagePathId,
          totalAmount: classification.total_amount,
          orderId: classification.order_id,
        }, logger, registry);
        addJobEvent(db, job.id, "step_completed", {
          step: "upload",
          mode: "patch",
          document_id: patchResult.document_id,
          title: patchResult.title,
        });
        finalDocId = patchResult.document_id;
        finalOutcome = "refreshed";
      } else {
        const uploadResult = await uploadToPaperless({
          title, file,
          correspondentId: correspondent.id, tagIds, documentTypeId, storagePathId,
          totalAmount: classification.total_amount, orderId: classification.order_id,
        }, logger, registry);
        addJobEvent(db, job.id, "step_completed", { step: "upload", mode: "post", ...uploadResult });

        // Step 8: Set custom fields (post path only — patch path already set them)
        if (classification.total_amount != null || classification.order_id) {
          addJobEvent(db, job.id, "step_started", { step: "set_custom_fields" });
          const cfResult = await setDocumentCustomFields(
            uploadResult.task_uuid, classification.total_amount, classification.order_id, logger, registry,
          );
          addJobEvent(db, job.id, "step_completed", { step: "set_custom_fields", ...cfResult });
        }
        finalDocId = uploadResult.document_id;
        finalOutcome = "uploaded";
      }

      // Step 9: Move GDrive file to Processed/
      await moveGdriveFile(file_id, "processed", watch_folder, logger);

      const result: InvoiceIntakeResult = {
        outcome: finalOutcome, title,
        paperless_document_id: finalDocId,
        correspondent: correspondent.name,
        tags: allTagNames,
        total_amount: classification.total_amount,
      };
      completeJob(db, job.id, result);
      logger.log(`Job ${job.id} completed: ${finalOutcome} "${title}" → doc #${finalDocId ?? "?"}`);
      correspondentsCounter.add(1, { correspondent: correspondent.name });
      if (notify) {
        const msg = formatNotification({
          outcome: finalOutcome,
          vendor: correspondent.name,
          total_amount: classification.total_amount,
          currency: classification.currency,
          doc_type: classification.doc_type,
          owner: scanTagOwner,
          month_tag: resolvedMonthTag,
          paperless_document_id: finalDocId,
        });
        if (msg) await notify(msg).catch((e) => {
          span.addEvent("notification_failed", { error: e instanceof Error ? e.message : String(e) });
        });
      }
      outcome = finalOutcome;
      span.setAttribute("invoice.outcome", finalOutcome);
      span.setAttribute("paperless.document_id", finalDocId ?? 0);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errPayload = { code: "scan_intake_error", message, step: "unknown" };
      if (shouldRetry(db, job.id)) {
        scheduleRetry(db, job.id, errPayload);
        logger.log(`Job ${job.id} scheduled for retry: ${message}`);
        outcome = "retryable";
        span.setAttribute("invoice.outcome", "retryable");
      } else {
        failJob(db, job.id, errPayload);
        await moveGdriveFile(file_id, "errors", watch_folder, logger).catch((moveErr) => {
          logger.log(`Failed to move file to errors/: ${moveErr instanceof Error ? moveErr.message : String(moveErr)}`);
        });
        logger.log(`Job ${job.id} failed permanently: ${message}`);
        if (notify) {
          const msg = formatNotification({
            outcome: "failed", vendor: vendorForSpan,
            total_amount: null, currency: null, doc_type: null, owner: null, error: message,
          });
          if (msg) await notify(msg).catch((e) => {
            span.addEvent("notification_failed", { error: e instanceof Error ? e.message : String(e) });
          });
        }
        outcome = "failed";
        span.setAttribute("invoice.outcome", "failed");
      }
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.recordException(error instanceof Error ? error : new Error(message));
    } finally {
      span.setAttribute("invoice.vendor", vendorForSpan ?? "unknown");
      span.setAttribute("invoice.outcome", outcome);
      span.end();
    }
  });
}

// ── GDrive helpers ────────────────────────────────────────────────────

function downloadFromGdrive(
  fileId: string,
  filename: string | undefined,
  logger: WorkerLogger,
): Promise<DownloadedFile> {
  return downloadFromGdriveImpl(fileId, filename, GMAIL_MCP_URL, GOOGLE_EMAIL, logger);
}

function setDocumentCustomFields(
  taskUuid: string | undefined,
  totalAmount: number | null | undefined,
  orderId: string | null | undefined,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<CustomFieldResult> {
  return setDocumentCustomFieldsImpl(
    taskUuid,
    totalAmount,
    orderId,
    getPaperlessAdapter(registry),
    registry,
    logger,
  );
}

function moveGdriveFile(
  fileId: string,
  targetFolder: string,
  watchFolder: string,
  logger: WorkerLogger,
): Promise<void> {
  return moveGdriveFileImpl(fileId, targetFolder, watchFolder, GMAIL_MCP_URL, GOOGLE_EMAIL, logger);
}
