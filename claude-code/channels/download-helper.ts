/**
 * File utility functions for reading files and decrypting PDFs.
 *
 * Used by file-ops MCP (tryDecrypt) and invoice-worker (readFileAsDownload).
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { basename } from "path";

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

