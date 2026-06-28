/**
 * Post-classification metadata + storage helpers for the invoice/scan
 * worker.
 *
 * After classification + dedup, the worker has a vendor, an owner, a
 * doc_type and a month tag. Everything from "look up Paperless ids" through
 * "send the Telegram notification" lives in this service. The orchestrator
 * just calls these in order.
 *
 * The Paperless wire format is owned by `paperless-adapter.ts`; this module
 * adds:
 *   - `resolveCorrespondent` — find or create
 *   - `resolveTagIds` (re-export of adapter helper)
 *   - `resolveDocumentTypeId` — owner-aware mapping
 *   - `resolveStoragePathId` — owner-aware mapping
 *   - `uploadAndSetCustomFields` — multi-step orchestration of upload +
 *     post-consumption custom field PATCH
 *   - `patchExistingDocument` — force-refresh path
 *   - `moveGdriveFile` — post-upload Drive shuffle to processed/errors
 *
 * No singleton state. Pass the adapter and registry in.
 */

import type {
  CorrespondentInfo,
  PaperlessAdapter,
} from "../paperless-adapter";
import type { PaperlessFieldRegistry } from "../paperless-fields";
import { callMcpTool, extractText } from "../mcp-client";
import { getTracer, withSpan } from "../tracing";

export interface PostprocessLogger {
  log(message: string): void;
}

const tracer = getTracer("invoice-worker");

// ── Owner / doc-type → Paperless name mappings ────────────────────────

/**
 * Storage path name mapping: owner → bucket → Paperless storage path name.
 *
 * Two keys are maintained for "business" storage:
 *   - "business" — used by the invoice path (classification.owner role value
 *     after the task-97 rename)
 *   - "techlab"  — used by the scan path (watch_folder level-1 directory name
 *     is an external label, not a role value; Task B will make this configurable)
 * Both point to the same Paperless storage paths so behaviour is identical.
 */
const STORAGE_PATH_NAMES: Record<string, Record<string, string>> = {
  business: {
    invoices: "Techlab Invoices",
    documents: "Techlab Documents",
  },
  techlab: {
    invoices: "Techlab Invoices",
    documents: "Techlab Documents",
  },
  personal: {
    invoices: "Personal Invoices",
    documents: "Personal Documents",
  },
};

/** doc_type → Paperless document type name (also used to pick storage bucket). */
const DOC_TYPE_TO_PAPERLESS: Record<string, string> = {
  invoice: "Invoice",
  receipt: "Invoice",
  credit_note: "Invoice",
  account_statement: "Document",
  document: "Document",
  statement: "Document",
  payslip: "Document",
  other: "Document",
};

// ── Correspondent ────────────────────────────────────────────────────

/**
 * Resolve a vendor name to a Paperless correspondent. Tries fuzzy match
 * first; creates a new correspondent if no match passes the threshold.
 *
 * When `vendor` is null/empty/whitespace — which the document-classifier
 * can legitimately return for internal documents like cestovný príkaz,
 * dochádzka, and payroll — falls back to `BUSINESS_COMPANY_NAME` from env.
 * The user's own company is the correct correspondent for those docs, and
 * this is what the updated classifier prompt asks for explicitly. The
 * worker-side fallback is a defensive safety net for LLM drift and ships
 * a WARN log so we can monitor how often the prompt rule fails. See task 48.
 */
export async function resolveCorrespondent(
  vendor: string | null,
  adapter: PaperlessAdapter,
  logger: PostprocessLogger,
): Promise<CorrespondentInfo> {
  let resolvedVendor = vendor;
  if (!resolvedVendor || !resolvedVendor.trim()) {
    const fallback = process.env.BUSINESS_COMPANY_NAME;
    if (!fallback || !fallback.trim()) {
      throw new Error(
        "resolveCorrespondent: vendor is null/empty and BUSINESS_COMPANY_NAME env var is unset",
      );
    }
    logger.log(
      `WARN: classifier returned null/empty vendor — falling back to BUSINESS_COMPANY_NAME="${fallback}"`,
    );
    resolvedVendor = fallback;
  }

  logger.log(`Resolving correspondent for vendor: ${resolvedVendor}`);
  const match = await adapter.findCorrespondent(resolvedVendor);
  if (match) {
    logger.log(`Fuzzy matched "${resolvedVendor}" → "${match.name}" (score: ${(match.score ?? 0).toFixed(3)})`);
    return { id: match.id, name: match.name };
  }
  logger.log(`Creating new correspondent: ${resolvedVendor}`);
  return adapter.createCorrespondent(resolvedVendor);
}

// ── Tags / document type / storage path ──────────────────────────────

