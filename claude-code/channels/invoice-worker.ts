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

import { getTracer, getMeter, withSpan, SpanStatusCode } from "./tracing";
import type { Span } from "./tracing";

import {
  addJobEvent,
  completeJob,
  failJob,
  getJobEvents,
  parseJobJson,
  recordDownloadedFile,
  requestClassification,
  requestJobApproval,
  scheduleRetry,
  shouldRetry,
  type JobRow,
} from "./workflow-db";
import { callMcpTool, extractJson, extractText } from "./mcp-client";
import type { PaperlessFieldRegistry } from "./paperless-fields";
import { PaperlessAdapter } from "./paperless-adapter";
import { readFileAsDownload } from "./download-helper";
import { extractInvoiceLinks, type InvoiceLink } from "./invoice-links";
import { formatNotification, type NotifyFn } from "./telegram-notify";
import {
  buildTagNames,
  generateTitle,
  getCompletedSteps,
  mergeClassifications,
  parseServicePeriodStart,
  resolveMonthTag,
} from "./invoice-pipeline";
import {
  validateInvoiceIntakeInput,
  validateScanIntakeInput,
  WorkflowSchemaError,
} from "./workflow-schemas";
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
  vendor: string;
  doc_type: string;
  is_fuel: boolean;
  owner?: "techlab" | "personal";
  action: string;
  download_strategy: DownloadStrategy | null;
  strategy_confidence: "high" | "medium" | "low";
  requires_review: boolean;
  order_id: string | null;
  subtitle: string | null;
  total_amount: number | null;
  currency: string | null;
  /** Email subject — required in classify_email result for month_tag and title */
  subject: string;
  /** Email received timestamp ISO — required in classify_email result for month_tag fallback */
  received_at: string;
  /** Email sender — required in classify_email result for link extraction */
  sender: string;
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

