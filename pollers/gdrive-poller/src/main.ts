#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// gdrive-poller (standalone service)
//
// Polls Google Drive folders via gmail-mcp's Drive tools, persists discovered
// files in gdrive.db, and creates scan_intake jobs directly in workflow.db.
// No MCP server. No channel mode. No tools. Lifecycle fully decoupled from
// Claude Code.
// ---------------------------------------------------------------------------

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Database } from "bun:sqlite";
import {
  createManagedMcpClient,
  startHealthServer,
  startPollLoop,
} from "../../lib/watcher-runtime";
import { openDb as openGdriveDb, insertFile, fileExists } from "../../lib/gdrive-db";
import { openWorkflowDb, createJob } from "../../lib/workflow-db";
import { validateScanIntakeInput, WorkflowSchemaError, SCAN_BUCKETS } from "../../lib/workflow-schemas";
import { requireBusinessLabel } from "../../lib/owner-config";
import {
  initTracing, getTracer, getMeter, withSpan, createLogger,
  getActiveTraceId, SpanStatusCode,
} from "../../lib/tracing";

// ── Config ────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = parseInt(process.env.GDRIVE_POLL_INTERVAL_MS ?? "30000", 10);
const DB_PATH = process.env.GDRIVE_DB_PATH ?? "/data/gdrive-watcher/gdrive.db";
const WORKFLOW_DB_PATH = process.env.WORKFLOW_DB_PATH ?? "/data/email-watcher/workflow.db";
const MAX_NEW_PER_CYCLE = parseInt(process.env.GDRIVE_MAX_NEW_PER_CYCLE ?? "5", 10);
const METRICS_PORT = parseInt(process.env.GDRIVE_WATCHER_METRICS_PORT ?? "9466", 10);
const HEALTH_STALE_MULTIPLIER = 5;
const STARTUP_DELAY_MS = parseInt(process.env.GDRIVE_STARTUP_DELAY_MS ?? "20000", 10);

const GDRIVE_MCP_URL = process.env.GDRIVE_MCP_URL ?? "http://gmail-mcp:8000/mcp";
const GOOGLE_EMAIL = process.env.GMAIL_EMAIL ?? "";

/**
 * Folder-structure config (task 96). Read from env at call time (not frozen at
 * module load) so it stays testable and a config flip takes effect on the next
 * folder resolution.
 *   - `root`   — GDRIVE_ROOT (optional). Empty = resolve owners at the Drive
 *                root exactly as before (backward-compatible 2-deep path).
 *   - `owners` — GDRIVE_OWNERS, falling back to the old GDRIVE_LEVEL1 for one
 *                release. Folder NAMES; mapped to roles via ownerFolderToRole.
 *   - `buckets`— GDRIVE_BUCKETS, falling back to GDRIVE_LEVEL2. Each must be a
 *                SCAN_BUCKETS enum value (accounting | documents).
 */
function gdriveConfig(): { root: string; owners: string[]; buckets: string[] } {
  return {
    root: (process.env.GDRIVE_ROOT ?? "").trim(),
    owners: (process.env.GDRIVE_OWNERS ?? process.env.GDRIVE_LEVEL1 ?? "techlab")
      .split(",").map((s) => s.trim()).filter(Boolean),
    buckets: (process.env.GDRIVE_BUCKETS ?? process.env.GDRIVE_LEVEL2 ?? "accounting")
      .split(",").map((s) => s.trim()).filter(Boolean),
  };
}

/** Configured external label for the business owner. Throws if OWNER_BUSINESS_LABEL is unset. */
function businessLabel(): string {
  return requireBusinessLabel();
}

/**
 * Map a Drive owner-folder NAME to the company-agnostic owner ROLE (task 96).
 * The folder whose name equals OWNER_BUSINESS_LABEL → "business";
 * a folder named "personal" → "personal". Any other name → null
 * (caller fails loud and skips, never emitting an invalid job).
 */
export function ownerFolderToRole(folderName: string): "business" | "personal" | null {
  if (folderName === businessLabel()) return "business";
  if (folderName === "personal") return "personal";
  return null;
}

// ── Tracing + logging ────────────────────────────────────────────────
initTracing("gdrive-poller");
const tracer = getTracer("gdrive-poller");
const meter = getMeter("gdrive-poller");
const log = createLogger("gdrive-poller");

let lastSuccessfulPollAt: number = Date.now();

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  /** Human-readable label (e.g. "techlab/accounting"), root excluded. */
  watchFolder: string;
  /** Owner role resolved by the poller from the owner-folder name. */
  owner: "business" | "personal";
  /** Bucket resolved from the bucket-folder name. */
  bucket: "accounting" | "documents";
  /** Resolved Drive ID of the bucket folder (the move parent — B2 fix). */
  folderId: string;
}

