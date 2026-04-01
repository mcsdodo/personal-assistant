/**
 * CLI helper for downloading email attachments to disk.
 *
 * Called by Claude via Bash to keep base64 out of the LLM context.
 * Also handles qpdf decryption for password-protected PDFs.
 *
 * Usage:
 *   bun run download-helper.ts <outlook|gmail> download_attachment <message_id> <attachment_id> <output_path>
 *
 * Reuses mcp-client.ts for MCP HTTP calls.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { callMcpTool, extractText } from "./mcp-client";

const OUTLOOK_MCP_URL = process.env.OUTLOOK_MCP_URL ?? "http://outlook-mcp:8002/mcp";
const GMAIL_MCP_URL = process.env.GMAIL_MCP_URL ?? "http://gmail-mcp:8000/mcp";
const BANK_PDF_PASSWORD = process.env.BANK_PDF_PASSWORD ?? "";

/** Read a local file and return download metadata (used by worker too). */
export function readFileAsDownload(filePath: string): {
  filename: string;
  content_base64: string;
  content_type: string;
  size: number;
} {
  const buffer = readFileSync(filePath);
  const filename = basename(filePath);
  const ext = filename.toLowerCase().split(".").pop();
  let contentType = "application/pdf";
  if (ext === "jpg" || ext === "jpeg") contentType = "image/jpeg";
  else if (ext === "png") contentType = "image/png";
  else if (ext === "heic") contentType = "image/heic";

  return {
    filename,
    content_base64: buffer.toString("base64"),
    content_type: contentType,
    size: buffer.length,
  };
}

/** Try to decrypt a PDF if it's password-protected. No-op if not encrypted. */
export function tryDecrypt(filePath: string): void {
  if (!BANK_PDF_PASSWORD) return;
  try {
    execSync(`qpdf --is-encrypted "${filePath}"`, { stdio: "ignore" });
    // Exit 0 = encrypted — decrypt in place
    execSync(
      `qpdf --password="${BANK_PDF_PASSWORD}" --decrypt "${filePath}" --replace-input`,
      { stdio: "ignore", timeout: 10000 },
    );
    console.error(`[download-helper] Decrypted ${filePath}`);
  } catch {
    // Exit 2 = not encrypted, or decrypt failed — either way, continue
  }
}

// ── CLI entrypoint ──────────────────────────────────────────────────

async function main() {
  const [, , source, tool, messageId, attachmentId, outputPath] = process.argv;

  if (!source || !tool || !messageId || !outputPath) {
    console.error(
      "Usage: bun run download-helper.ts <outlook|gmail> download_attachment <message_id> <attachment_id> <output_path>",
    );
    process.exit(1);
  }

  const mcpUrl = source === "gmail" ? GMAIL_MCP_URL : OUTLOOK_MCP_URL;

  const result = await callMcpTool(mcpUrl, tool, {
    message_id: messageId,
    attachment_id: attachmentId,
  });
  const text = extractText(result);
  const parsed = JSON.parse(text);
  const base64 = parsed.content_base64 ?? parsed.data ?? "";

  if (!base64) {
    console.error("[download-helper] No content received from MCP");
    process.exit(1);
  }

  writeFileSync(outputPath, Buffer.from(base64, "base64"));
  tryDecrypt(outputPath);
  console.log(outputPath);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[download-helper] ${err.message}`);
    process.exit(1);
  });
}
