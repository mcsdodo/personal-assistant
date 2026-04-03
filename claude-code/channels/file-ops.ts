#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// file-ops MCP tool server (stdio)
//
// Scoped file operations for /workspace/downloads/. Replaces dangerous Bash
// wildcard patterns in settings.json with validated, sandboxed tools.
//
// Tools: download_file, delete_file, list_files, decrypt_pdf, read_base64, get_env
// ---------------------------------------------------------------------------

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { tryDecrypt, readFileAsDownload } from "./download-helper";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR ?? "/workspace/downloads";

const ENV_ALLOWLIST = new Set([
  "GMAIL_EMAIL",
  "TELEGRAM_CHAT_ID",
  "BUSINESS_COMPANY_NAME",
  "BUSINESS_TAX_IDS",
  "BUSINESS_CRN",
  "BUSINESS_LICENSE_PLATES",
]);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Validate filename: no path separators, no traversal, no empty. */
export function validateFilename(filename: string): string {
  if (!filename || typeof filename !== "string") {
    throw new Error("filename is required");
  }
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new Error(`Invalid filename: must not contain path separators or '..': ${filename}`);
  }
  if (filename.startsWith(".")) {
    throw new Error(`Invalid filename: must not start with '.': ${filename}`);
  }
  return filename;
}

/** Validate URL: must be http or https. */
export function validateUrl(url: string): string {
  if (!url || typeof url !== "string") {
    throw new Error("url is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL must use http or https protocol: ${url}`);
  }
  return url;
}

/** Build safe absolute path inside DOWNLOADS_DIR. */
function safePath(filename: string): string {
  return join(DOWNLOADS_DIR, validateFilename(filename));
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/** Download a URL to /workspace/downloads/{filename}. */
async function downloadFile(url: string, filename: string): Promise<string> {
  validateUrl(url);
  const outPath = safePath(filename);

  mkdirSync(DOWNLOADS_DIR, { recursive: true });

  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status} ${resp.statusText}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  await Bun.write(outPath, buffer);

  return JSON.stringify({
    path: outPath,
    size: buffer.length,
    filename: basename(outPath),
  });
}

/** Delete a file from /workspace/downloads/. */
function deleteFile(filename: string): string {
  const filePath = safePath(filename);
  if (!existsSync(filePath)) {
    return JSON.stringify({ deleted: false, error: "File not found", path: filePath });
  }
  unlinkSync(filePath);
  return JSON.stringify({ deleted: true, path: filePath });
}

/** List files in /workspace/downloads/. */
function listFiles(): string {
  if (!existsSync(DOWNLOADS_DIR)) {
    return JSON.stringify({ files: [], directory: DOWNLOADS_DIR });
  }
  const entries = readdirSync(DOWNLOADS_DIR).map((name) => {
    try {
      const st = statSync(join(DOWNLOADS_DIR, name));
      return { name, size: st.size, modified: st.mtime.toISOString() };
    } catch {
      return { name, size: 0, modified: null };
    }
  });
  return JSON.stringify({ files: entries, directory: DOWNLOADS_DIR });
}

/** Decrypt a password-protected PDF in /workspace/downloads/. */
function decryptPdf(filename: string): string {
  const filePath = safePath(filename);
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  tryDecrypt(filePath);
  const st = statSync(filePath);
  return JSON.stringify({ path: filePath, size: st.size, decrypted: true });
}

/** Return base64 encoding of a file in /workspace/downloads/. */
function readBase64(filename: string): string {
  const filePath = safePath(filename);
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return JSON.stringify(readFileAsDownload(filePath));
}

/** Return value of an allowlisted environment variable. */
function getEnv(name: string): string {
  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  if (!ENV_ALLOWLIST.has(name)) {
    throw new Error(
      `Environment variable '${name}' is not in the allowlist. Allowed: ${[...ENV_ALLOWLIST].join(", ")}`,
    );
  }
  const value = process.env[name] ?? "";
  return JSON.stringify({ name, value });
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "file-ops", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "download_file",
      description:
        "Download a file from a URL to /workspace/downloads/. Follows redirects. Returns path and size.",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "HTTP/HTTPS URL to download" },
          filename: {
            type: "string",
            description:
              "Output filename (no path separators). Saved to /workspace/downloads/{filename}.",
          },
        },
        required: ["url", "filename"],
      },
    },
    {
      name: "delete_file",
      description: "Delete a file from /workspace/downloads/.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filename: {
            type: "string",
            description: "Filename to delete (no path separators).",
          },
        },
        required: ["filename"],
      },
    },
    {
      name: "list_files",
      description:
        "List all files in /workspace/downloads/ with size and modification time.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "decrypt_pdf",
      description:
        "Decrypt a password-protected PDF in /workspace/downloads/ using the configured bank PDF password. No-op if the file is not encrypted.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filename: {
            type: "string",
            description: "PDF filename to decrypt (no path separators).",
          },
        },
        required: ["filename"],
      },
    },
    {
      name: "read_base64",
      description:
        "Read a file from /workspace/downloads/ and return its content as base64.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filename: {
            type: "string",
            description: "Filename to encode (no path separators).",
          },
        },
        required: ["filename"],
      },
    },
    {
      name: "get_env",
      description:
        "Read an allowlisted environment variable. Allowed: GMAIL_EMAIL, TELEGRAM_CHAT_ID, BUSINESS_COMPANY_NAME, BUSINESS_TAX_IDS, BUSINESS_CRN, BUSINESS_LICENSE_PLATES.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Environment variable name (must be in allowlist).",
          },
        },
        required: ["name"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case "download_file":
        result = await downloadFile(args?.url as string, args?.filename as string);
        break;
      case "delete_file":
        result = deleteFile(args?.filename as string);
        break;
      case "list_files":
        result = listFiles();
        break;
      case "decrypt_pdf":
        result = decryptPdf(args?.filename as string);
        break;
      case "read_base64":
        result = readBase64(args?.filename as string);
        break;
      case "get_env":
        result = getEnv(args?.name as string);
        break;
      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return { content: [{ type: "text" as const, text: result }] };
  } catch (err: any) {
    return {
      content: [{ type: "text" as const, text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[file-ops] MCP server started");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[file-ops] Fatal: ${err.message}`);
    process.exit(1);
  });
}