// ── Process new files (exported for unit tests) ──────────────────────
export async function processNewFiles(
  gdriveDb: Database,
  wfDb: Database,
  files: DriveFile[],
  maxPerCycle: number,
): Promise<void> {
  if (files.length === 0) return;
  const capped = files.slice(0, maxPerCycle);
  if (files.length > maxPerCycle) {
    log(`Capped new files from ${files.length} to ${maxPerCycle}`);
  }

  for (const file of capped) {
    insertFile(gdriveDb, {
      id: file.id,
      filename: file.name,
      mime_type: file.mimeType,
      created_at: file.createdTime,
      watch_folder: file.watchFolder,
      owner: file.owner,
      bucket: file.bucket,
      folder_id: file.folderId,
    });

    const scanDate = new Date(file.createdTime);
    const monthTag = `${scanDate.getFullYear()}-${String(scanDate.getMonth() + 1).padStart(2, "0")}`;

    const jobInput = {
      source: "gdrive" as const,
      file_id: file.id,
      watch_folder: file.watchFolder,
      month_tag: monthTag,
      owner: file.owner,
      bucket: file.bucket,
      folder_id: file.folderId,
      filename: file.name,
    };
    try {
      validateScanIntakeInput(jobInput);
    } catch (err) {
      const reason = err instanceof WorkflowSchemaError ? err.message : String(err);
      log(`✗ Refusing to create job for gdrive:${file.id}: ${reason}`);
      continue;
    }

    const perFileTracer = getTracer("gdrive-poller");
    let createdJobId: string | null = null;
    let createdJobState: string = "unknown";
    await perFileTracer.startActiveSpan(
      "gdrive-poller.process_file",
      {
        root: true,
        attributes: {
          "gdrive.file_id": file.id,
          "gdrive.filename": file.name,
          "gdrive.watch_folder": file.watchFolder,
          "gdrive.owner": file.owner,
          "gdrive.bucket": file.bucket,
          "gdrive.folder_id": file.folderId,
          "gdrive.month_tag": monthTag,
        },
      },
      (span) => {
        try {
          const job = createJob(wfDb, {
            workflowType: "scan_intake",
            inputJson: JSON.stringify(jobInput),
            sourceRef: `gdrive:${file.id}`,
            idempotencyKey: `gdrive:${file.id}`,
            requiresApproval: false,
            traceId: getActiveTraceId(),
          });
          createdJobId = job.id;
          createdJobState = job.state;
          span.setAttribute("job.id", job.id);
          span.setAttribute("job.type", "scan_intake");
          span.setAttribute("job.state", job.state);
          span.setStatus({ code: SpanStatusCode.OK });
        } finally {
          span.end();
        }
      },
    );
    log(`Created job ${createdJobId} for gdrive:${file.id} (state: ${createdJobState})`);
  }
}

// ── Metrics ──────────────────────────────────────────────────────────
function registerMetrics(db: Database): void {
  meter.createObservableGauge("gdrive_watcher.files", {
    description: "Total files tracked",
  }).addCallback((gauge) => {
    const row = db.prepare("SELECT COUNT(*) as count FROM gdrive_files").get() as { count: number };
    gauge.observe(row.count);
  });

  meter.createObservableGauge("gdrive_watcher.last_poll_seconds_ago", {
    description: "Seconds since last successful poll",
  }).addCallback((gauge) => {
    gauge.observe(Math.round((Date.now() - lastSuccessfulPollAt) / 1000));
  });
}

// ── Drive client ─────────────────────────────────────────────────────
const driveClientWrapper = createManagedMcpClient({
  name: "gdrive-poller-drive",
  version: "0.1.0",
  url: GDRIVE_MCP_URL,
  logger: { log },
  connectMessage: "Connected to gmail-mcp (Drive tools)",
});
async function getDriveClient(): Promise<Client> { return driveClientWrapper.get(); }
export function resetDriveClient(): void { driveClientWrapper.reset(); }

export function parseToolResult(result: any): any {
  if (!result?.content) return null;
  const texts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  if (texts.length === 0) return null;
  if (texts.length > 1) {
    return texts.map((t) => { try { return JSON.parse(t); } catch { return t; } });
  }
  try { return JSON.parse(texts[0]); } catch { return texts[0]; }
}