interface DownloadedFile {
  filename: string;
  content_base64: string;
  content_type: string;
  size: number;
}

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
        // Park the job and request email classification from Claude
        requestClassification(db, job.id, "classify_email", {
          email_source: input.email_source,
          message_id: input.message_id,
        });
        if (channel) {
          await channel.notification({
            method: "notifications/claude/channel",
            params: {
              content: `Classification request: fetch the email, run email-classifier, and call submit_classification. Include subject and received_at in the result.`,
              meta: {
                event_type: "classify_email",
                job_id: job.id,
                email_source: input.email_source,
                message_id: input.message_id,
              },
            },
          });
        }
        logger.log(`Job ${job.id} parked for email classification`);
        outcome = "awaiting_classification";
        span.setAttribute("invoice.outcome", "awaiting_classification");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      const classification = cachedEmailClass.result as InvoiceClassification;
      vendorForSpan = classification.vendor;
      span.setAttribute("invoice.vendor", classification.vendor);
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

      // Step 1.5: Document classification via channel (non-blocking)
      const cachedDocClassification = completedSteps.get("classify_document");
      if (!cachedDocClassification?.result) {
        requestClassification(db, job.id, "classify_document", { file_path: filePath });
        if (channel) {
          await channel.notification({
            method: "notifications/claude/channel",
            params: {
              content: `Classification request: run document-classifier on the downloaded file and call submit_classification.`,
              meta: {
                event_type: "classify_document",
                job_id: job.id,
                file_path: filePath,
                vendor: classification.vendor,
              },
            },
          });
        }
        logger.log(`Job ${job.id} parked for document classification`);
        outcome = "awaiting_classification";
        span.setAttribute("invoice.outcome", "awaiting_classification");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Merge doc classification into email classification
      const docResult = cachedDocClassification.result as Partial<InvoiceClassification>;
      const merged = mergeClassifications(classification, docResult);
      logger.log(`Merged doc classification (owner=${merged.owner})`);

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
      const owner = merged.owner;
      if (!owner) {
        const msg = "Missing owner field — document-classifier did not return owner.";
        failJob(db, job.id, { code: "missing_owner", message: msg });
        logger.log(`Job ${job.id} failed: missing owner`);
        outcome = "failed";
        span.setAttribute("invoice.outcome", "failed");
        span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
        return;
      }

      const allTagNames = buildTagNames(
        { owner, doc_type: merged.doc_type, is_fuel: merged.is_fuel },
        monthTag,
      );
      const tagIds = await resolveTags(allTagNames, logger, registry);
      addJobEvent(db, job.id, "step_completed", { step: "resolve_tags", tags: tagIds });

      // Step 5: Resolve document type
      const documentTypeId = await resolveDocumentType(merged.doc_type, logger, registry);

      // Step 5b: Resolve storage path
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
          owner: merged.owner ?? null,
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

async function downloadInvoice(
  input: InvoiceIntakeInput,
  classification: InvoiceClassification,
  logger: WorkerLogger,
): Promise<DownloadedFile> {
  return withSpan(tracer, "invoice-worker.download", {
    "download.strategy": classification.download_strategy ?? "unknown",
    "email.source": input.email_source,
    "email.message_id": input.message_id,
  }, async (span) => {
    const { email_source, message_id } = input;
    const strategy = classification.download_strategy;
    const mcpUrl = email_source === "gmail" ? GMAIL_MCP_URL : OUTLOOK_MCP_URL;

    let file: DownloadedFile;
    switch (strategy) {
      case "attachment":
      case "claude_download":
        // claude_download: multiple attachments — worker picks the first PDF (best heuristic)
        file = await downloadAttachment(mcpUrl, email_source, message_id, logger);
        break;

      case "known_link":
      case "direct_url":
        file = await downloadViaLink(input, classification, mcpUrl, logger);
        break;

      default:
        throw new Error(`Unsupported download strategy: ${strategy}`);
    }

    span.setAttribute("download.filename", file.filename);
    span.setAttribute("download.size", file.size);
    return file;
  });
}

async function downloadAttachment(
  mcpUrl: string,
  source: string,
  messageId: string,
  logger: WorkerLogger,
): Promise<DownloadedFile> {
  logger.log(`Downloading attachment from ${source} message ${messageId}`);

  if (source === "outlook") {
    // Get attachments list
    const attachmentsResult = await callMcpTool(mcpUrl, "get_attachments", {
      message_id: messageId,
    });
    const attachmentsText = extractText(attachmentsResult);
    const parsed = JSON.parse(attachmentsText);
    // FastMCP unwraps single-element arrays into a plain object
    const attachments: Array<{ id: string; name: string; content_type: string; size: number }> =
      Array.isArray(parsed) ? parsed : [parsed];

    if (!attachments.length || !attachments[0]?.id) {
      throw new Error("No attachments found on email");
    }

    // Find the best attachment (prefer PDF, then largest)
    const pdfAttachment = attachments.find(
      (a) => a.content_type === "application/pdf" || a.name.toLowerCase().endsWith(".pdf"),
    );
    const target = pdfAttachment ?? attachments[0];

    // Download it
    const downloadResult = await callMcpTool(mcpUrl, "download_attachment", {
      message_id: messageId,
      attachment_id: target.id,
    });
    const downloadData = extractText(downloadResult);
    const dlParsed = JSON.parse(downloadData) as {
      name: string;
      content_type: string;
      size: number;
      content_base64: string;
    };

    return {
      filename: dlParsed.name,
      content_base64: dlParsed.content_base64,
      content_type: dlParsed.content_type,
      size: dlParsed.size,
    };
  }

  if (source === "gmail") {
    // Gmail: get_gmail_message_content lists attachments in --- ATTACHMENTS --- section,
    // then get_gmail_attachment_content downloads a specific one.
    const contentResult = await callMcpTool(mcpUrl, "get_gmail_message_content", {
      message_id: messageId,
      user_google_email: GOOGLE_EMAIL,
    });
    const contentText = extractText(contentResult);

    // Parse attachment metadata from text: "1. file.pdf (mime, size)\n   Attachment ID: abc"
    const attachmentRegex = /\d+\.\s+(.+?)\s+\(([^,]+),\s*[\d.]+\s*KB\)\s*\n\s*Attachment ID:\s*(\S+)/g;
    const attachments: Array<{ filename: string; mimeType: string; attachmentId: string }> = [];
    let match;
    while ((match = attachmentRegex.exec(contentText)) !== null) {
      attachments.push({ filename: match[1], mimeType: match[2], attachmentId: match[3] });
    }

    if (!attachments.length) {
      throw new Error("No attachments found on Gmail message");
    }

    // Find PDF attachment (prefer PDF, fallback to first)
    const target = attachments.find(
      (a) => a.mimeType === "application/pdf" || a.filename.toLowerCase().endsWith(".pdf"),
    ) ?? attachments[0];

    // Download via Gmail MCP — returns a file path or download URL
    const downloadResult = await callMcpTool(mcpUrl, "get_gmail_attachment_content", {
      message_id: messageId,
      attachment_id: target.attachmentId,
      user_google_email: GOOGLE_EMAIL,
    });
    const downloadText = extractText(downloadResult);

    // Extract download URL or file path from text response
    const urlMatch = downloadText.match(/Download URL:\s*(https?:\/\/\S+)/);
    const pathMatch = downloadText.match(/Saved to:\s*(\S+)/);

    if (urlMatch) {
      // HTTP mode — fetch the file from the temporary URL
      const resp = await fetch(urlMatch[1]);
      if (!resp.ok) throw new Error(`Failed to fetch Gmail attachment: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      return {
        filename: target.filename,
        content_base64: buf.toString("base64"),
        content_type: target.mimeType,
        size: buf.length,
      };
    } else if (pathMatch) {
      // stdio mode — read from disk
      const { readFileSync } = await import("fs");
      const buf = readFileSync(pathMatch[1]);
      return {
        filename: target.filename,
        content_base64: buf.toString("base64"),
        content_type: target.mimeType,
        size: buf.length,
      };
    }

    throw new Error("Could not extract file path or URL from Gmail attachment response");
  }

  throw new Error(`Unsupported email source: ${source}`);
}

async function downloadViaLink(
  input: InvoiceIntakeInput,
  classification: InvoiceClassification,
  mcpUrl: string,
  logger: WorkerLogger,
): Promise<DownloadedFile> {
  const { email_source: source, message_id: messageId } = input;
  const { sender, subject } = classification;
  logger.log(`Downloading via link extraction from ${source} message ${messageId}`);

  // 1. Extract invoice links from email HTML
  let links: InvoiceLink[] = [];
  {
    let html: string | undefined;

    if (source === "outlook") {
      const emailResult = await callMcpTool(mcpUrl, "get_email", {
        message_id: messageId,
      });
      const emailData = extractText(emailResult);
      const parsed = JSON.parse(emailData);
      html = parsed.body_html ?? "";
    } else if (source === "gmail") {
      const contentResult = await callMcpTool(mcpUrl, "get_gmail_message_content", {
        message_id: messageId,
        user_google_email: process.env.GMAIL_EMAIL ?? "",
        body_format: "html",
      });
      html = extractText(contentResult);
    }

    if (html) {
      links = extractInvoiceLinks(html, sender, subject);
    }
  }

  if (!links.length) {
    throw new Error("No invoice download links found in email");
  }

  // 2. Download the first matching link
  logger.log(`Downloading invoice from: ${links[0].url}`);
  return downloadInvoiceUrl(links[0].url);
}

/** Download a file from an invoice URL. Retries with browser headers on 403/409/429. */
async function downloadInvoiceUrl(url: string): Promise<DownloadedFile> {
  let resp = await fetch(url, { redirect: "follow" });

  // Retry with browser-like headers if blocked
  if (resp.status === 403 || resp.status === 409 || resp.status === 429) {
    resp = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8",
      },
    });
  }

  if (resp.status === 403 || resp.status === 409 || resp.status === 429) {
    throw new Error(`Download failed: HTTP ${resp.status}. Link may have expired.`);
  }

  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }

  const buffer = await resp.arrayBuffer();
  const content_base64 = Buffer.from(buffer).toString("base64");

  // Extract filename from Content-Disposition or URL
  let filename: string | undefined;
  const cd = resp.headers.get("content-disposition") ?? "";
  if (cd.includes("filename=")) {
    const names = cd.match(/filename[*]?=["']?([^"';]+)/);
    filename = names?.[1];
  }
  if (!filename) {
    filename = new URL(url).pathname.split("/").pop() || "download.pdf";
    if (buffer.byteLength > 4) {
      const header = new Uint8Array(buffer.slice(0, 5));
      const isPdf = header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46;
      if (isPdf && !filename.toLowerCase().endsWith(".pdf")) {
        filename += ".pdf";
      }
    }
  }

  return {
    filename: filename!,
    content_base64,
    content_type: resp.headers.get("content-type") ?? "application/pdf",
    size: buffer.byteLength,
  };
}

// ── Paperless operations ───────────────────────────────────────────────

interface CorrespondentInfo {
  id: number;
  name: string;
}

async function resolveCorrespondent(
  vendor: string,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<CorrespondentInfo> {
  logger.log(`Resolving correspondent for vendor: ${vendor}`);
  const adapter = getPaperlessAdapter(registry);
  const match = await adapter.findCorrespondent(vendor);
  if (match) {
    logger.log(`Fuzzy matched "${vendor}" → "${match.name}" (score: ${(match.score ?? 0).toFixed(3)})`);
    return { id: match.id, name: match.name };
  }
  logger.log(`Creating new correspondent: ${vendor}`);
  return adapter.createCorrespondent(vendor);
}

interface DedupeResult {
  outcome: "duplicate" | "duplicate_likely";
  existing_id: number;
  message: string;
}

async function checkDuplicate(
  classification: { order_id: string | null; total_amount: number | null },
  correspondent: CorrespondentInfo,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<DedupeResult | null> {
  return withSpan(tracer, "invoice-worker.dedup", {
    "dedup.order_id": classification.order_id ?? "none",
    "dedup.correspondent": correspondent.name,
  }, async (span) => {
    if (!classification.order_id) {
      logger.log("No order_id — skipping dedup check");
      span.setAttribute("dedup.outcome", "no_duplicate");
      return null;
    }

    logger.log(`Checking for duplicate: order_id=${classification.order_id}`);
    const adapter = getPaperlessAdapter(registry);
    const docs = await adapter.searchDocumentsByCustomFieldAndCorrespondent(
      classification.order_id,
      correspondent.id,
      logger,
    );

    if (!docs.length) {
      span.setAttribute("dedup.outcome", "no_duplicate");
      return null;
    }

    // Extract custom field values by field ID
    const orderIdFieldId = registry.getFieldId("order_id");
    const totalAmountFieldId = registry.getFieldId("total_amount");

    for (const doc of docs) {
      const existingOrderId = doc.custom_fields.find(cf => cf.field === orderIdFieldId)?.value as string | undefined;
      if (existingOrderId === classification.order_id) {
        const existingAmount = doc.custom_fields.find(cf => cf.field === totalAmountFieldId)?.value as number | undefined;
        if (
          existingAmount != null &&
          classification.total_amount != null &&
          existingAmount !== classification.total_amount
        ) {
          span.setAttribute("dedup.outcome", "duplicate_likely");
          return {
            outcome: "duplicate_likely",
            existing_id: doc.id,
            message: `Order ${classification.order_id} matches doc #${doc.id} "${doc.title}" but amount differs (${existingAmount} vs ${classification.total_amount})`,
          };
        }

        span.setAttribute("dedup.outcome", "duplicate");
        return {
          outcome: "duplicate",
          existing_id: doc.id,
          message: `Order ${classification.order_id} already exists as doc #${doc.id} "${doc.title}"`,
        };
      }
    }

    span.setAttribute("dedup.outcome", "no_duplicate");
    return null;
  });
}

