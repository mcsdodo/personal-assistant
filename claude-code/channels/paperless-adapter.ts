/**
 * Unified adapter for all Paperless-ngx interactions.
 *
 * Before this module existed, the worker mixed two transports:
 *   - Paperless MCP (`paperless-mcp` HTTP) for `list_correspondents`,
 *     `create_correspondent`, `list_tags`, `create_tag`,
 *     `list_document_types`.
 *   - Direct HTTP to the Paperless REST API for dedup search, storage path
 *     lookup, multipart upload, task polling, and document PATCH (the MCP
 *     buffers files in memory and breaks for documents > ~5 MB).
 *
 * Callers shouldn't need to know which transport handles which operation.
 * `PaperlessAdapter` exposes one interface and decides internally.
 *
 * Behavior is identical to the inline implementations that previously lived
 * in `invoice-worker.ts` — this is a structural extraction, not a rewrite.
 * Tests in `paperless-adapter.test.ts` lock in the wire format.
 */

import { callMcpTool, extractText } from "./mcp-client";
import type { PaperlessFieldRegistry } from "./paperless-fields";
import { findBestCorrespondentMatch } from "./fuzzy-match";
import { getTracer, withSpan, SpanStatusCode } from "./tracing";

// ── Types ──────────────────────────────────────────────────────────────

export interface CorrespondentInfo {
  id: number;
  name: string;
}

export interface CorrespondentMatch extends CorrespondentInfo {
  score?: number;
}

export interface TagInfo {
  id: number;
  name: string;
}

export interface DocumentTypeInfo {
  id: number;
  name: string;
}

export interface PaperlessDocument {
  id: number;
  title: string;
  custom_fields: Array<{ field: number; value: unknown }>;
}

export interface UploadFile {
  filename: string;
  content_base64: string;
  content_type: string;
}

export interface UploadMetadata {
  title: string;
  correspondentId: number;
  tagIds: number[];
  documentTypeId?: number;
  storagePathId?: number;
  /** Observability-only: surfaced as `upload.total_amount` span attribute.
   *  NOT sent in the multipart body — custom fields are PATCHed
   *  post-consumption via `setCustomFields`. */
  totalAmountForSpan?: number | null;
  /** Observability-only: surfaced as `upload.order_id` span attribute. */
  orderIdForSpan?: string | null;
}

export interface UploadResult {
  task_uuid: string;
}

export interface PatchFields {
  title: string;
  correspondentId: number;
  tagIds: number[];
  documentTypeId?: number;
  storagePathId?: number;
  customFields?: Array<{ field: number; value: unknown }>;
}

export interface ConsumedDocument {
  doc_id: number | undefined;
  status: "SUCCESS" | "FAILURE" | "TIMEOUT";
  result?: string;
}

export interface AdapterLogger {
  log(message: string): void;
}

// ── Construction ───────────────────────────────────────────────────────

export interface PaperlessAdapterConfig {
  /** Base URL for the Paperless REST API, e.g. https://paperless.lan */
  paperlessUrl: string;
  /** Paperless API token (Token <token> Authorization header) */
  paperlessToken: string;
  /** Paperless MCP HTTP URL for tag/correspondent/doc-type CRUD */
  paperlessMcpUrl: string;
  /** Custom field registry (id ↔ name) for setting custom fields */
  fieldRegistry: PaperlessFieldRegistry;
}

const tracer = getTracer("paperless-adapter");

export class PaperlessAdapter {
  private readonly cfg: PaperlessAdapterConfig;

  constructor(cfg: PaperlessAdapterConfig) {
    this.cfg = cfg;
  }

  // ── Pagination helper ────────────────────────────────────────────────

