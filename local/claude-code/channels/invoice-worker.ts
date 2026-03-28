/**
 * Invoice intake workflow worker.
 *
 * Executes deterministic invoice processing steps:
 * 1. Download invoice (attachment or known link)
 * 2. Deduplicate against Paperless
 * 3. Upload to Paperless with metadata
 *
 * Calls gmail/outlook/paperless MCP servers directly via HTTP.
 */

import type { Database } from "bun:sqlite";

import {
  addJobEvent,
  completeJob,
  failJob,
  parseJobJson,
  requestJobApproval,
  type JobRow,
} from "./workflow-db";
import { callMcpTool, extractJson, extractText } from "./mcp-client";

// ── Types ──────────────────────────────────────────────────────────────

export type DownloadStrategy =
  | "attachment"
  | "known_link"
  | "direct_url"
  | "browser_required"
  | "manual_review";

export interface InvoiceIntakeInput {
  /** "gmail" or "outlook" */
  email_source: string;
  /** Email message ID from the email provider */
  message_id: string;
  /** Classification output from email-classifier agent */
  classification: {
    is_invoice: boolean;
    confidence: "high" | "medium" | "low";
    vendor: string;
    doc_type: string;
    is_fuel: boolean;
    suggested_tags: string[];
    action: string;
    download_strategy: DownloadStrategy | null;
    strategy_confidence: "high" | "medium" | "low";
    requires_review: boolean;
    order_id: string | null;
    total_amount: number | null;
    currency: string | null;
  };
  /** Email subject (for title generation) */
  subject?: string;
  /** Email sender */
  sender?: string;
  /** Email received date ISO */
  received_at?: string;
}

export interface ScanIntakeInput {
  source: "gdrive";
  file_id: string;
  filename?: string;
  month_tag?: string;
  classification: {
    doc_type: string;
    vendor: string;
    total_amount: number | null;
    currency: string | null;
    is_fuel: boolean;
    suggested_tags: string[];
    confidence: string;
    order_id: string | null;
  };
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

// ── Main executor ──────────────────────────────────────────────────────

export async function executeInvoiceIntake(
  db: Database,
  job: JobRow,
  logger: WorkerLogger,
): Promise<void> {
  const input = parseJobJson<InvoiceIntakeInput>(job.input_json);
  if (!input) {
    failJob(db, job.id, { code: "invalid_input", message: "Missing or invalid input_json" });
    return;
  }

  const { classification } = input;
  const strategy = classification.download_strategy;

  // ── Gate: strategies that require approval ──
  if (strategy === "browser_required" || strategy === "manual_review") {
    requestJobApproval(db, job.id, {
      reason: `Download strategy "${strategy}" requires human review`,
      vendor: classification.vendor,
      subject: input.subject,
    });
    logger.log(`Job ${job.id} paused: strategy=${strategy}`);
    return;
  }

  // ── Gate: unknown vendor requires approval (unless already approved) ──
  if (classification.vendor === "unknown" && !job.approved_by) {
    requestJobApproval(db, job.id, {
      reason: "Unknown vendor — cannot process without human confirmation",
      subject: input.subject,
      sender: input.sender,
    });
    logger.log(`Job ${job.id} paused: unknown vendor`);
    return;
  }

  // ── Gate: low confidence requires approval ──
  if (classification.confidence === "low" && !job.approved_by) {
    requestJobApproval(db, job.id, {
      reason: `Low classification confidence for "${classification.vendor}"`,
      subject: input.subject,
    });
    logger.log(`Job ${job.id} paused: low confidence`);
    return;
  }

  // ── Gate: requires_review flag ──
  if (classification.requires_review && !job.approved_by) {
    requestJobApproval(db, job.id, {
      reason: "Classifier flagged this email for human review",
      vendor: classification.vendor,
      subject: input.subject,
    });
    logger.log(`Job ${job.id} paused: requires_review`);
    return;
  }

  try {
    // Step 1: Download
    addJobEvent(db, job.id, "step_started", { step: "download", strategy });
    const file = await downloadInvoice(input, logger);
    addJobEvent(db, job.id, "step_completed", {
      step: "download",
      filename: file.filename,
      size: file.size,
      content_type: file.content_type,
    });

    // Step 2: Resolve correspondent
    addJobEvent(db, job.id, "step_started", { step: "resolve_correspondent" });
    const correspondent = await resolveCorrespondent(classification.vendor, logger);
    addJobEvent(db, job.id, "step_completed", {
      step: "resolve_correspondent",
      correspondent,
    });

    // Step 3: Deduplicate
    addJobEvent(db, job.id, "step_started", { step: "deduplicate" });
    const dedupeResult = await checkDuplicate(classification, correspondent, logger);
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
        return;
      }

      if (dedupeResult.outcome === "duplicate_likely") {
        // Pause for user decision on likely duplicates
        requestJobApproval(db, job.id, {
          reason: dedupeResult.message,
          existing_document_id: dedupeResult.existing_id,
        });
        logger.log(`Job ${job.id} paused: likely duplicate`);
        return;
      }
    } else {
      addJobEvent(db, job.id, "step_completed", {
        step: "deduplicate",
        outcome: "no_duplicate",
      });
    }