async function resolveTags(
  tagNames: string[],
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<number[]> {
  return getPaperlessAdapter(registry).resolveTagIds(tagNames, logger);
}

async function resolveDocumentType(
  docType: string,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<number | undefined> {
  const paperlessTypeName = DOC_TYPE_TO_PAPERLESS[docType];
  if (!paperlessTypeName) return undefined;
  return getPaperlessAdapter(registry).findDocumentTypeId(paperlessTypeName, logger);
}

// Storage path name mapping: owner → bucket → Paperless storage path name
const STORAGE_PATH_NAMES: Record<string, Record<string, string>> = {
  techlab: {
    invoices: "Techlab Invoices",
    documents: "Techlab Documents",
  },
  personal: {
    invoices: "Personal Invoices",
    documents: "Personal Documents",
  },
};

// Reuse the typeMap for bucket resolution (Invoice → invoices, Document → documents)
const DOC_TYPE_TO_PAPERLESS: Record<string, string> = {
  invoice: "Invoice",
  receipt: "Invoice",
  credit_note: "Invoice",
  account_statement: "Document",
  document: "Document",
  statement: "Document",
  other: "Document",
};

async function resolveStoragePath(
  owner: string,
  docType: string,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<number | undefined> {
  const paperlessType = DOC_TYPE_TO_PAPERLESS[docType] ?? "Document";
  const bucket = paperlessType === "Invoice" ? "invoices" : "documents";
  const pathName = STORAGE_PATH_NAMES[owner]?.[bucket];
  if (!pathName) {
    logger.log(`No storage path mapping for owner=${owner}, docType=${docType}`);
    return undefined;
  }
  return getPaperlessAdapter(registry).findStoragePathId(pathName, logger);
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

interface UploadResult {
  document_id?: number;
  task_uuid?: string;
  title: string;
}

async function uploadToPaperless(
  params: UploadParams,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<UploadResult> {
  const adapter = getPaperlessAdapter(registry);
  const r = await adapter.uploadDocument(
    {
      filename: params.file.filename,
      content_base64: params.file.content_base64,
      content_type: params.file.content_type,
    },
    {
      title: params.title,
      correspondentId: params.correspondentId,
      tagIds: params.tagIds,
      documentTypeId: params.documentTypeId,
      storagePathId: params.storagePathId,
    },
    logger,
  );
  return { task_uuid: r.task_uuid, title: params.title };
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

/**
 * PATCH an existing Paperless document with fresh metadata. Used by the
 * force-refresh path: when the operator explicitly asks to reprocess a doc
 * that already exists in Paperless, we re-derive title/tags/correspondent/etc.
 * from the new pipeline run and patch the existing doc in place — preserving
 * the doc id, the original PDF, OCR, page count, and thumbnail.
 *
 * Single PATCH request hits all metadata at once: title, correspondent,
 * document_type, tags, storage_path, custom_fields. The custom_fields array
 * is replaced wholesale, which is what we want — fresh values overwrite stale.
 */
async function patchPaperlessDocument(
  params: PatchParams,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<{ document_id: number; title: string }> {
  // Build custom_fields array from the same registry the upload path uses.
  const customFields: Array<{ field: number; value: unknown }> = [];
  if (params.totalAmount != null) {
    customFields.push({ field: registry.getFieldId("total_amount"), value: params.totalAmount });
  }
  if (params.orderId) {
    customFields.push({ field: registry.getFieldId("order_id"), value: params.orderId });
  }
  return getPaperlessAdapter(registry).patchDocument(
    params.documentId,
    {
      title: params.title,
      correspondentId: params.correspondentId,
      tagIds: params.tagIds,
      documentTypeId: params.documentTypeId,
      storagePathId: params.storagePathId,
      customFields,
    },
    logger,
  );
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
        requestClassification(db, job.id, "classify_document", { file_path: filePath });
        if (channel) {
          await channel.notification({
            method: "notifications/claude/channel",
            params: {
              content: `Classification request: run document-classifier on the scanned file and call submit_classification.`,
              meta: {
                event_type: "classify_document",
                job_id: job.id,
                file_path: filePath,
                source: "gdrive",
              },
            },
          });
        }
        logger.log(`Job ${job.id} parked for document classification`);
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
          owner: classification.owner ?? null,
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

function buildScanTitle(
  vendor: string,
  orderId: string | null | undefined,
  subtitle: string | null | undefined,
  filename: string | undefined,
): string {
  if (orderId) {
    return `${vendor} - ${orderId}`;
  }
  if (subtitle) {
    return `${vendor} - ${subtitle}`;
  }
  if (filename) {
    // Strip extension and use as title context
    const cleaned = filename.replace(/\.[^.]+$/, "").trim().slice(0, 80);
    return `${vendor} - ${cleaned}`;
  }
  return `${vendor} - scan`;
}

// ── GDrive helpers ────────────────────────────────────────────────────

async function downloadFromGdrive(
  fileId: string,
  filename: string | undefined,
  logger: WorkerLogger,
): Promise<DownloadedFile> {
  logger.log(`Downloading file ${fileId} from GDrive`);

  // Step 1: Get download URL via Drive MCP
  const urlResult = await callMcpTool(GMAIL_MCP_URL, "get_drive_file_download_url", {
    file_id: fileId,
    user_google_email: GOOGLE_EMAIL,
  });
  const urlText = extractText(urlResult);
  if (!urlText) throw new Error("Failed to get download URL from GDrive");

  // Extract URL from response (may be JSON or text with URL)
  let downloadUrl: string;
  try {
    const parsed = JSON.parse(urlText);
    downloadUrl = parsed.url ?? parsed.download_url ?? parsed.webContentLink ?? "";
  } catch {
    // Try to extract URL from text
    const urlMatch = urlText.match(/https?:\/\/[^\s"<>]+/);
    downloadUrl = urlMatch ? urlMatch[0] : "";
  }
  if (!downloadUrl) throw new Error(`Could not extract download URL from: ${urlText.slice(0, 200)}`);

  // The MCP server returns localhost URLs, but we're in Docker — replace with container hostname
  downloadUrl = downloadUrl.replace("http://localhost:8000", GMAIL_MCP_URL.replace("/mcp", ""));
  logger.log(`Got download URL for ${fileId}`);

  // Step 2: Download the actual file binary
  const resolvedFilename = filename ?? `gdrive-${fileId}`;

  const response = await fetch(downloadUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`GDrive download failed: ${response.status} ${response.statusText}`);

  const arrayBuffer = await response.arrayBuffer();
  const contentBase64 = Buffer.from(arrayBuffer).toString("base64");

  // Determine content type from response or filename
  let contentType = response.headers.get("content-type") ?? "application/pdf";
  const ext = resolvedFilename.toLowerCase().split(".").pop();
  if (contentType === "application/octet-stream") {
    if (ext === "jpg" || ext === "jpeg") contentType = "image/jpeg";
    else if (ext === "png") contentType = "image/png";
    else if (ext === "heic") contentType = "image/heic";
    else contentType = "application/pdf";
  }

  return {
    filename: resolvedFilename,
    content_base64: contentBase64,
    content_type: contentType,
    size: arrayBuffer.byteLength,
  };
}

interface CustomFieldResult {
  doc_id?: number;
  fields_set?: Array<{ field: number; value: unknown }>;
  verified?: unknown;
  error?: string;
}

async function setDocumentCustomFields(
  taskUuid: string | undefined,
  totalAmount: number | null | undefined,
  orderId: string | null | undefined,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
): Promise<CustomFieldResult> {
  return withSpan(tracer, "invoice-worker.set_fields", {
    "fields.total_amount": String(totalAmount ?? ""),
    "fields.order_id": orderId ?? "",
    "fields.task_uuid": taskUuid ?? "",
  }, async (span) => {
    if (!taskUuid) {
      logger.log("Warning: no task UUID from upload, cannot set custom fields");
      return { error: "no task UUID" };
    }

    const adapter = getPaperlessAdapter(registry);

    try {
      const consumed = await adapter.waitForConsumption(taskUuid, logger);
      if (consumed.status === "FAILURE") {
        return { error: `consumption failed: ${consumed.result?.slice(0, 100)}` };
      }
      const docId = consumed.doc_id;
      if (!docId) {
        logger.log(`Warning: could not resolve document ID from task ${taskUuid}`);
        return { error: `could not resolve doc ID from task ${taskUuid}` };
      }

      span.setAttribute("fields.doc_id", docId);

      // Build custom_fields array for PATCH
      const customFields: Array<{ field: number; value: unknown }> = [];
      if (totalAmount != null) {
        customFields.push({ field: registry.getFieldId("total_amount"), value: totalAmount });
      }
      if (orderId) {
        customFields.push({ field: registry.getFieldId("order_id"), value: orderId });
      }
      if (customFields.length === 0) return { doc_id: docId, error: "no fields to set" };

      const result = await adapter.setCustomFields(docId, customFields, logger);
      if (!result.ok) {
        return { doc_id: docId, fields_set: customFields, error: result.error };
      }
      return { doc_id: docId, fields_set: customFields, verified: result.verified };
    } catch (e: any) {
      logger.log(`Warning: failed to set custom fields: ${e.message}`);
      return { error: e.message };
    }
  });
}

function extractDriveFolderId(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed[0].id ?? parsed[0].fileId;
    }
    if (typeof parsed === "object" && parsed !== null) {
      return parsed.id ?? parsed.fileId;
    }
  } catch {
    const idMatch = text.match(/ID:\s*([^,\s)]+)/);
    if (idMatch) return idMatch[1].trim();
  }
  return undefined;
}

async function moveGdriveFile(
  fileId: string,
  targetFolder: string,
  watchFolder: string,
  logger: WorkerLogger,
): Promise<void> {
  return withSpan(tracer, "invoice-worker.move_file", {
    "gdrive.file_id": fileId,
    "gdrive.target_folder": targetFolder,
    "gdrive.watch_folder": watchFolder,
  }, async (_span) => {
    try {
      // Resolve watch folder (level2) ID — the parent where processed/errors subfolders live
      const watchFolderLeaf = watchFolder.split("/").pop()!;
      const watchResult = await callMcpTool(GMAIL_MCP_URL, "search_drive_files", {
        query: `name = '${watchFolderLeaf}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        user_google_email: GOOGLE_EMAIL,
      });
      const watchText = extractText(watchResult);
      const watchFolderId = watchText ? extractDriveFolderId(watchText) : undefined;

      // Resolve target subfolder (e.g. "processed") within the watch folder
      let targetFolderId: string | undefined;
      if (watchFolderId) {
        const searchResult = await callMcpTool(GMAIL_MCP_URL, "search_drive_files", {
          query: `name = '${targetFolder}' and '${watchFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          user_google_email: GOOGLE_EMAIL,
        });
        const searchText = extractText(searchResult);
        if (searchText) {
          targetFolderId = extractDriveFolderId(searchText);
        }
      }

      // Create target folder if it doesn't exist
      if (!targetFolderId && watchFolderId) {
        logger.log(`Creating folder "${targetFolder}" in ${watchFolder}`);
        const createResult = await callMcpTool(GMAIL_MCP_URL, "create_drive_folder", {
          name: targetFolder,
          parent_id: watchFolderId,
          user_google_email: GOOGLE_EMAIL,
        });
        const createText = extractText(createResult);
        if (createText) targetFolderId = extractDriveFolderId(createText);
      }

      if (!targetFolderId) {
        logger.log(`Warning: could not find or create folder "${targetFolder}" in ${watchFolder}, skipping move`);
        return;
      }

      await callMcpTool(GMAIL_MCP_URL, "update_drive_file", {
        file_id: fileId,
        add_parents: targetFolderId,
        remove_parents: watchFolderId ?? undefined,
        user_google_email: GOOGLE_EMAIL,
      });
      logger.log(`Moved file ${fileId} to ${watchFolder}/${targetFolder}/`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.log(`Warning: failed to move GDrive file ${fileId} to ${watchFolder}/${targetFolder}/: ${message}`);
    }
  });
}