  /**
   * Walk a paginated Paperless MCP `list_*` tool until exhausted, returning
   * every result accumulated across pages.
   *
   * Paperless defaults to `page_size=25`. We pass `page_size=100` (perf) and
   * follow the `next` link by incrementing `page` until the response reports
   * `next: null`. Before this helper existed, call sites grabbed only page 1
   * and silently missed any entry past entry 25 — which caused 17 production
   * documents to be uploaded with `correspondent: null` because the
   * fuzzy-matcher couldn't see the correspondent. See task 48.
   *
   * A hard ceiling of 50 pages (≈5000 entries at page_size=100) guards against
   * a server bug that returns `next` indefinitely.
   */
  private async listAllPages<T>(toolName: string): Promise<T[]> {
    const accumulated: T[] = [];
    let page = 1;
    const PAGE_SIZE = 100;
    const MAX_PAGES = 50;

    for (; page <= MAX_PAGES; page++) {
      const result = await callMcpTool(this.cfg.paperlessMcpUrl, toolName, {
        page,
        page_size: PAGE_SIZE,
      });
      const text = extractText(result);
      const parsed = JSON.parse(text);

      // Raw array response: no pagination, return it directly.
      if (Array.isArray(parsed)) {
        return parsed as T[];
      }

      // Paginated object: { count, next, previous, results: [...] }
      const pageResults = (parsed.results ?? []) as T[];
      accumulated.push(...pageResults);

      if (!parsed.next) break;
    }

    return accumulated;
  }

  // ── Correspondent operations ─────────────────────────────────────────

  /**
   * Look up an existing correspondent by vendor name using Jaro-Winkler fuzzy
   * matching (handles legal-suffix spacing variants from LLM output). Returns
   * `null` if no match passes the threshold.
   */
  async findCorrespondent(vendor: string): Promise<CorrespondentMatch | null> {
    return withSpan(tracer, "paperless-adapter.find_correspondent", {
      "correspondent.vendor": vendor,
    }, async (span) => {
      const correspondents = await this.listAllPages<{ id: number; name: string }>(
        "list_correspondents",
      );

      const match = findBestCorrespondentMatch(vendor, correspondents);
      if (match) {
        span.setAttribute("correspondent.id", match.id);
        span.setAttribute("correspondent.name", match.name);
        span.setAttribute("correspondent.match_score", match.score);
        return { id: match.id, name: match.name, score: match.score };
      }
      return null;
    });
  }

  /** Create a new correspondent. */
  async createCorrespondent(name: string): Promise<CorrespondentInfo> {
    return withSpan(tracer, "paperless-adapter.create_correspondent", {
      "correspondent.name": name,
    }, async (span) => {
      const createResult = await callMcpTool(this.cfg.paperlessMcpUrl, "create_correspondent", {
        name,
      });
      const createText = extractText(createResult);
      const created = JSON.parse(createText);
      // Runtime validation — the `as` type assertion that used to live here
      // was a runtime lie when paperless-mcp returned an unexpected shape
      // (e.g. error payload slipping through, server bug, schema drift),
      // silently producing `{id: undefined, name: undefined}`. See task 48.
      if (typeof created?.id !== "number" || typeof created?.name !== "string") {
        throw new Error(
          `paperless-mcp create_correspondent returned unexpected shape: ${createText.slice(0, 200)}`,
        );
      }
      span.setAttribute("correspondent.id", created.id);
      return { id: created.id, name: created.name };
    });
  }

  // ── Tag operations ───────────────────────────────────────────────────

  /**
   * Resolve a list of tag names to ids. Existing tags are looked up from
   * `list_tags`; missing tags are created via `create_tag`. Returns ids in
   * the same order as the input names.
   */
  async resolveTagIds(tagNames: string[], logger: AdapterLogger): Promise<number[]> {
    if (!tagNames.length) return [];

    return withSpan(tracer, "paperless-adapter.resolve_tags", {
      "tags.count": tagNames.length,
    }, async (_span) => {
      const tags = await this.listAllPages<{ id: number; name: string }>("list_tags");

      const tagIds: number[] = [];
      for (const name of tagNames) {
        const match = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
        if (match) {
          tagIds.push(match.id);
        } else {
          logger.log(`Creating tag: ${name}`);
          const createResult = await callMcpTool(this.cfg.paperlessMcpUrl, "create_tag", { name });
          const createText = extractText(createResult);
          const created = JSON.parse(createText);
          // Runtime validation — same lesson as createCorrespondent. See task 48.
          if (typeof created?.id !== "number") {
            throw new Error(
              `paperless-mcp create_tag returned unexpected shape: ${createText.slice(0, 200)}`,
            );
          }
          tagIds.push(created.id);
        }
      }
      return tagIds;
    });
  }

