#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// gdrive-watcher channel
//
// MCP Server (stdio) that polls a Google Drive folder for new scanned
// documents via gmail-mcp's Drive tools (Streamable HTTP), persists
// discovered files in SQLite, and pushes channel notifications for new scans.
// Also exposes update_gdrive_scan_status, get_gdrive_scan_status, and
// get_gdrive_scan_stats tools so Claude can write back results.
// ---------------------------------------------------------------------------

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Database } from "bun:sqlite";
import {
  openDb,
  insertFile,
  fileExists,
  updateFile,
  getRecentFiles,
  getFileStats,
} from "./gdrive-db";

import { initTracing, getTracer, withSpan, createLogger } from "./tracing";

// ---------------------------------------------------------------------------
// Config (env vars)
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = parseInt(
  process.env.GDRIVE_POLL_INTERVAL_MS ?? "30000",
  10
);
const DB_PATH = process.env.GDRIVE_DB_PATH ?? "/data/gdrive-watcher/gdrive.db";
const STARTUP_DELAY_MS = parseInt(
  process.env.GDRIVE_STARTUP_DELAY_MS ?? "20000",
  10
);
const MAX_NEW_PER_CYCLE = parseInt(
  process.env.GDRIVE_MAX_NEW_PER_CYCLE ?? "5",
  10
);
const METRICS_PORT = parseInt(
  process.env.GDRIVE_WATCHER_METRICS_PORT ?? "9466",
  10
);
const HEALTH_STALE_MULTIPLIER = 5;

const GDRIVE_MCP_URL =
  process.env.GDRIVE_MCP_URL ?? "http://gmail-mcp:8000/mcp";
const WATCH_FOLDER =
  process.env.GDRIVE_WATCH_FOLDER ?? "Techlab/Invoice scans";
const GOOGLE_EMAIL =
  process.env.GMAIL_EMAIL ?? "";

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

initTracing("gdrive-watcher");
const tracer = getTracer("gdrive-watcher");

// ---------------------------------------------------------------------------
// Logging — all to stderr (stdout reserved for MCP stdio transport)
// ---------------------------------------------------------------------------

const log = createLogger("gdrive-watcher");

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

let lastSuccessfulPollAt: number = Date.now();

function renderMetrics(db: Database): string {
  const lines: string[] = [];

  const stats = getFileStats(db);
  lines.push(
    "# HELP gdrive_watcher_files_total Total files tracked by status"
  );
  lines.push("# TYPE gdrive_watcher_files_total gauge");
  for (const [status, count] of Object.entries(stats)) {
    lines.push(`gdrive_watcher_files_total{status="${status}"} ${count}`);
  }

  const staleMs = Date.now() - lastSuccessfulPollAt;
  lines.push(
    "# HELP gdrive_watcher_last_poll_seconds_ago Seconds since last successful poll"
  );
  lines.push("# TYPE gdrive_watcher_last_poll_seconds_ago gauge");
  lines.push(
    `gdrive_watcher_last_poll_seconds_ago ${Math.round(staleMs / 1000)}`
  );

  lines.push("");
  return lines.join("\n");
}

