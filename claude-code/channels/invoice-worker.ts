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
  requestClassification,
  requestJobApproval,
  scheduleRetry,
  shouldRetry,
  type JobRow,
} from "./workflow-db";
import { callMcpTool, extractJson, extractText } from "./mcp-client";
import type { PaperlessFieldRegistry } from "./paperless-fields";
import { readFileAsDownload } from "./download-helper";
import { extractInvoiceLinks, type InvoiceLink } from "./invoice-links";
import { findBestCorrespondentMatch } from "./fuzzy-match";
import { formatNotification, type NotifyFn } from "./telegram-notify";
import { buildTagNames, generateTitle, getCompletedSteps, mergeClassifications, resolveMonthTag } from "./invoice-pipeline";
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
}

export interface InvoiceIntakeResult {
  outcome: "uploaded" | "duplicate" | "duplicate_likely" | "paused" | "failed";
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

const tracer = getTracer("invoice-worker");
const meter = getMeter("invoice-worker");
const correspondentsCounter = meter.createCounter("invoice_worker_correspondents_total", {
  description: "Completed invoices by normalized Paperless correspondent",
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
  const input = parseJobJson<InvoiceIntakeInput>(job.input_json);
  if (!input) {
    failJob(db, job.id, { code: "invalid_input", message: "Missing or invalid input_json" });
    return;
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

      // Step 3.5: Derive month_tag from classification metadata
      const docDate = (docResult as { doc_date?: string }).doc_date ?? null;
      const monthTag = resolveMonthTag(
        classification.subject,
        classification.received_at,
        docDate,
      );

      // Step 2: Resolve correspondent
      addJobEvent(db, job.id, "step_started", { step: "resolve_correspondent" });
      const correspondent = await resolveCorrespondent(merged.vendor, logger);
      addJobEvent(db, job.id, "step_completed", {
        step: "resolve_correspondent",
        correspondent,
      });

      // Step 3: Deduplicate
      addJobEvent(db, job.id, "step_started", { step: "deduplicate" });
      const dedupeResult = await checkDuplicate(merged, correspondent, logger, registry);
      if (dedupeResult) {
        addJobEvent(db, job.id, "step_completed", {
          step: "deduplicate",
          ...dedupeResult,
        });

        if (dedupeResult.outcome === "duplicate") {
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
        }

        if (dedupeResult.outcome === "duplicate_likely") {
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
      const tagIds = await resolveTags(allTagNames, logger);
      addJobEvent(db, job.id, "step_completed", { step: "resolve_tags", tags: tagIds });

      // Step 5: Resolve document type
      const documentTypeId = await resolveDocumentType(merged.doc_type, logger);

      // Step 5b: Resolve storage path
      const storagePathId = await resolveStoragePath(owner, merged.doc_type, logger);

      // Step 6: Upload to Paperless
      addJobEvent(db, job.id, "step_started", { step: "upload" });
      const title = generateTitle(merged.vendor, merged.order_id, merged.subtitle, classification.subject);
      const uploadResult = await uploadToPaperless({
        title,
        file,
        correspondentId: correspondent.id,
        tagIds,
        documentTypeId,
        storagePathId,
        totalAmount: merged.total_amount,
        orderId: merged.order_id,
      }, logger);
      addJobEvent(db, job.id, "step_completed", {
        step: "upload",
        ...uploadResult,
      });

      // Step 7: Set custom fields (total_amount, order_id) if available
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

      const result: InvoiceIntakeResult = {
        outcome: "uploaded",
        title,
        paperless_document_id: uploadResult.document_id,
        correspondent: correspondent.name,
        tags: allTagNames,
        total_amount: merged.total_amount,
      };
      completeJob(db, job.id, result);
      logger.log(`Job ${job.id} completed: uploaded "${title}" to Paperless`);
      correspondentsCounter.add(1, { correspondent: correspondent.name });
      if (notify) {
        const msg = formatNotification({
          outcome: "uploaded",
          vendor: correspondent.name,
          total_amount: merged.total_amount,
          currency: merged.currency,
          doc_type: merged.doc_type,
          owner: merged.owner ?? null,
        });
        if (msg) await notify(msg).catch((e) => {
          span.addEvent("notification_failed", { error: e instanceof Error ? e.message : String(e) });
        });
      }
      outcome = "uploaded";
      span.setAttribute("invoice.outcome", "uploaded");
      span.setAttribute("paperless.document_id", uploadResult.document_id ?? 0);
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
      span.updateName(`invoice-worker.execute ${vendorForSpan} → ${outcome}`);
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
      size: parsed.size,
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
): Promise<CorrespondentInfo> {
  return withSpan(tracer, "invoice-worker.resolve_correspondent", {
    "correspondent.vendor": vendor,
  }, async (span) => {
    logger.log(`Resolving correspondent for vendor: ${vendor}`);

    const listResult = await callMcpTool(PAPERLESS_MCP_URL, "list_correspondents", {});
    const listText = extractText(listResult);
    const parsed = JSON.parse(listText);
    // Paperless MCP returns paginated object { results: [...] }, not a raw array
    const correspondents = (Array.isArray(parsed) ? parsed : parsed.results ?? []) as Array<{ id: number; name: string }>;

    // Fuzzy match (handles legal suffix spacing variants from LLM output)
    const match = findBestCorrespondentMatch(vendor, correspondents);
    if (match) {
      logger.log(`Fuzzy matched "${vendor}" → "${match.name}" (score: ${match.score.toFixed(3)})`);
      span.setAttribute("correspondent.id", match.id);
      span.setAttribute("correspondent.name", match.name);
      span.setAttribute("correspondent.match_score", match.score);
      return { id: match.id, name: match.name };
    }

    // Create new correspondent
    logger.log(`Creating new correspondent: ${vendor}`);
    const createResult = await callMcpTool(PAPERLESS_MCP_URL, "create_correspondent", {
      name: vendor,
    });
    const createText = extractText(createResult);
    const created = JSON.parse(createText) as { id: number; name: string };
    span.setAttribute("correspondent.id", created.id);
    span.setAttribute("correspondent.name", created.name);
    return { id: created.id, name: created.name };
  });
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

    // Search via direct Paperless API using custom_fields__icontains
    // (paperless-mcp search_documents does full-text search which doesn't reliably find custom field values)
    const paperlessUrl = process.env.PAPERLESS_URL;
    if (!paperlessUrl) throw new Error("PAPERLESS_URL environment variable is required");
    const paperlessToken = process.env.PAPERLESS_API_TOKEN ?? "";

    const searchParams = new URLSearchParams({
      custom_fields__icontains: classification.order_id,
      correspondent__id: String(correspondent.id),
      page_size: "10",
    });

    const response = await fetch(`${paperlessUrl}/api/documents/?${searchParams}`, {
      headers: { "Authorization": `Token ${paperlessToken}` },
    });

    if (!response.ok) {
      logger.log(`Warning: dedup search failed (${response.status}), skipping`);
      span.setAttribute("dedup.outcome", "no_duplicate");
      return null;
    }

    const data = await response.json() as { results: Array<{ id: number; title: string; custom_fields: Array<{ field: number; value: unknown }> }> };
    const docs = data.results;

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
): Promise<number[]> {
  if (!tagNames.length) return [];

  return withSpan(tracer, "invoice-worker.resolve_tags", {
    "tags.count": tagNames.length,
  }, async (_span) => {
    const listResult = await callMcpTool(PAPERLESS_MCP_URL, "list_tags", {});
    const listText = extractText(listResult);
    const parsedTags = JSON.parse(listText);
    const tags = (Array.isArray(parsedTags) ? parsedTags : parsedTags.results ?? []) as Array<{ id: number; name: string }>;

    const tagIds: number[] = [];
    for (const name of tagNames) {
      const match = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (match) {
        tagIds.push(match.id);
      } else {
        // Create tag if it doesn't exist (e.g., new month tag)
        logger.log(`Creating tag: ${name}`);
        const createResult = await callMcpTool(PAPERLESS_MCP_URL, "create_tag", { name });
        const createText = extractText(createResult);
        const created = JSON.parse(createText) as { id: number };
        tagIds.push(created.id);
      }
    }

    return tagIds;
  });
}

async function resolveDocumentType(
  docType: string,
  logger: WorkerLogger,
): Promise<number | undefined> {
  const paperlessTypeName = DOC_TYPE_TO_PAPERLESS[docType];
  if (!paperlessTypeName) return undefined;

  try {
    const listResult = await callMcpTool(PAPERLESS_MCP_URL, "list_document_types", {});
    const listText = extractText(listResult);
    const parsedTypes = JSON.parse(listText);
    const types = (Array.isArray(parsedTypes) ? parsedTypes : parsedTypes.results ?? []) as Array<{ id: number; name: string }>;
    const match = types.find(
      (t) => t.name.toLowerCase() === paperlessTypeName.toLowerCase(),
    );
    return match?.id;
  } catch {
    // list_document_types may not exist on all paperless-mcp versions
    logger.log(`Could not resolve document type: ${docType}`);
    return undefined;
  }
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
): Promise<number | undefined> {
  const paperlessType = DOC_TYPE_TO_PAPERLESS[docType] ?? "Document";
  const bucket = paperlessType === "Invoice" ? "invoices" : "documents";
  const pathName = STORAGE_PATH_NAMES[owner]?.[bucket];
  if (!pathName) {
    logger.log(`No storage path mapping for owner=${owner}, docType=${docType}`);
    return undefined;
  }

  const paperlessUrl = process.env.PAPERLESS_URL;
  if (!paperlessUrl) return undefined;
  const paperlessToken = process.env.PAPERLESS_API_TOKEN ?? "";

  try {
    const response = await fetch(`${paperlessUrl}/api/storage_paths/`, {
      headers: { Authorization: `Token ${paperlessToken}` },
    });
    if (!response.ok) {
      logger.log(`Failed to fetch storage paths: ${response.status}`);
      return undefined;
    }

    const data = (await response.json()) as { results: Array<{ id: number; name: string }> };
    const paths = data.results ?? [];
    const match = paths.find((p) => p.name.toLowerCase() === pathName.toLowerCase());
    if (!match) {
      logger.log(`Storage path not found: ${pathName}`);
      return undefined;
    }

    return match.id;
  } catch (err) {
    logger.log(`Error resolving storage path: ${err}`);
    return undefined;
  }
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
): Promise<UploadResult> {
  return withSpan(tracer, "invoice-worker.upload", {
    "upload.title": params.title,
    "upload.filename": params.file.filename,
    "upload.correspondent_id": params.correspondentId,
    "upload.tag_ids": params.tagIds.join(","),
    "upload.document_type_id": params.documentTypeId ?? 0,
    "upload.storage_path_id": params.storagePathId ?? 0,
    "upload.total_amount": String(params.totalAmount ?? ""),
    "upload.order_id": params.orderId ?? "",
    "upload.file_size": params.file.content_base64.length,
  }, async (span) => {
    logger.log(`Uploading to Paperless: "${params.title}"`);

    // Upload directly to Paperless API (bypasses paperless-mcp to avoid
    // 413 Payload Too Large on base64-encoded files over ~200KB).
    const paperlessUrl = process.env.PAPERLESS_URL;
    if (!paperlessUrl) throw new Error("PAPERLESS_URL environment variable is required");
    const paperlessToken = process.env.PAPERLESS_API_TOKEN ?? "";
    const fileBuffer = Buffer.from(params.file.content_base64, "base64");

    // Build multipart form data manually
    const boundary = `----FormBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    // File field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${params.file.filename}"\r\nContent-Type: ${params.file.content_type}\r\n\r\n`
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from("\r\n"));

    // Title
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${params.title}\r\n`
    ));

    // Correspondent
    if (params.correspondentId) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="correspondent"\r\n\r\n${params.correspondentId}\r\n`
      ));
    }

    // Document type
    if (params.documentTypeId) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="document_type"\r\n\r\n${params.documentTypeId}\r\n`
      ));
    }

    // Tags (one field per tag)
    for (const tagId of params.tagIds) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="tags"\r\n\r\n${tagId}\r\n`
      ));
    }