export function resolveTagIds(
  tagNames: string[],
  adapter: PaperlessAdapter,
  logger: PostprocessLogger,
): Promise<number[]> {
  return adapter.resolveTagIds(tagNames, logger);
}

export async function resolveDocumentTypeId(
  docType: string,
  adapter: PaperlessAdapter,
  logger: PostprocessLogger,
): Promise<number | undefined> {
  const paperlessTypeName = DOC_TYPE_TO_PAPERLESS[docType];
  if (!paperlessTypeName) return undefined;
  return adapter.findDocumentTypeId(paperlessTypeName, logger);
}

export async function resolveStoragePathId(
  owner: string,
  docType: string,
  adapter: PaperlessAdapter,
  logger: PostprocessLogger,
): Promise<number | undefined> {
  const paperlessType = DOC_TYPE_TO_PAPERLESS[docType] ?? "Document";
  const bucket = paperlessType === "Invoice" ? "invoices" : "documents";
  const pathName = STORAGE_PATH_NAMES[owner]?.[bucket];
  if (!pathName) {
    logger.log(`No storage path mapping for owner=${owner}, docType=${docType}`);
    return undefined;
  }
  return adapter.findStoragePathId(pathName, logger);
}

// ── Upload + custom fields ───────────────────────────────────────────

export interface UploadParams {
  title: string;
  file: { filename: string; content_base64: string; content_type: string };
  correspondentId: number;
  tagIds: number[];
  documentTypeId?: number;
  storagePathId?: number;
  /** Observability — surfaced as `upload.total_amount` span attribute.
   *  Custom fields are PATCHed post-consumption, not in the multipart upload. */
  totalAmount?: number | null;
  /** Observability — surfaced as `upload.order_id` span attribute. */
  orderId?: string | null;
}

export interface UploadResult {
  task_uuid?: string;
  title: string;
}

/** Upload via the unified Paperless adapter. */
export async function uploadToPaperless(
  params: UploadParams,
  adapter: PaperlessAdapter,
  logger: PostprocessLogger,
): Promise<UploadResult> {
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
      totalAmountForSpan: params.totalAmount,
      orderIdForSpan: params.orderId,
    },
    logger,
  );
  return { task_uuid: r.task_uuid, title: params.title };
}

export interface CustomFieldResult {
  doc_id?: number;
  fields_set?: Array<{ field: number; value: unknown }>;
  verified?: unknown;
  error?: string;
}

/**
 * After upload, poll the task API until consumption succeeds, then PATCH
 * the resolved document with custom fields. Wraps both calls in a span.
 *
 * Returns CustomFieldResult: success carries doc_id + fields_set + verified;
 * failure carries an error string. Never throws (the worker logs and
 * continues — a failed custom-field PATCH shouldn't fail the upload).
 */