    // Step 4: Resolve tags
    addJobEvent(db, job.id, "step_started", { step: "resolve_tags" });
    const tagIds = await resolveTags(classification.suggested_tags, logger);
    addJobEvent(db, job.id, "step_completed", { step: "resolve_tags", tags: tagIds });

    // Step 5: Resolve document type
    const documentTypeId = await resolveDocumentType(classification.doc_type, logger);

    // Step 6: Upload to Paperless
    addJobEvent(db, job.id, "step_started", { step: "upload" });
    const title = buildTitle(classification.vendor, classification.order_id, input.subject);
    const uploadResult = await uploadToPaperless({
      title,
      file,
      correspondentId: correspondent.id,
      tagIds,
      documentTypeId,
      totalAmount: classification.total_amount,
      orderId: classification.order_id,
    }, logger);
    addJobEvent(db, job.id, "step_completed", {
      step: "upload",
      ...uploadResult,
    });

    const result: InvoiceIntakeResult = {
      outcome: "uploaded",
      title,
      paperless_document_id: uploadResult.document_id,
      correspondent: correspondent.name,
      tags: classification.suggested_tags,
      total_amount: classification.total_amount,
    };
    completeJob(db, job.id, result);
    logger.log(`Job ${job.id} completed: uploaded "${title}" to Paperless`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failJob(db, job.id, { code: "invoice_intake_error", message, step: "unknown" });
    logger.log(`Job ${job.id} failed: ${message}`);
  }
}

// ── Download step ──────────────────────────────────────────────────────

async function downloadInvoice(
  input: InvoiceIntakeInput,
  logger: WorkerLogger,
): Promise<DownloadedFile> {
  const { email_source, message_id, classification } = input;
  const strategy = classification.download_strategy;
  const mcpUrl = email_source === "gmail" ? GMAIL_MCP_URL : OUTLOOK_MCP_URL;

  switch (strategy) {
    case "attachment":
      return downloadAttachment(mcpUrl, email_source, message_id, logger);

    case "known_link":
    case "direct_url":
      return downloadViaLink(mcpUrl, email_source, message_id, logger);

    default:
      throw new Error(`Unsupported download strategy: ${strategy}`);
  }
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
    const attachments = JSON.parse(attachmentsText) as Array<{
      id: string;
      name: string;
      content_type: string;
      size: number;
    }>;

    if (!attachments.length) {
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
    const parsed = JSON.parse(downloadData) as {
      name: string;
      content_type: string;
      size: number;
      content_base64: string;
    };

    return {
      filename: parsed.name,
      content_base64: parsed.content_base64,
      content_type: parsed.content_type,
      size: parsed.size,
    };
  }

  if (source === "gmail") {
    // Gmail: get_attachments then download_attachment
    const attachmentsResult = await callMcpTool(mcpUrl, "get_attachments", {
      message_id: messageId,
    });
    const attachmentsText = extractText(attachmentsResult);
    const attachments = JSON.parse(attachmentsText);

    if (!Array.isArray(attachments) || !attachments.length) {
      throw new Error("No attachments found on Gmail message");
    }

    // Find PDF attachment
    const target = attachments.find(
      (a: any) =>
        a.mimeType === "application/pdf" ||
        a.filename?.toLowerCase().endsWith(".pdf"),
    ) ?? attachments[0];

    const downloadResult = await callMcpTool(mcpUrl, "download_attachment", {
      message_id: messageId,
      attachment_id: target.id ?? target.attachmentId,
    });
    const downloadData = extractText(downloadResult);
    const parsed = JSON.parse(downloadData);

    return {
      filename: parsed.filename ?? parsed.name ?? target.filename ?? "attachment.pdf",
      content_base64: parsed.content_base64 ?? parsed.data ?? "",
      content_type: parsed.content_type ?? parsed.mimeType ?? "application/pdf",
      size: parsed.size ?? 0,
    };
  }

  throw new Error(`Unsupported email source: ${source}`);
}