    // Storage path
    if (params.storagePathId) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="storage_path"\r\n\r\n${params.storagePathId}\r\n`
      ));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const response = await fetch(`${paperlessUrl}/api/documents/post_document/`, {
      method: "POST",
      headers: {
        "Authorization": `Token ${paperlessToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Paperless upload failed (${response.status}): ${errText.slice(0, 200)}`);
    }

    const resultText = await response.text();
    logger.log(`Upload response: ${resultText}`);

    // post_document returns a task UUID string (e.g. "abc-123-def")
    const taskUuid = resultText.replace(/^["'\s]+|["'\s]+$/g, "");

    span.setAttribute("upload.task_uuid", taskUuid);
    return { task_uuid: taskUuid, title: params.title };
  });
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
  const input = parseJobJson<ScanIntakeInput>(job.input_json);
  if (!input) {
    failJob(db, job.id, { code: "invalid_input", message: "Missing or invalid input_json" });
    return;
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

      // Derive month_tag from doc_date if available, fall back to scan date from input
      const resolvedMonthTag = resolveMonthTag(null, null, classification.doc_date) ?? month_tag;
      if (resolvedMonthTag !== month_tag) {
        logger.log(`month_tag overridden: ${month_tag} → ${resolvedMonthTag} (from doc_date ${classification.doc_date})`);
      }

      // Step 3: Resolve correspondent
      addJobEvent(db, job.id, "step_started", { step: "resolve_correspondent" });
      const correspondent = await resolveCorrespondent(classification.vendor, logger);
      addJobEvent(db, job.id, "step_completed", {
        step: "resolve_correspondent",
        correspondent,
      });

      // Step 4: Deduplicate
      addJobEvent(db, job.id, "step_started", { step: "deduplicate" });
      const dedupeResult = await checkDuplicate(classification, correspondent, logger, registry);
      if (dedupeResult) {
        addJobEvent(db, job.id, "step_completed", { step: "deduplicate", ...dedupeResult });

        if (dedupeResult.outcome === "duplicate") {
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
        }

        if (dedupeResult.outcome === "duplicate_likely") {
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
      const tagIds = await resolveTags(allTagNames, logger);
      addJobEvent(db, job.id, "step_completed", { step: "resolve_tags", tags: tagIds });

      // Step 6: Resolve document type + storage path
      const documentTypeId = await resolveDocumentType(classification.doc_type, logger);
      const storagePathId = await resolveStoragePath(scanTagOwner, classification.doc_type, logger);

      // Step 7: Upload to Paperless
      addJobEvent(db, job.id, "step_started", { step: "upload" });
      const title = buildScanTitle(classification.vendor, classification.order_id, classification.subtitle, input.filename);
      const uploadResult = await uploadToPaperless({
        title, file,
        correspondentId: correspondent.id, tagIds, documentTypeId, storagePathId,
        totalAmount: classification.total_amount, orderId: classification.order_id,
      }, logger);
      addJobEvent(db, job.id, "step_completed", { step: "upload", ...uploadResult });

      // Step 8: Set custom fields
      if (classification.total_amount != null || classification.order_id) {
        addJobEvent(db, job.id, "step_started", { step: "set_custom_fields" });
        const cfResult = await setDocumentCustomFields(
          uploadResult.task_uuid, classification.total_amount, classification.order_id, logger, registry,
        );
        addJobEvent(db, job.id, "step_completed", { step: "set_custom_fields", ...cfResult });
      }

      // Step 9: Move GDrive file to Processed/
      await moveGdriveFile(file_id, "processed", watch_folder, logger);

      const result: InvoiceIntakeResult = {
        outcome: "uploaded", title,
        paperless_document_id: uploadResult.document_id,
        correspondent: correspondent.name,
        tags: allTagNames,
        total_amount: classification.total_amount,
      };
      completeJob(db, job.id, result);
      logger.log(`Job ${job.id} completed: uploaded "${title}" to Paperless`);
      correspondentsCounter.add(1, { correspondent: correspondent.name });
      if (notify) {
        const msg = formatNotification({
          outcome: "uploaded",
          vendor: correspondent.name,
          total_amount: classification.total_amount,
          currency: classification.currency,
          doc_type: classification.doc_type,
          owner: classification.owner ?? null,
        });
        if (msg) await notify(msg).catch((e) => {
          span.addEvent("notification_failed", { error: e instanceof Error ? e.message : String(e) });
        });
      }
      outcome = "uploaded";
      span.setAttribute("invoice.outcome", "uploaded");
      span.setAttribute("paperless.document_id", uploadResult.document_id ?? 0);
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
      span.updateName(`scan-worker.execute ${vendorForSpan} → ${outcome}`);
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
    size: fileBuffer.length,
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

    const paperlessUrl = process.env.PAPERLESS_URL;
    if (!paperlessUrl) throw new Error("PAPERLESS_URL environment variable is required");
    const paperlessToken = process.env.PAPERLESS_API_TOKEN ?? "";

    try {
      // Poll Paperless task API until consumption completes and returns the document ID
      let docId: number | undefined;
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const taskRes = await fetch(`${paperlessUrl}/api/tasks/?task_id=${taskUuid}`, {
          headers: { "Authorization": `Token ${paperlessToken}` },
        });
        if (!taskRes.ok) continue;
        const tasks = await taskRes.json() as Array<{ status: string; result?: string; related_document?: string }>;
        const task = tasks[0];
        if (!task) continue;

        if (task.status === "SUCCESS") {
          // Extract document ID from result string: "Success. New document id 379 created"
          const idMatch = task.result?.match(/document id (\d+)/i);
          if (idMatch) docId = parseInt(idMatch[1], 10);
          // Also check related_document field
          if (!docId && task.related_document) {
            docId = parseInt(task.related_document, 10) || undefined;
          }
          // Wait for Paperless to finish all post-consumption processing (OCR, classification)
          // before PATCHing custom fields — otherwise Paperless may overwrite them
          await new Promise((resolve) => setTimeout(resolve, 10000));
          break;
        } else if (task.status === "FAILURE") {
          logger.log(`Warning: Paperless consumption failed: ${task.result?.slice(0, 200)}`);
          return { error: `consumption failed: ${task.result?.slice(0, 100)}` };
        }
        logger.log(`Waiting for Paperless consumption (attempt ${attempt + 1}/12, status: ${task.status})`);
      }
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

      const patchRes = await fetch(`${paperlessUrl}/api/documents/${docId}/`, {
        method: "PATCH",
        headers: {
          "Authorization": `Token ${paperlessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ custom_fields: customFields }),
      });

      if (!patchRes.ok) {
        const errText = await patchRes.text();
        logger.log(`Warning: failed to set custom fields on doc #${docId}: ${errText.slice(0, 200)}`);
        return { doc_id: docId, fields_set: customFields, error: `PATCH failed: ${errText.slice(0, 100)}` };
      }

      // Verify the PATCH actually stuck
      const verifyRes = await fetch(`${paperlessUrl}/api/documents/${docId}/`, {
        headers: { "Authorization": `Token ${paperlessToken}` },
      });
      let verified: unknown;
      if (verifyRes.ok) {
        const verifyDoc = await verifyRes.json() as { custom_fields?: Array<{ field: number; value: unknown }> };
        verified = verifyDoc.custom_fields;
        logger.log(`Set custom fields on doc #${docId}: ${JSON.stringify(customFields)} — verified: ${JSON.stringify(verified)}`);
      }
      return { doc_id: docId, fields_set: customFields, verified };
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