function startMetricsServer(db: Database): void {
  Bun.serve({
    port: METRICS_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        try {
          db.query("SELECT 1").get();
          const staleMs = Date.now() - lastSuccessfulPollAt;
          const maxStaleMs = POLL_INTERVAL_MS * HEALTH_STALE_MULTIPLIER;
          if (staleMs > maxStaleMs) {
            return new Response(
              `stale: last poll ${Math.round(staleMs / 1000)}s ago`,
              { status: 503 }
            );
          }
          return new Response("ok", { status: 200 });
        } catch {
          return new Response("db error", { status: 503 });
        }
      }
      if (url.pathname === "/metrics") {
        return new Response(renderMetrics(db), {
          headers: {
            "content-type": "text/plain; version=0.0.4; charset=utf-8",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  log(`Metrics server listening on :${METRICS_PORT} (/health, /metrics)`);
}

// ---------------------------------------------------------------------------
// MCP Client (connects to gmail-mcp for Drive tools)
// ---------------------------------------------------------------------------

let driveClient: Client | null = null;

async function getDriveClient(): Promise<Client> {
  if (driveClient) return driveClient;
  const client = new Client(
    { name: "gdrive-watcher-drive", version: "0.1.0" },
    {}
  );
  const transport = new StreamableHTTPClientTransport(new URL(GDRIVE_MCP_URL));
  await client.connect(transport);
  driveClient = client;
  log("Connected to gmail-mcp (Drive tools)");
  return client;
}

function resetDriveClient(): void {
  driveClient = null;
}

/**
 * Extract data from MCP tool result content blocks.
 *
 * FastMCP (Python) serialises list[dict] as separate text content blocks —
 * one JSON object per block. If there are multiple text blocks, try to parse
 * each individually and return an array. Single block: try JSON.parse, fall
 * back to raw text.
 */
function parseToolResult(result: any): any {
  if (!result?.content) return null;

  const texts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  if (texts.length === 0) return null;

  // Multiple text blocks → likely one JSON object per block (FastMCP list)
  if (texts.length > 1) {
    return texts.map((t) => {
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    });
  }

  // Single block → try JSON.parse, fall back to raw text
  try {
    return JSON.parse(texts[0]);
  } catch {
    return texts[0];
  }
}

// ---------------------------------------------------------------------------
// Google Drive polling
// ---------------------------------------------------------------------------

let watchFolderId: string | null = null;

async function resolveWatchFolderId(): Promise<string> {
  if (watchFolderId) return watchFolderId;

  const client = await getDriveClient();
  const folderParts = WATCH_FOLDER.split("/");
  const leafName = folderParts[folderParts.length - 1];

  const result = await client.callTool({
    name: "search_drive_files",
    arguments: {
      query: `name = '${leafName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      user_google_email: GOOGLE_EMAIL,
    },
  });

  const data = parseToolResult(result);
  if (!data) {
    throw new Error(`Watch folder not found: ${WATCH_FOLDER}`);
  }

  // Try structured data first, fall back to text parsing
  let folderId: string | undefined;
  if (Array.isArray(data) && data.length > 0) {
    folderId = data[0].id ?? data[0].fileId;
  } else if (typeof data === "string") {
    // Parse "ID: xxx" from text output
    const idMatch = data.match(/ID:\s*([^,\s)]+)/);
    if (idMatch) folderId = idMatch[1].trim();
  } else if (typeof data === "object") {
    folderId = data.id ?? data.fileId;
  }

  if (!folderId) {
    throw new Error(`Could not resolve folder ID for: ${WATCH_FOLDER} (response: ${typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)})`);
  }

  watchFolderId = folderId;
  log(`Resolved watch folder "${WATCH_FOLDER}" → ${folderId}`);

  // Ensure Processed and Errors subfolders exist
  await ensureSubfolder(client, folderId, "Processed");
  await ensureSubfolder(client, folderId, "Errors");

  return folderId;
}

async function ensureSubfolder(
  client: Client,
  parentId: string,
  name: string,
): Promise<void> {
  try {
    // Check if subfolder already exists
    const result = await client.callTool({
      name: "search_drive_files",
      arguments: {
        query: `name = '${name}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        user_google_email: GOOGLE_EMAIL,
      },
    });
    const data = parseToolResult(result);
    const hasResults =
      (typeof data === "string" && data.includes("ID:")) ||
      (Array.isArray(data) && data.length > 0);

    if (hasResults) {
      log(`Subfolder "${name}" already exists`);
      return;
    }

    // Create it
    await client.callTool({
      name: "create_drive_folder",
      arguments: {
        folder_name: name,
        parent_folder_id: parentId,
        user_google_email: GOOGLE_EMAIL,
      },
    });
    log(`Created subfolder "${name}" in watch folder`);
  } catch (e: any) {
    log(`Warning: could not ensure subfolder "${name}": ${e.message}`);
  }
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
}

/**
 * Parse the human-readable text output from google_workspace_mcp's
 * list_drive_items / search_drive_files tools.
 *
 * Format per line:
 *   - Name: "filename" (ID: xxx, Type: mime, Size: n, Modified: iso) Link: url
 */
function parseDriveTextOutput(text: string): DriveFile[] {
  const files: DriveFile[] = [];
  const lineRegex =
    /Name:\s*"([^"]+)"\s*\(ID:\s*([^,]+),\s*Type:\s*([^,]+)(?:,\s*Size:\s*\d+)?,\s*Modified:\s*([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(text)) !== null) {
    const [, name, id, mimeType, modified] = match;
    if (mimeType.trim() === "application/vnd.google-apps.folder") continue;
    files.push({
      id: id.trim(),
      name: name.trim(),
      mimeType: mimeType.trim(),
      createdTime: modified.trim(),
      modifiedTime: modified.trim(),
    });
  }
  return files;
}