async function downloadViaLink(
  mcpUrl: string,
  source: string,
  messageId: string,
  logger: WorkerLogger,
): Promise<DownloadedFile> {
  logger.log(`Downloading via link extraction from ${source} message ${messageId}`);

  if (source === "outlook") {
    // Extract invoice links from email body
    const linksResult = await callMcpTool(mcpUrl, "extract_invoice_links", {
      message_id: messageId,
    });
    const linksText = extractText(linksResult);
    const links = JSON.parse(linksText) as Array<{
      url: string;
      text: string;
      doc_id?: string;
    }>;

    if (!links.length) {
      throw new Error("No invoice download links found in email");
    }

    // Download the first link
    const downloadResult = await callMcpTool(mcpUrl, "download_invoice_link", {
      url: links[0].url,
    });
    const downloadData = extractText(downloadResult);
    const parsed = JSON.parse(downloadData) as {
      filename: string;
      content_type: string;
      size: number;
      content_base64: string;
      error?: string;
      status_code?: number;
    };

    if (parsed.error) {
      throw new Error(`Download failed: ${parsed.error} (HTTP ${parsed.status_code})`);
    }

    return {
      filename: parsed.filename,
      content_base64: parsed.content_base64,
      content_type: parsed.content_type,
      size: parsed.size,
    };
  }

  // Gmail: extract links from email body and download
  // Gmail MCP doesn't have extract_invoice_links — we'd need to get the body
  // and parse it ourselves. For now, fall back to error.
  throw new Error(`Link extraction not yet supported for ${source} — use attachment strategy`);
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
  logger.log(`Resolving correspondent for vendor: ${vendor}`);

  const listResult = await callMcpTool(PAPERLESS_MCP_URL, "list_correspondents", {});
  const listText = extractText(listResult);
  const parsed = JSON.parse(listText);
  // Paperless MCP returns paginated object { results: [...] }, not a raw array
  const correspondents = (Array.isArray(parsed) ? parsed : parsed.results ?? []) as Array<{ id: number; name: string }>;

  // Case-insensitive match
  const match = correspondents.find(
    (c) => c.name.toLowerCase() === vendor.toLowerCase(),
  );
  if (match) {
    return { id: match.id, name: match.name };
  }

  // Create new correspondent
  logger.log(`Creating new correspondent: ${vendor}`);
  const createResult = await callMcpTool(PAPERLESS_MCP_URL, "create_correspondent", {
    name: vendor,
  });
  const createText = extractText(createResult);
  const created = JSON.parse(createText) as { id: number; name: string };
  return { id: created.id, name: created.name };
}

interface DedupeResult {
  outcome: "duplicate" | "duplicate_likely";
  existing_id: number;
  message: string;
}

