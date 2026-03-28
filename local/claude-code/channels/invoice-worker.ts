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
import type { PaperlessFieldRegistry } from "./paperless-fields";

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
  registry: PaperlessFieldRegistry,
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

    // Step 7: Set custom fields (total_amount, order_id) if available
    if (classification.total_amount != null || classification.order_id) {
      addJobEvent(db, job.id, "step_started", { step: "set_custom_fields" });
      const cfResult = await setDocumentCustomFields(
        uploadResult.task_uuid,
        classification.total_amount,
        classification.order_id,
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
  // Only types that exist in Paperless: "invoice", "account_statement"
  const typeMap: Record<string, string> = {
    invoice: "invoice",
    credit_note: "invoice",
    account_statement: "account_statement",
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
  task_uuid?: string;
  title: string;
}

async function uploadToPaperless(
  params: UploadParams,
  logger: WorkerLogger,
): Promise<UploadResult> {
  logger.log(`Uploading to Paperless: "${params.title}"`);

  // Upload directly to Paperless API (bypasses paperless-mcp to avoid
  // 413 Payload Too Large on base64-encoded files over ~200KB).
  const paperlessUrl = process.env.PAPERLESS_URL ?? "https://documents.lacny.me";
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

  return { task_uuid: taskUuid, title: params.title };
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
  registry: PaperlessFieldRegistry,
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

    // Step 4: Resolve tags — derived deterministically from classification
    addJobEvent(db, job.id, "step_started", { step: "resolve_tags" });
    const allTagNames: string[] = [];
    // doc_type → tag mapping (business logic, not classifier's job)
    const docType = classification.doc_type;
    if (docType === "receipt" || docType === "invoice" || docType === "credit_note" || docType === "account_statement") {
      allTagNames.push("invoicing");
    } else if (docType === "document") {
      allTagNames.push("documents");
    }
    allTagNames.push("techlab"); // all scans are business expenses
    if (classification.is_fuel) {
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

    // Step 7: Set custom fields (total_amount, order_id) if available
    if (classification.total_amount != null || classification.order_id) {
      addJobEvent(db, job.id, "step_started", { step: "set_custom_fields" });
      const cfResult = await setDocumentCustomFields(
        uploadResult.task_uuid,
        classification.total_amount,
        classification.order_id,
        logger,
        registry,
      );
      addJobEvent(db, job.id, "step_completed", { step: "set_custom_fields", ...cfResult });
    }

    // Step 8: Move GDrive file to Processed/
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
  const localPath = `/workspace/downloads/${resolvedFilename}`;

  const { execSync } = await import("child_process");
  execSync(`curl -sL -o "${localPath}" "${downloadUrl}"`, { timeout: 30000 });

  // Step 3: Read file and base64 encode
  const fs = await import("fs");
  const fileBuffer = fs.readFileSync(localPath);
  const contentBase64 = fileBuffer.toString("base64");

  // Determine content type from filename
  let contentType = "application/pdf";
  const ext = resolvedFilename.toLowerCase().split(".").pop();
  if (ext === "jpg" || ext === "jpeg") contentType = "image/jpeg";
  else if (ext === "png") contentType = "image/png";
  else if (ext === "heic") contentType = "image/heic";

  // Clean up local file
  try { fs.unlinkSync(localPath); } catch { /* ignore */ }

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
  if (!taskUuid) {
    logger.log("Warning: no task UUID from upload, cannot set custom fields");
    return { error: "no task UUID" };
  }

  const paperlessUrl = process.env.PAPERLESS_URL ?? "https://documents.lacny.me";
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
}

async function moveGdriveFile(
  fileId: string,
  targetFolder: string,
  logger: WorkerLogger,
): Promise<void> {
  try {
    // Resolve target folder ID
    const searchResult = await callMcpTool(GMAIL_MCP_URL, "search_drive_files", {
      query: `name = '${targetFolder}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      user_google_email: GOOGLE_EMAIL,
    });
    const searchText = extractText(searchResult);
    if (!searchText) {
      logger.log(`Warning: target folder "${targetFolder}" not found, skipping move`);
      return;
    }

    // Response is text format: parse ID from "ID: xxx"
    let targetFolderId: string | undefined;
    try {
      const parsed = JSON.parse(searchText);
      if (Array.isArray(parsed) && parsed.length > 0) {
        targetFolderId = parsed[0].id ?? parsed[0].fileId;
      }
    } catch {
      // Text format: extract ID
      const idMatch = searchText.match(/ID:\s*([^,\s)]+)/);
      if (idMatch) targetFolderId = idMatch[1].trim();
    }

    if (!targetFolderId) {
      logger.log(`Warning: target folder "${targetFolder}" not found or no ID, skipping move`);
      return;
    }

    // Resolve watch folder ID (remove_parents needs an ID, not a name)
    const watchFolderName = (process.env.GDRIVE_WATCH_FOLDER ?? "Techlab/Invoice scans").split("/").pop()!;
    const watchResult = await callMcpTool(GMAIL_MCP_URL, "search_drive_files", {
      query: `name = '${watchFolderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      user_google_email: GOOGLE_EMAIL,
    });
    const watchText = extractText(watchResult);
    let watchFolderId: string | undefined;
    if (watchText) {
      try {
        const parsed = JSON.parse(watchText);
        if (Array.isArray(parsed) && parsed.length > 0) {
          watchFolderId = parsed[0].id ?? parsed[0].fileId;
        }
      } catch {
        const idMatch = watchText.match(/ID:\s*([^,\s)]+)/);
        if (idMatch) watchFolderId = idMatch[1].trim();
      }
    }

    await callMcpTool(GMAIL_MCP_URL, "update_drive_file", {
      file_id: fileId,
      add_parents: targetFolderId,
      remove_parents: watchFolderId ?? undefined,
      user_google_email: GOOGLE_EMAIL,
    });
    logger.log(`Moved file ${fileId} to ${targetFolder}/`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.log(`Warning: failed to move GDrive file ${fileId} to ${targetFolder}/: ${message}`);
  }
}