async function pollGdrive(): Promise<DriveFile[]> {
  try {
    const folderId = await resolveWatchFolderId();
    const client = await getDriveClient();

    const result = await client.callTool({
      name: "list_drive_items",
      arguments: { folder_id: folderId, user_google_email: GOOGLE_EMAIL },
    });

    const data = parseToolResult(result);
    if (!data) return [];

    // google_workspace_mcp returns human-readable text, not JSON objects.
    // Try structured data first (array of objects), fall back to text parsing.
    if (Array.isArray(data)) {
      return data
        .filter((item: any) => item.mimeType !== "application/vnd.google-apps.folder")
        .map((item: any) => ({
          id: String(item.id ?? item.fileId),
          name: item.name ?? "(unknown)",
          mimeType: item.mimeType ?? "application/octet-stream",
          createdTime: item.createdTime ?? item.modifiedTime ?? new Date().toISOString(),
          modifiedTime: item.modifiedTime ?? new Date().toISOString(),
        }));
    }

    // Text format: parse line-by-line
    if (typeof data === "string") {
      return parseDriveTextOutput(data);
    }

    return [];
  } catch (e: any) {
    log(`GDrive poll error: ${e.message}`);
    resetDriveClient();
    return [];
  }
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

async function pollCycle(db: Database, channel: Server): Promise<void> {
  return withSpan(tracer, "gdrive-watcher.poll", {}, async (span) => {
    const files = await pollGdrive();

    // Any file in the watch folder that isn't tracked yet should be processed.
    // Unlike email-watcher, there's no "seeding" — files stay in this folder
    // precisely because they need processing. They move to Processed/ after upload.
    const newFiles = files.filter((f) => !fileExists(db, f.id));

    // Poll completed successfully
    lastSuccessfulPollAt = Date.now();

    span.setAttribute("gdrive.files_found", files.length);
    span.setAttribute("gdrive.new_count", newFiles.length);

    if (newFiles.length === 0) return;

    // Cap to avoid flooding
    const capped = newFiles.slice(0, MAX_NEW_PER_CYCLE);
    if (newFiles.length > MAX_NEW_PER_CYCLE) {
      log(`Capped new files from ${newFiles.length} to ${MAX_NEW_PER_CYCLE}`);
    }

    for (const file of capped) {
      // Insert as 'new'
      insertFile(db, {
        id: file.id,
        filename: file.name,
        mime_type: file.mimeType,
        created_at: file.createdTime,
        status: "new",
      });

      // Derive month_tag from file creation date
      const scanDate = new Date(file.createdTime);
      const monthTag = `${scanDate.getFullYear()}-${String(scanDate.getMonth() + 1).padStart(2, "0")}`;

      // Push channel notification
      const contentLines = [
        "New scanned document detected in Google Drive:",
        `Name: ${file.name}`,
        `MIME type: ${file.mimeType}`,
        `Scanned: ${file.createdTime}`,
        `Month tag: ${monthTag}`,
        `File ID: ${file.id}`,
        `Folder: ${WATCH_FOLDER}`,
      ];

      await channel.notification({
        method: "notifications/claude/channel",
        params: {
          content: contentLines.join("\n"),
          meta: {
            source: "gdrive",
            file_id: file.id,
            name: file.name,
            mime_type: file.mimeType,
            created_time: file.createdTime,
            month_tag: monthTag,
            timestamp: new Date().toISOString(),
          },
        },
      });
    }

    log(`Pushed ${capped.length} new file(s)`);
  });
}

// ---------------------------------------------------------------------------
// Retry stuck files from previous session
// ---------------------------------------------------------------------------

/**
 * Re-push files stuck in non-terminal states ('new') as channel
 * notifications. These got stuck because Claude restarted mid-processing.
 * The DB is the source of truth — if status isn't terminal, re-push it.
 */
async function retryStuck(db: Database, channel: Server): Promise<void> {
  const stuck = db
    .prepare(
      "SELECT * FROM gdrive_files WHERE status IN ('new') ORDER BY discovered_at ASC"
    )
    .all() as import("./gdrive-db").FileRow[];

  if (stuck.length === 0) return;

  log(`Retrying ${stuck.length} stuck file(s)`);
  const capped = stuck.slice(0, MAX_NEW_PER_CYCLE);

  for (const file of capped) {
    const scanDate = new Date(file.created_at ?? new Date().toISOString());
    const monthTag = `${scanDate.getFullYear()}-${String(scanDate.getMonth() + 1).padStart(2, "0")}`;

    await channel.notification({
      method: "notifications/claude/channel",
      params: {
        content: [
          "Retry: scanned document stuck from previous session:",
          `Name: ${file.filename ?? "(unknown)"}`,
          `File ID: ${file.id}`,
          `Month tag: ${monthTag}`,
          `Status: ${file.status}`,
        ].join("\n"),
        meta: {
          source: "gdrive",
          file_id: file.id,
          name: file.filename ?? "",
          created_time: file.created_at ?? "",
          month_tag: monthTag,
          timestamp: new Date().toISOString(),
          retry: "true",
        },
      },
    });
  }

  log(`Re-pushed ${capped.length} stuck file(s)`);
}

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: "gdrive-watcher", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      'Events from gdrive-watcher arrive as <channel source="gdrive-watcher" ...>.',
      "Each event is a NEW scanned document detected in a Google Drive folder.",
      "",
      "When you receive a gdrive-watcher event:",
      "1. Download the file using the gmail MCP's get_drive_file_content or get_drive_file_download_url tool (use the file_id from meta)",
      "2. Classify using the scan-classifier subagent (pass the file content for vision-based analysis)",
      "3. Create a workflow job via create_scan_intake_job with the classification result",
      "4. After the job completes, call update_gdrive_scan_status to record the outcome",
      "",
      "The month_tag meta field contains the YYYY-MM tag derived from scan date. Use this as-is for tagging.",
      "",
      "IMPORTANT: After processing, call update_gdrive_scan_status to record the result.",
    ].join("\n"),
  }
);

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