export interface WatchedFolder {
  /** Label = "{ownerFolder}/{bucket}", root excluded — for audit/display. */
  path: string;
  /** Owner ROLE (mapped from the owner-folder name). */
  owner: "business" | "personal";
  /** Bucket (one of SCAN_BUCKETS). */
  bucket: "accounting" | "documents";
  /** Resolved Drive ID of the bucket folder. */
  folderId: string;
}
let watchedFolders: WatchedFolder[] | null = null;
export function resetWatchFolders(): void { watchedFolders = null; }

export function extractFolderId(data: unknown): string | undefined {
  if (!data) return undefined;
  if (Array.isArray(data) && data.length > 0) {
    return (data[0] as Record<string, string>).id ?? (data[0] as Record<string, string>).fileId;
  }
  if (typeof data === "string") {
    const idMatch = data.match(/ID:\s*([^,\s)]+)/);
    if (idMatch) return idMatch[1].trim();
  }
  if (typeof data === "object" && data !== null) {
    return (data as Record<string, string>).id ?? (data as Record<string, string>).fileId;
  }
  return undefined;
}

async function ensureSubfolder(client: Client, parentId: string, name: string): Promise<void> {
  try {
    const result = await client.callTool({
      name: "search_drive_files",
      arguments: {
        query: `name = '${name}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        user_google_email: GOOGLE_EMAIL,
      },
    });
    const data = parseToolResult(result);
    const hasResults = (typeof data === "string" && data.includes("ID:")) ||
                      (Array.isArray(data) && data.length > 0);
    if (hasResults) { log(`Subfolder "${name}" already exists`); return; }
    await client.callTool({
      name: "create_drive_folder",
      arguments: { folder_name: name, parent_folder_id: parentId, user_google_email: GOOGLE_EMAIL },
    });
    log(`Created subfolder "${name}" in watch folder`);
  } catch (e: any) {
    log(`Warning: could not ensure subfolder "${name}": ${e.message}`);
  }
}

async function resolveWatchFolders(): Promise<WatchedFolder[]> {
  if (watchedFolders) return watchedFolders;
  const client = await getDriveClient();
  const folders: WatchedFolder[] = [];
  const { root, owners, buckets } = gdriveConfig();

  // Optional nested root. When unset, owner folders are resolved at the Drive
  // root exactly as before — byte-identical query, so the backward-compat path
  // is provably unchanged.
  let rootId: string | undefined;
  if (root) {
    const rootResult = await client.callTool({
      name: "search_drive_files",
      arguments: {
        query: `name = '${root}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        user_google_email: GOOGLE_EMAIL,
      },
    });
    rootId = extractFolderId(parseToolResult(rootResult));
    if (!rootId) { throw new Error(`GDRIVE_ROOT folder "${root}" not found`); }
    log(`Resolved root "${root}" → ${rootId}`);
  }

  for (const ownerName of owners) {
    const role = ownerFolderToRole(ownerName);
    if (!role) {
      log(`✗ Owner folder "${ownerName}" maps to no known role (expected "${businessLabel()}" or "personal") — skipping`);
      continue;
    }
    const ownerParentClause = rootId ? ` and '${rootId}' in parents` : "";
    const ownerResult = await client.callTool({
      name: "search_drive_files",
      arguments: {
        query: `name = '${ownerName}'${ownerParentClause} and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        user_google_email: GOOGLE_EMAIL,
      },
    });
    const ownerId = extractFolderId(parseToolResult(ownerResult));
    if (!ownerId) { log(`Warning: owner folder "${ownerName}" not found, skipping`); continue; }
    log(`Resolved owner "${ownerName}" (role=${role}) → ${ownerId}`);

    for (const bucketName of buckets) {
      if (!(SCAN_BUCKETS as readonly string[]).includes(bucketName)) {
        log(`✗ Bucket folder "${bucketName}" is not a known bucket (expected one of ${SCAN_BUCKETS.join(", ")}) — skipping`);
        continue;
      }
      const bucket = bucketName as "accounting" | "documents";
      const result = await client.callTool({
        name: "search_drive_files",
        arguments: {
          query: `name = '${bucketName}' and '${ownerId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          user_google_email: GOOGLE_EMAIL,
        },
      });
      const folderId = extractFolderId(parseToolResult(result));
      if (!folderId) { log(`Warning: bucket folder "${bucketName}" not found under "${ownerName}", skipping`); continue; }
      const path = `${ownerName}/${bucketName}`;
      log(`Resolved "${path}" (owner=${role}, bucket=${bucket}) → ${folderId}`);
      await ensureSubfolder(client, folderId, "processed");
      await ensureSubfolder(client, folderId, "errors");
      folders.push({ path, owner: role, bucket, folderId });
    }
  }
  if (folders.length === 0) {
    throw new Error(`No watch folders resolved (owners: ${owners.join(",")}, buckets: ${buckets.join(",")})`);
  }
  watchedFolders = folders;
  return folders;
}