async function checkDuplicate(
  classification: InvoiceIntakeInput["classification"],
  correspondent: CorrespondentInfo,
  logger: WorkerLogger,
): Promise<DedupeResult | null> {
  if (!classification.order_id) {
    logger.log("No order_id — skipping dedup check");
    return null;
  }

  logger.log(`Checking for duplicate: order_id=${classification.order_id}`);

  const searchResult = await callMcpTool(PAPERLESS_MCP_URL, "search_documents", {
    query: classification.order_id,
    correspondent_id: correspondent.id,
  });
  const searchText = extractText(searchResult);
  let docs: any[];
  try {
    docs = JSON.parse(searchText);
  } catch {
    // Search returned non-JSON (e.g., "No documents found")
    return null;
  }

  if (!Array.isArray(docs) || docs.length === 0) {
    return null;
  }

  // Check each result for order_id custom field match
  for (const doc of docs) {
    const existingOrderId = doc.custom_fields?.order_id ?? doc.order_id;
    if (existingOrderId === classification.order_id) {
      // Check amounts
      const existingAmount = doc.custom_fields?.total_amount ?? doc.total_amount;
      if (
        existingAmount != null &&
        classification.total_amount != null &&
        existingAmount !== classification.total_amount
      ) {
        return {
          outcome: "duplicate_likely",
          existing_id: doc.id,
          message: `Order ${classification.order_id} matches doc #${doc.id} "${doc.title}" but amount differs (${existingAmount} vs ${classification.total_amount})`,
        };
      }

      return {
        outcome: "duplicate",
        existing_id: doc.id,
        message: `Order ${classification.order_id} already exists as doc #${doc.id} "${doc.title}"`,
      };
    }
  }

  return null;
}

async function resolveTags(
  tagNames: string[],
  logger: WorkerLogger,
): Promise<number[]> {
  if (!tagNames.length) return [];

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
}