let db: Database;

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "update_gdrive_scan_status",
      description:
        "Update the status and processing details of a tracked GDrive scan. " +
        "Call this after classifying or processing a scan to record the result.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "File ID (file_id from the channel event)",
          },
          status: {
            type: "string",
            enum: ["processing", "completed", "failed", "ignored"],
            description: "New status",
          },
          classification: {
            type: "string",
            description: "Classification result JSON",
          },
          action: { type: "string", description: "Action taken" },
          job_id: { type: "string", description: "Workflow job ID" },
          process_result: {
            type: "string",
            description: "Result of processing",
          },
          error: { type: "string", description: "Error message if failed" },
        },
        required: ["id", "status"],
      },
    },
    {
      name: "get_gdrive_scan_status",
      description:
        "Get recently discovered scanned files from the audit log, with optional filtering by status.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Max files to return (default: 20)",
          },
          status: { type: "string", description: "Filter by status" },
        },
      },
    },
    {
      name: "get_gdrive_scan_stats",
      description: "Get scan processing statistics (counts by status).",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "update_gdrive_scan_status": {
        const id = args?.id as string;
        const status = args?.status as string;
        if (!id || !status) {
          return {
            content: [{ type: "text", text: "Error: id and status are required" }],
            isError: true,
          };
        }
        const fields: Record<string, string | null> = { status };
        if (args?.classification)
          fields.classification = args.classification as string;
        if (args?.action) fields.action = args.action as string;
        if (args?.job_id) fields.job_id = args.job_id as string;
        if (args?.process_result)
          fields.process_result = args.process_result as string;
        if (args?.error) fields.error = args.error as string;

        const found = updateFile(db, id, fields);
        if (!found) {
          return {
            content: [{ type: "text", text: `File ${id} not found in database` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Updated file ${id}: status=${status}` }],
        };
      }

      case "get_gdrive_scan_status": {
        const limit = (args?.limit as number) ?? 20;
        const status = args?.status as string | undefined;
        const rows = getRecentFiles(db, { limit, status });
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      }

      case "get_gdrive_scan_stats": {
        const stats = getFileStats(db);
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `Error: ${e.message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Open SQLite DB
  log(`Opening database at ${DB_PATH}`);
  db = openDb(DB_PATH);
  startMetricsServer(db);

  // 2. Connect MCP server (stdio)
  await mcp.connect(new StdioServerTransport());
  log("MCP server connected (stdio)");

  // 3. Tool handlers are already registered above

  // 4. Wait for gmail-mcp (Drive tools) to start
  log(`Waiting ${STARTUP_DELAY_MS}ms for MCP servers to start...`);
  await new Promise((resolve) => setTimeout(resolve, STARTUP_DELAY_MS));

  // 5. Log config
  log(
    `Config: watch=${WATCH_FOLDER}, mcp=${GDRIVE_MCP_URL}, poll=${POLL_INTERVAL_MS}ms`
  );

  // 6. Run first poll cycle
  try {
    await pollCycle(db, mcp);
  } catch (e: any) {
    log(`First poll cycle error: ${e.message}`);
  }

  // 7. Retry files stuck from previous session
  try {
    await retryStuck(db, mcp);
  } catch (e: any) {
    log(`Retry stuck error: ${e.message}`);
  }

  // 8. Start interval timer
  setInterval(async () => {
    try {
      await pollCycle(db, mcp);
    } catch (e: any) {
      log(`Poll cycle error: ${e.message}`);
    }
  }, POLL_INTERVAL_MS);
}

main().catch((e) => {
  log(`Fatal error: ${e.message}`);
  process.exit(1);
});