export function parseDriveTextOutput(text: string, folder: WatchedFolder): DriveFile[] {
  const files: DriveFile[] = [];
  const lineRegex = /Name:\s*"([^"]+)"\s*\(ID:\s*([^,]+),\s*Type:\s*([^,]+)(?:,\s*Size:\s*\d+)?,\s*Modified:\s*([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(text)) !== null) {
    const [, name, id, mimeType, modified] = match;
    if (mimeType.trim() === "application/vnd.google-apps.folder") continue;
    files.push({
      id: id.trim(), name: name.trim(), mimeType: mimeType.trim(),
      createdTime: modified.trim(), modifiedTime: modified.trim(),
      watchFolder: folder.path, owner: folder.owner, bucket: folder.bucket, folderId: folder.folderId,
    });
  }
  return files;
}

export async function pollGdrive(): Promise<DriveFile[]> {
  try {
    const folders = await resolveWatchFolders();
    const client = await getDriveClient();
    const allFiles: DriveFile[] = [];
    for (const folder of folders) {
      const result = await client.callTool({
        name: "list_drive_items",
        arguments: { folder_id: folder.folderId, user_google_email: GOOGLE_EMAIL },
      });
      const data = parseToolResult(result);
      if (!data) continue;
      if (Array.isArray(data)) {
        const files = data
          .filter((item: any) => item.mimeType !== "application/vnd.google-apps.folder")
          .map((item: any) => ({
            id: String(item.id ?? item.fileId),
            name: item.name ?? "(unknown)",
            mimeType: item.mimeType ?? "application/octet-stream",
            createdTime: item.createdTime ?? item.modifiedTime ?? new Date().toISOString(),
            modifiedTime: item.modifiedTime ?? new Date().toISOString(),
            watchFolder: folder.path,
            owner: folder.owner,
            bucket: folder.bucket,
            folderId: folder.folderId,
          }));
        allFiles.push(...files);
      } else if (typeof data === "string") {
        allFiles.push(...parseDriveTextOutput(data, folder));
      }
    }
    return allFiles;
  } catch (e: any) {
    log(`GDrive poll error: ${e.message}`);
    resetDriveClient();
    return [];
  }
}

export async function pollCycle(gdriveDb: Database, wfDb: Database): Promise<void> {
  return withSpan(tracer, "gdrive-poller.poll", {}, async (span) => {
    const files = await pollGdrive();
    const newFiles = files.filter((f) => !fileExists(gdriveDb, f.id));
    lastSuccessfulPollAt = Date.now();
    span.setAttribute("gdrive.files_found", files.length);
    span.setAttribute("gdrive.new_count", newFiles.length);
    if (newFiles.length === 0) return;
    await processNewFiles(gdriveDb, wfDb, newFiles, MAX_NEW_PER_CYCLE);
  });
}

async function main(): Promise<void> {
  log(`Opening gdrive database at ${DB_PATH}`);
  const gdriveDb = openGdriveDb(DB_PATH);
  log(`Opening workflow database at ${WORKFLOW_DB_PATH}`);
  const wfDb = openWorkflowDb(WORKFLOW_DB_PATH);
  registerMetrics(gdriveDb);
  startHealthServer({
    port: METRICS_PORT, db: gdriveDb,
    getStaleMs: () => Date.now() - lastSuccessfulPollAt,
    maxStaleMs: POLL_INTERVAL_MS * HEALTH_STALE_MULTIPLIER,
    logger: { log }, name: "gdrive-poller",
  });
  log(`Waiting ${STARTUP_DELAY_MS}ms for gmail-mcp to start...`);
  await new Promise((resolve) => setTimeout(resolve, STARTUP_DELAY_MS));
  const { root, owners, buckets } = gdriveConfig();
  const folderPaths = owners.flatMap((o) => buckets.map((b) => `${o}/${b}`)).join(", ");
  const rootLabel = root ? `${root}/` : "(no root)";
  log(`Config: root=${rootLabel}, watch=[${folderPaths}], businessLabel=${businessLabel()}, mcp=${GDRIVE_MCP_URL}, poll=${POLL_INTERVAL_MS}ms`);
  await startPollLoop({
    name: "gdrive-poller", intervalMs: POLL_INTERVAL_MS,
    poll: () => pollCycle(gdriveDb, wfDb),
    logger: { log }, runFirstCycleImmediately: true,
  });
}

if (import.meta.main) {
  main().catch((e) => {
    log(`Fatal error: ${e.message}`);
    process.exit(1);
  });
}