  // ── Document type ────────────────────────────────────────────────────

  /**
   * Look up a Paperless document type by name (case-insensitive). Returns
   * `undefined` if not found or if `list_document_types` is not available
   * on this paperless-mcp version.
   */
  async findDocumentTypeId(paperlessTypeName: string, logger: AdapterLogger): Promise<number | undefined> {
    try {
      const types = await this.listAllPages<{ id: number; name: string }>("list_document_types");
      const match = types.find(
        (t) => t.name.toLowerCase() === paperlessTypeName.toLowerCase(),
      );
      return match?.id;
    } catch {
      logger.log(`Could not resolve document type: ${paperlessTypeName}`);
      return undefined;
    }
  }

  // ── Storage path ─────────────────────────────────────────────────────

  /** Look up a storage path id by name (case-insensitive). */
  async findStoragePathId(pathName: string, logger: AdapterLogger): Promise<number | undefined> {
    try {
      const response = await fetch(`${this.cfg.paperlessUrl}/api/storage_paths/`, {
        headers: { Authorization: `Token ${this.cfg.paperlessToken}` },
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

  // ── Dedup search ─────────────────────────────────────────────────────

  /**
   * Search for documents with a custom field substring (typically order_id)
   * scoped to a single correspondent. Uses the Paperless REST API with
   * `custom_fields__icontains` because paperless-mcp's `search_documents`
   * does full-text search, which doesn't reliably hit custom field values.
   */
  async searchDocumentsByCustomFieldAndCorrespondent(
    customFieldSubstring: string,
    correspondentId: number,
    logger: AdapterLogger,
  ): Promise<PaperlessDocument[]> {
    const searchParams = new URLSearchParams({
      custom_fields__icontains: customFieldSubstring,
      correspondent__id: String(correspondentId),
      page_size: "10",
    });
    const response = await fetch(
      `${this.cfg.paperlessUrl}/api/documents/?${searchParams}`,
      { headers: { Authorization: `Token ${this.cfg.paperlessToken}` } },
    );
    if (!response.ok) {
      logger.log(`Warning: dedup search failed (${response.status}), skipping`);
      return [];
    }
    const data = (await response.json()) as { results: PaperlessDocument[] };
    return data.results ?? [];
  }

  // ── Upload + post-consumption custom fields ───────────────────────────

  /**
   * Upload a new document via direct HTTP multipart POST to
   * `/api/documents/post_document/`. Bypasses paperless-mcp because the MCP
   * buffers the entire base64 payload in memory and breaks for files larger
   * than ~5 MB.
   *
   * Returns the task UUID; use `waitForConsumption` to resolve it to a doc id.
   */
  async uploadDocument(
    file: UploadFile,
    metadata: UploadMetadata,
    logger: AdapterLogger,
  ): Promise<UploadResult> {
    return withSpan(tracer, "paperless-adapter.upload", {
      "upload.title": metadata.title,
      "upload.filename": file.filename,
      "upload.correspondent_id": metadata.correspondentId,
      "upload.tag_ids": metadata.tagIds.join(","),
      "upload.document_type_id": metadata.documentTypeId ?? 0,
      "upload.storage_path_id": metadata.storagePathId ?? 0,
      "upload.total_amount": String(metadata.totalAmountForSpan ?? ""),
      "upload.order_id": metadata.orderIdForSpan ?? "",
      "upload.file_size": file.content_base64.length,
    }, async (span) => {
      logger.log(`Uploading to Paperless: "${metadata.title}"`);

      const fileBuffer = Buffer.from(file.content_base64, "base64");
      const boundary = `----FormBoundary${Date.now()}`;
      const parts: Buffer[] = [];

      // File field
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${file.filename}"\r\nContent-Type: ${file.content_type}\r\n\r\n`,
      ));
      parts.push(fileBuffer);
      parts.push(Buffer.from("\r\n"));

      // Title
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${metadata.title}\r\n`,
      ));

      if (metadata.correspondentId) {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="correspondent"\r\n\r\n${metadata.correspondentId}\r\n`,
        ));
      }
      if (metadata.documentTypeId) {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="document_type"\r\n\r\n${metadata.documentTypeId}\r\n`,
        ));
      }
      for (const tagId of metadata.tagIds) {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="tags"\r\n\r\n${tagId}\r\n`,
        ));
      }
      if (metadata.storagePathId) {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="storage_path"\r\n\r\n${metadata.storagePathId}\r\n`,
        ));
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const response = await fetch(`${this.cfg.paperlessUrl}/api/documents/post_document/`, {
        method: "POST",
        headers: {
          Authorization: `Token ${this.cfg.paperlessToken}`,
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
      const taskUuid = resultText.replace(/^["'\s]+|["'\s]+$/g, "");
      span.setAttribute("upload.task_uuid", taskUuid);
      return { task_uuid: taskUuid };
    });
  }

  /**
   * Patch an existing document with new metadata. Used by the force-refresh
   * path: when an operator asks to reprocess a doc that already exists in
   * Paperless, we re-derive title/tags/correspondent/etc. and patch the
   * existing doc in place — preserving the doc id, the original PDF, OCR,
   * page count, and thumbnail.
   */
  async patchDocument(
    documentId: number,
    fields: PatchFields,
    logger: AdapterLogger,
  ): Promise<{ document_id: number; title: string }> {
    return withSpan(tracer, "paperless-adapter.patch", {
      "patch.document_id": documentId,
      "patch.title": fields.title,
      "patch.correspondent_id": fields.correspondentId,
      "patch.tag_ids": fields.tagIds.join(","),
      "patch.document_type_id": fields.documentTypeId ?? 0,
      "patch.storage_path_id": fields.storagePathId ?? 0,
    }, async (span) => {
      logger.log(`Force-refresh: patching Paperless doc #${documentId} with new metadata "${fields.title}"`);

      const body: Record<string, unknown> = {
        title: fields.title,
        correspondent: fields.correspondentId,
        tags: fields.tagIds,
      };
      if (fields.documentTypeId) body.document_type = fields.documentTypeId;
      if (fields.storagePathId) body.storage_path = fields.storagePathId;
      if (fields.customFields && fields.customFields.length > 0) {
        body.custom_fields = fields.customFields;
      }

      const response = await fetch(`${this.cfg.paperlessUrl}/api/documents/${documentId}/`, {
        method: "PATCH",
        headers: {
          Authorization: `Token ${this.cfg.paperlessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Paperless PATCH failed (${response.status}): ${errText.slice(0, 200)}`);
      }
      span.setAttribute("patch.success", true);
      return { document_id: documentId, title: fields.title };
    });
  }

  // ── Task polling ─────────────────────────────────────────────────────

  /**
   * Poll the Paperless task API until consumption succeeds or fails. Returns
   * the resolved doc id (parsed from the result string or `related_document`
   * field) along with the final task status. Sleeps 5s between polls (12
   * attempts → 60s wall time + 10s grace for OCR/classification).
   */
  async waitForConsumption(taskUuid: string, logger: AdapterLogger): Promise<ConsumedDocument> {
    return withSpan(tracer, "paperless-adapter.wait_for_consumption", {
      "task.uuid": taskUuid,
    }, async (span) => {
      let docId: number | undefined;
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const taskRes = await fetch(
          `${this.cfg.paperlessUrl}/api/tasks/?task_id=${taskUuid}`,
          { headers: { Authorization: `Token ${this.cfg.paperlessToken}` } },
        );
        if (!taskRes.ok) continue;
        const tasks = (await taskRes.json()) as Array<{
          status: string;
          result?: string;
          related_document?: string;
        }>;
        const task = tasks[0];
        if (!task) continue;

        if (task.status === "SUCCESS") {
          const idMatch = task.result?.match(/document id (\d+)/i);
          if (idMatch) docId = parseInt(idMatch[1], 10);
          if (!docId && task.related_document) {
            docId = parseInt(task.related_document, 10) || undefined;
          }
          // Wait for Paperless to finish all post-consumption processing
          // (OCR, classification) before PATCHing custom fields — otherwise
          // Paperless may overwrite them.
          if (docId) span.setAttribute("doc.id", docId);
          await new Promise((resolve) => setTimeout(resolve, 10000));
          return { doc_id: docId, status: "SUCCESS", result: task.result };
        } else if (task.status === "FAILURE") {
          logger.log(`Warning: Paperless consumption failed: ${task.result?.slice(0, 200)}`);
          return { doc_id: undefined, status: "FAILURE", result: task.result };
        }
        logger.log(`Waiting for Paperless consumption (attempt ${attempt + 1}/12, status: ${task.status})`);
      }
      span.setStatus({ code: SpanStatusCode.ERROR, message: "consumption timeout" });
      return { doc_id: docId, status: "TIMEOUT" };
    });
  }

  // ── Custom fields ────────────────────────────────────────────────────

  /**
   * PATCH a document's custom_fields array. The array is replaced wholesale.
   * Returns the verified field array as Paperless reports it back.
   */
  async setCustomFields(
    docId: number,
    customFields: Array<{ field: number; value: unknown }>,
    logger: AdapterLogger,
  ): Promise<{ ok: boolean; verified?: unknown; error?: string }> {
    if (customFields.length === 0) {
      return { ok: false, error: "no fields to set" };
    }

    const patchRes = await fetch(`${this.cfg.paperlessUrl}/api/documents/${docId}/`, {
      method: "PATCH",
      headers: {
        Authorization: `Token ${this.cfg.paperlessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ custom_fields: customFields }),
    });

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      logger.log(`Warning: failed to set custom fields on doc #${docId}: ${errText.slice(0, 200)}`);
      return { ok: false, error: `PATCH failed: ${errText.slice(0, 100)}` };
    }

    const verifyRes = await fetch(`${this.cfg.paperlessUrl}/api/documents/${docId}/`, {
      headers: { Authorization: `Token ${this.cfg.paperlessToken}` },
    });
    let verified: unknown;
    if (verifyRes.ok) {
      const verifyDoc = (await verifyRes.json()) as { custom_fields?: Array<{ field: number; value: unknown }> };
      verified = verifyDoc.custom_fields;
      logger.log(
        `Set custom fields on doc #${docId}: ${JSON.stringify(customFields)} — verified: ${JSON.stringify(verified)}`,
      );
    }
    return { ok: true, verified };
  }
}

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Build a `PaperlessAdapter` from the ambient environment + a field registry.
 *
 * Reads `PAPERLESS_URL`, `PAPERLESS_API_TOKEN`, and `PAPERLESS_MCP_URL` from
 * `process.env`. Throws if `PAPERLESS_URL` is unset (the adapter cannot work
 * without it). Used by `workflow-core.executeNextJob` to build the adapter
 * once per dispatch and thread it into both executors.
 */
export function createPaperlessAdapter(registry: PaperlessFieldRegistry): PaperlessAdapter {
  const paperlessUrl = process.env.PAPERLESS_URL;
  if (!paperlessUrl) throw new Error("PAPERLESS_URL environment variable is required");
  return new PaperlessAdapter({
    paperlessUrl,
    paperlessToken: process.env.PAPERLESS_API_TOKEN ?? "",
    paperlessMcpUrl: process.env.PAPERLESS_MCP_URL ?? "http://paperless-mcp:3000/mcp",
    fieldRegistry: registry,
  });
}