async function resolveDocumentType(
  docType: string,
  logger: WorkerLogger,
): Promise<number | undefined> {
  // Map classifier doc_type to Paperless document type name
  const typeMap: Record<string, string> = {
    invoice: "invoice",
    credit_note: "invoice", // credit notes use same type
    receipt: "invoice",
    statement: "account_statement",
  };

  const paperlessTypeName = typeMap[docType];
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

interface UploadParams {
  title: string;
  file: DownloadedFile;
  correspondentId: number;
  tagIds: number[];
  documentTypeId?: number;
  totalAmount?: number | null;
  orderId?: string | null;
}

interface UploadResult {
  document_id?: number;
  title: string;
}

async function uploadToPaperless(
  params: UploadParams,
  logger: WorkerLogger,
): Promise<UploadResult> {
  logger.log(`Uploading to Paperless: "${params.title}"`);

  const toolArgs: Record<string, unknown> = {
    file: params.file.content_base64,
    filename: params.file.filename,
    title: params.title,
    correspondent: params.correspondentId,
    tags: params.tagIds,
  };

  if (params.documentTypeId) {
    toolArgs.document_type = params.documentTypeId;
  }

  // Custom fields: post_document accepts an array of field IDs.
  // Setting field values requires a separate update after upload.
  // For now, skip custom_fields in the upload — Paperless-AI or
  // manual editing can set total_amount/order_id after ingestion.

  const result = await callMcpTool(PAPERLESS_MCP_URL, "post_document", toolArgs);
  const resultText = extractText(result);

  // post_document may return the document ID or a task ID
  let documentId: number | undefined;
  try {
    const parsed = JSON.parse(resultText);
    documentId = parsed.id ?? parsed.document_id ?? parsed.pk;
  } catch {
    // Response might be a success message string
    logger.log(`Upload response: ${resultText}`);
  }

  return { document_id: documentId, title: params.title };
}

// ── Helpers ────────────────────────────────────────────────────────────

function buildTitle(
  vendor: string,
  orderId: string | null | undefined,
  subject: string | undefined,
): string {
  if (orderId) {
    return `${vendor} - ${orderId}`;
  }
  if (subject) {
    // Use first meaningful part of subject
    const cleaned = subject
      .replace(/^(Fwd|Re|FW):\s*/gi, "")
      .trim()
      .slice(0, 80);
    return `${vendor} - ${cleaned}`;
  }
  return `${vendor} - invoice`;
}

// ── Scan intake (GDrive) ──────────────────────────────────────────────

export async function executeScanIntake(
  db: Database,
  job: JobRow,
  logger: WorkerLogger,
): Promise<void> {
  const input = parseJobJson<ScanIntakeInput>(job.input_json);
  if (!input) {
    failJob(db, job.id, { code: "invalid_input", message: "Missing or invalid input_json" });
    return;
  }

  const { classification, file_id } = input;

  // ── Gate: unknown vendor requires approval (unless already approved) ──
  if (classification.vendor === "unknown" && !job.approved_by) {
    requestJobApproval(db, job.id, {
      reason: "Unknown vendor — cannot process scan without human confirmation",
      filename: input.filename,
      file_id,
    });
    logger.log(`Job ${job.id} paused: unknown vendor`);
    return;
  }

  // ── Gate: low confidence requires approval ──
  if (classification.confidence === "low" && !job.approved_by) {
    requestJobApproval(db, job.id, {
      reason: `Low classification confidence for "${classification.vendor}"`,
      filename: input.filename,
      file_id,
    });
    logger.log(`Job ${job.id} paused: low confidence`);
    return;
  }

  try {
    // Step 1: Download from GDrive
    addJobEvent(db, job.id, "step_started", { step: "download", source: "gdrive" });
    const file = await downloadFromGdrive(file_id, input.filename, logger);
    addJobEvent(db, job.id, "step_completed", {
      step: "download",
      filename: file.filename,
      size: file.size,
      content_type: file.content_type,
    });

    // Step 2: Resolve correspondent
    addJobEvent(db, job.id, "step_started", { step: "resolve_correspondent" });
    const correspondent = await resolveCorrespondent(classification.vendor, logger);
    addJobEvent(db, job.id, "step_completed", {
      step: "resolve_correspondent",
      correspondent,
    });

    // Step 3: Deduplicate (only if order_id exists)
    addJobEvent(db, job.id, "step_started", { step: "deduplicate" });
    const dedupeResult = await checkDuplicate(
      classification as unknown as InvoiceIntakeInput["classification"],
      correspondent,
      logger,
    );
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
        await moveGdriveFile(file_id, "Processed", logger);
        logger.log(`Job ${job.id} completed: duplicate of doc #${dedupeResult.existing_id}`);
        return;
      }

      if (dedupeResult.outcome === "duplicate_likely") {
        requestJobApproval(db, job.id, {
          reason: dedupeResult.message,
          existing_document_id: dedupeResult.existing_id,
        });
        logger.log(`Job ${job.id} paused: likely duplicate`);
        return;
      }
    } else {
      addJobEvent(db, job.id, "step_completed", {
        step: "deduplicate",
        outcome: "no_duplicate",
      });
    }

    // Step 4: Resolve tags (merge suggested_tags + month_tag)
    addJobEvent(db, job.id, "step_started", { step: "resolve_tags" });
    // Classifier may omit suggested_tags — build defaults from doc_type
    const suggestedTags = classification.suggested_tags ?? [];
    const allTagNames = [...suggestedTags];
    // Ensure standard tags are present
    if (classification.doc_type === "receipt" || classification.doc_type === "invoice" || classification.doc_type === "credit_note") {
      if (!allTagNames.includes("invoicing")) allTagNames.push("invoicing");
      if (!allTagNames.includes("techlab")) allTagNames.push("techlab");
    }
    if (classification.is_fuel && !allTagNames.includes("fuel")) {
      allTagNames.push("fuel");
    }
    if (input.month_tag && !allTagNames.includes(input.month_tag)) {
      allTagNames.push(input.month_tag);
    }
    const tagIds = await resolveTags(allTagNames, logger);
    addJobEvent(db, job.id, "step_completed", { step: "resolve_tags", tags: tagIds });

    // Step 5: Resolve document type
    const documentTypeId = await resolveDocumentType(classification.doc_type, logger);

    // Step 6: Upload to Paperless
    addJobEvent(db, job.id, "step_started", { step: "upload" });
    const title = buildScanTitle(
      classification.vendor,
      classification.order_id,
      input.filename,
    );
    const uploadResult = await uploadToPaperless({
      title,
      file,
      correspondentId: correspondent.id,
      tagIds,
      documentTypeId,
      totalAmount: classification.total_amount,
      orderId: classification.order_id,
    }, logger);
    addJobEvent(db, job.id, "step_completed", {
      step: "upload",
      ...uploadResult,
    });

    // Step 7: Move GDrive file to Processed/
    await moveGdriveFile(file_id, "Processed", logger);

    const result: InvoiceIntakeResult = {
      outcome: "uploaded",
      title,
      paperless_document_id: uploadResult.document_id,
      correspondent: correspondent.name,
      tags: allTagNames,
      total_amount: classification.total_amount,
    };
    completeJob(db, job.id, result);
    logger.log(`Job ${job.id} completed: uploaded "${title}" to Paperless`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failJob(db, job.id, { code: "scan_intake_error", message, step: "unknown" });
    await moveGdriveFile(file_id, "Errors", logger).catch((moveErr) => {
      logger.log(`Failed to move file to Errors/: ${moveErr instanceof Error ? moveErr.message : String(moveErr)}`);
    });
    logger.log(`Job ${job.id} failed: ${message}`);
  }
}

