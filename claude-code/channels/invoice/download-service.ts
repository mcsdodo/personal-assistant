/**
 * Download service for invoice/scan intake.
 *
 * Owns every way the worker fetches a file from an upstream system:
 *   - Email attachments via Outlook MCP and Gmail MCP
 *   - Email body link extraction + direct HTTP download (Alza-style)
 *   - Direct HTTP download with browser-header retry
 *   - GDrive direct download via gmail/Drive MCP `get_drive_file_download_url`
 *
 * Behavior is identical to the inline functions that previously lived in
 * `invoice-worker.ts` — this is a structural extraction, not a rewrite.
 *
 * The service is a stateless module of pure async functions. Callers pass in
 * the MCP URLs, the email source, and the classification fields the function
 * needs. No singletons; each function is independently testable.
 */

import { callMcpTool, extractText } from "../mcp-client";
import { extractInvoiceLinks, type InvoiceLink } from "../invoice-links";
import { getTracer, withSpan } from "../tracing";

// ── Public types ──────────────────────────────────────────────────────

/**
 * The file shape returned by every download path. Always base64-encoded so
 * the caller can persist it or hand it to Paperless without worrying about
 * the underlying transport.
 */
export interface DownloadedFile {
  filename: string;
  content_base64: string;
  content_type: string;
  size: number;
}

/** Download strategies the email-classifier can return. */
export type DownloadStrategy =
  | "attachment"
  | "known_link"
  | "direct_url"
  | "browser_required"
  | "manual_review"
  | "claude_download";

export interface DownloadServiceLogger {
  log(message: string): void;
}

/** Subset of the email classification fields the link-download path needs. */
export interface LinkDownloadContext {
  sender: string;
  subject: string;
  download_strategy: DownloadStrategy | null;
}

/** Subset of the invoice intake input the worker passes through. */
export interface EmailRef {
  email_source: string; // "gmail" | "outlook"
  message_id: string;
}

const tracer = getTracer("invoice-worker");

// ── Email download router ─────────────────────────────────────────────

/**
 * Top-level download dispatch for email-sourced jobs. Picks the right
 * concrete strategy and emits a span with strategy + size.
 */
export async function downloadInvoice(
  input: EmailRef,
  classification: LinkDownloadContext,
  mcpUrls: { gmail: string; outlook: string },
  googleEmail: string,
  logger: DownloadServiceLogger,
): Promise<DownloadedFile> {
  return withSpan(tracer, "invoice-worker.download", {
    "download.strategy": classification.download_strategy ?? "unknown",
    "email.source": input.email_source,
    "email.message_id": input.message_id,
  }, async (span) => {
    const { email_source, message_id } = input;
    const strategy = classification.download_strategy;
    const mcpUrl = email_source === "gmail" ? mcpUrls.gmail : mcpUrls.outlook;

    let file: DownloadedFile;
    switch (strategy) {
      case "attachment":
      case "claude_download":
        // claude_download: multiple attachments — worker picks the first PDF (best heuristic)
        file = await downloadAttachment(mcpUrl, email_source, message_id, googleEmail, logger);
        break;

      case "known_link":
      case "direct_url":
        file = await downloadViaLink(input, classification, mcpUrl, googleEmail, logger);
        break;

      default:
        throw new Error(`Unsupported download strategy: ${strategy}`);
    }

    span.setAttribute("download.filename", file.filename);
    span.setAttribute("download.size", file.size);
    return file;
  });
}

// ── Email attachment download (Outlook + Gmail) ───────────────────────

/**
 * Download an email attachment from either Outlook or Gmail. Picks the best
 * attachment heuristically (prefer PDF, fall back to first).
 *
 * IMPORTANT: returns size from the actual download response (`dlParsed.size`),
 * NOT from the email metadata. Outlook reports a different size in its
 * `get_attachments` list response than in `download_attachment`. Phase 0.1
 * fixed a regression where this was returning the metadata size.
 */
export async function downloadAttachment(
  mcpUrl: string,
  source: string,
  messageId: string,
  googleEmail: string,
  logger: DownloadServiceLogger,
): Promise<DownloadedFile> {
  logger.log(`Downloading attachment from ${source} message ${messageId}`);

  if (source === "outlook") {
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

    const pdfAttachment = attachments.find(
      (a) => a.content_type === "application/pdf" || a.name.toLowerCase().endsWith(".pdf"),
    );
    const target = pdfAttachment ?? attachments[0];

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
      user_google_email: googleEmail,
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

    const target = attachments.find(
      (a) => a.mimeType === "application/pdf" || a.filename.toLowerCase().endsWith(".pdf"),
    ) ?? attachments[0];

    const downloadResult = await callMcpTool(mcpUrl, "get_gmail_attachment_content", {
      message_id: messageId,
      attachment_id: target.attachmentId,
      user_google_email: googleEmail,
    });
    const downloadText = extractText(downloadResult);

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

// ── Email link download ───────────────────────────────────────────────

/**
 * Extract invoice download links from the email HTML body using vendor
 * rules in `invoice-links.ts`, then HTTP-download the first match.
 */
export async function downloadViaLink(
  input: EmailRef,
  classification: LinkDownloadContext,
  mcpUrl: string,
  googleEmail: string,
  logger: DownloadServiceLogger,
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
        user_google_email: googleEmail,
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

// ── Direct HTTP download ──────────────────────────────────────────────

/**
 * Download a file from an arbitrary URL with redirect following. Retries
 * with browser-like headers on 403/409/429 (some vendors block default
 * fetch UAs). Resolves the filename from Content-Disposition or the URL
 * path; falls back to `download.pdf` and adds `.pdf` if the magic header
 * `%PDF-` is present.
 */
export async function downloadInvoiceUrl(url: string): Promise<DownloadedFile> {
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

// ── GDrive download ───────────────────────────────────────────────────

/**
 * Download a file from Google Drive via the gmail/Drive MCP. Two-step:
 * `get_drive_file_download_url` returns a temporary URL (typically a
 * localhost-based mcp endpoint), then a direct fetch streams the binary.
 *
 * The MCP server returns localhost URLs which need to be rewritten to the
 * container hostname when running inside Docker.
 */
export async function downloadFromGdrive(
  fileId: string,
  filename: string | undefined,
  gmailMcpUrl: string,
  googleEmail: string,
  logger: DownloadServiceLogger,
): Promise<DownloadedFile> {
  logger.log(`Downloading file ${fileId} from GDrive`);

  // Step 1: Get download URL via Drive MCP
  const urlResult = await callMcpTool(gmailMcpUrl, "get_drive_file_download_url", {
    file_id: fileId,
    user_google_email: googleEmail,
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
  downloadUrl = downloadUrl.replace("http://localhost:8000", gmailMcpUrl.replace("/mcp", ""));
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