export async function setDocumentCustomFields(
  taskUuid: string | undefined,
  totalAmount: number | null | undefined,
  orderId: string | null | undefined,
  litres: number | null | undefined,
  receiptDatetime: string | null | undefined,
  adapter: PaperlessAdapter,
  registry: PaperlessFieldRegistry,
  logger: PostprocessLogger,
): Promise<CustomFieldResult> {
  return withSpan(tracer, "invoice-worker.set_fields", {
    "fields.total_amount": String(totalAmount ?? ""),
    "fields.order_id": orderId ?? "",
    "fields.litres": String(litres ?? ""),
    "fields.receipt_datetime": receiptDatetime ?? "",
    "fields.task_uuid": taskUuid ?? "",
  }, async (span) => {
    if (!taskUuid) {
      logger.log("Warning: no task UUID from upload, cannot set custom fields");
      return { error: "no task UUID" };
    }

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

      const customFields: Array<{ field: number; value: unknown }> = [];
      if (totalAmount != null) {
        customFields.push({ field: registry.getFieldId("total_amount"), value: totalAmount });
      }
      if (orderId) {
        customFields.push({ field: registry.getFieldId("order_id"), value: orderId });
      }
      if (litres != null) {
        customFields.push({ field: registry.getFieldId("litres"), value: litres });
      }
      if (receiptDatetime) {
        customFields.push({ field: registry.getFieldId("receipt_datetime"), value: receiptDatetime });
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

// ── Force-refresh PATCH ──────────────────────────────────────────────

export interface PatchParams {
  documentId: number;
  title: string;
  correspondentId: number;
  tagIds: number[];
  documentTypeId?: number;
  storagePathId?: number;
  totalAmount?: number | null;
  orderId?: string | null;
  litres?: number | null;
  receiptDatetime?: string | null;
}

/**
 * PATCH an existing Paperless document with fresh metadata. Used by the
 * force-refresh path: when the operator explicitly asks to reprocess a doc
 * that already exists in Paperless, we re-derive title/tags/correspondent/
 * etc. and patch the existing doc in place — preserving the doc id, the
 * original PDF, OCR, page count, and thumbnail.
 */
export async function patchExistingDocument(
  params: PatchParams,
  adapter: PaperlessAdapter,
  registry: PaperlessFieldRegistry,
  logger: PostprocessLogger,
): Promise<{ document_id: number; title: string }> {
  const customFields: Array<{ field: number; value: unknown }> = [];
  if (params.totalAmount != null) {
    customFields.push({ field: registry.getFieldId("total_amount"), value: params.totalAmount });
  }
  if (params.orderId) {
    customFields.push({ field: registry.getFieldId("order_id"), value: params.orderId });
  }
  if (params.litres != null) {
    customFields.push({ field: registry.getFieldId("litres"), value: params.litres });
  }
  if (params.receiptDatetime) {
    customFields.push({ field: registry.getFieldId("receipt_datetime"), value: params.receiptDatetime });
  }
  return adapter.patchDocument(
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

// ── GDrive post-move ─────────────────────────────────────────────────

/**
 * Best-effort: parse a Drive folder ID out of an MCP tool response. The
 * gmail-mcp `search_drive_files` and `create_drive_folder` tools return
 * varying shapes — JSON, single objects, plain text — so we try multiple
 * formats and return undefined if none work.
 */
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

/**
 * Move a Drive file to a sibling subfolder of its watch folder. Resolves
 * the watch folder by name, finds or creates the target subfolder
 * ("processed" or "errors"), then issues the parent change. Best-effort:
 * logs and swallows on failure so a Drive hiccup doesn't fail the whole job.
 */
export async function moveGdriveFile(
  fileId: string,
  targetFolder: string,
  watchFolder: string,
  gmailMcpUrl: string,
  googleEmail: string,
  logger: PostprocessLogger,
): Promise<void> {
  return withSpan(tracer, "invoice-worker.move_file", {
    "gdrive.file_id": fileId,
    "gdrive.target_folder": targetFolder,
    "gdrive.watch_folder": watchFolder,
  }, async (_span) => {
    try {
      // Resolve watch folder (level2) ID — the parent where processed/errors subfolders live
      const watchFolderLeaf = watchFolder.split("/").pop()!;
      const watchResult = await callMcpTool(gmailMcpUrl, "search_drive_files", {
        query: `name = '${watchFolderLeaf}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        user_google_email: googleEmail,
      });
      const watchText = extractText(watchResult);
      const watchFolderId = watchText ? extractDriveFolderId(watchText) : undefined;

      // Resolve target subfolder (e.g. "processed") within the watch folder
      let targetFolderId: string | undefined;
      if (watchFolderId) {
        const searchResult = await callMcpTool(gmailMcpUrl, "search_drive_files", {
          query: `name = '${targetFolder}' and '${watchFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          user_google_email: googleEmail,
        });
        const searchText = extractText(searchResult);
        if (searchText) {
          targetFolderId = extractDriveFolderId(searchText);
        }
      }

      // Create target folder if it doesn't exist
      if (!targetFolderId && watchFolderId) {
        logger.log(`Creating folder "${targetFolder}" in ${watchFolder}`);
        const createResult = await callMcpTool(gmailMcpUrl, "create_drive_folder", {
          name: targetFolder,
          parent_id: watchFolderId,
          user_google_email: googleEmail,
        });
        const createText = extractText(createResult);
        if (createText) targetFolderId = extractDriveFolderId(createText);
      }

      if (!targetFolderId) {
        logger.log(`Warning: could not find or create folder "${targetFolder}" in ${watchFolder}, skipping move`);
        return;
      }

      await callMcpTool(gmailMcpUrl, "update_drive_file", {
        file_id: fileId,
        add_parents: targetFolderId,
        remove_parents: watchFolderId ?? undefined,
        user_google_email: googleEmail,
      });
      logger.log(`Moved file ${fileId} to ${watchFolder}/${targetFolder}/`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.log(`Warning: failed to move GDrive file ${fileId} to ${watchFolder}/${targetFolder}/: ${message}`);
    }
  });
}

// ── Title generation for scans ───────────────────────────────────────

/**
 * Build a title for a scanned document. Priority: order_id → subtitle →
 * cleaned filename → "scan" fallback. Mirrors `generateTitle` in
 * invoice-pipeline.ts but uses filename instead of email subject.
 */
export function buildScanTitle(
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
    const cleaned = filename.replace(/\.[^.]+$/, "").trim().slice(0, 80);
    return `${vendor} - ${cleaned}`;
  }
  return `${vendor} - scan`;
}