function buildScanTitle(
  vendor: string,
  orderId: string | null | undefined,
  filename: string | undefined,
): string {
  if (orderId) {
    return `${vendor} - ${orderId}`;
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

  const result = await callMcpTool(GMAIL_MCP_URL, "get_drive_file_content", {
    file_id: fileId,
    user_google_email: GOOGLE_EMAIL,
  });
  const data = extractText(result);
  if (!data) throw new Error("Failed to download file from GDrive");

  // The response may be JSON with base64 content or raw text
  let contentBase64: string;
  let contentType = "application/pdf";
  try {
    const parsed = JSON.parse(data);
    contentBase64 = parsed.content_base64 ?? parsed.data ?? parsed.content ?? "";
    contentType = parsed.content_type ?? parsed.mimeType ?? contentType;
  } catch {
    // Raw base64 string
    contentBase64 = data;
  }

  const resolvedFilename = filename ?? `gdrive-${fileId}`;
  const size = Math.ceil((contentBase64.length * 3) / 4);

  return {
    filename: resolvedFilename,
    content_base64: contentBase64,
    content_type: contentType,
    size,
  };
}

async function moveGdriveFile(
  fileId: string,
  targetFolder: string,
  logger: WorkerLogger,
): Promise<void> {
  try {
    // Search for the target folder
    const searchResult = await callMcpTool(GMAIL_MCP_URL, "search_drive_files", {
      query: `name = '${targetFolder}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      user_google_email: GOOGLE_EMAIL,
    });
    const searchText = extractText(searchResult);
    if (!searchText) {
      logger.log(`Warning: target folder "${targetFolder}" not found, skipping move`);
      return;
    }

    let folders: any[];
    try {
      folders = JSON.parse(searchText);
    } catch {
      logger.log(`Warning: could not parse folder search result, skipping move`);
      return;
    }

    if (!Array.isArray(folders) || folders.length === 0) {
      logger.log(`Warning: target folder "${targetFolder}" not found, skipping move`);
      return;
    }

    const targetFolderId = folders[0].id ?? folders[0].fileId;
    if (!targetFolderId) {
      logger.log(`Warning: target folder "${targetFolder}" has no ID, skipping move`);
      return;
    }

    const watchFolder = process.env.GDRIVE_WATCH_FOLDER ?? "Techlab/Invoice scans";

    await callMcpTool(GMAIL_MCP_URL, "update_drive_file", {
      file_id: fileId,
      add_parents: targetFolderId,
      remove_parents: watchFolder,
      user_google_email: GOOGLE_EMAIL,
    });
    logger.log(`Moved file ${fileId} to ${targetFolder}/`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.log(`Warning: failed to move GDrive file ${fileId} to ${targetFolder}/: ${message}`);
  }
}
