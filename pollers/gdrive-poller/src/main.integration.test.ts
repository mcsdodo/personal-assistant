import { mock } from "bun:test";

// MCP SDK mocks — delegate to a local callToolImpl for Drive tool calls.
type CallToolFn = (params: { name: string; arguments: Record<string, any> }) => Promise<any>;
let callToolImpl: CallToolFn = async () => ({ content: [] });

// Override the globalThis hook used by the test-preload Client mock so our
// local callToolImpl is invoked for gdrive-poller Drive tool calls.
(globalThis as any).__gdriveCallTool = (args: any) => callToolImpl(args);

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { openDb, fileExists, insertFile, getRecentFiles } from "../../lib/gdrive-db";
import {
  pollCycle,
  pollGdrive,
  resetWatchFolders,
  resetDriveClient,
} from "./main";
import { openWorkflowDb, getJobByIdempotencyKey } from "../../lib/workflow-db";

// ---------------------------------------------------------------------------
// Read the same env vars the production code uses so mocks match reality.
// ---------------------------------------------------------------------------

const LEVEL1 = (process.env.GDRIVE_LEVEL1 ?? "techlab").split(",").map(s => s.trim()).filter(Boolean);
const LEVEL2 = (process.env.GDRIVE_LEVEL2 ?? "accounting").split(",").map(s => s.trim()).filter(Boolean);
// Use first resolved level2 as the "primary" for assertions
const PRIMARY_L1 = LEVEL1[0];
const PRIMARY_L2 = LEVEL2[0];
const PRIMARY_WATCH = `${PRIMARY_L1}/${PRIMARY_L2}`;
// With the default config (PRIMARY_L1 == "techlab" == OWNER_BUSINESS_LABEL,
// PRIMARY_L2 == "accounting"), the poller resolves owner role "business",
// bucket "accounting", and the bucket folder id returned by the standard mock.
const PRIMARY_OWNER_ROLE = "business";
const PRIMARY_BUCKET = "accounting";
const PRIMARY_FOLDER_ID = "invoicing-folder-id";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock MCP channel server with a spy on notification(). */
function createMockChannel() {
  const notifications: any[] = [];
  return {
    notification: mock(async (params: any) => {
      notifications.push(params);
    }),
    notifications,
    connect() { return Promise.resolve(); },
    setRequestHandler() {},
  };
}

/** Build a CallToolResult with a single text content block. */
function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

/** Build a CallToolResult with JSON array in a single text block. */
function jsonArrayResult(items: any[]) {
  return {
    content: [{ type: "text", text: JSON.stringify(items) }],
  };
}

/**
 * Standard callTool mock that resolves watch folders and returns file listings.
 * Uses env-derived LEVEL1/LEVEL2 so the mock matches whatever the production
 * code actually queries (e.g. "invoicing_dev" in dev, "invoicing" in prod).
 *
 * Only the first level2 folder resolves — others are intentionally "not found"
 * (mirrors reality where not all folders exist yet).
 */
function createStandardCallTool(files: any[] = []) {
  return async (params: { name: string; arguments: Record<string, any> }) => {
    const { name, arguments: args } = params;

    if (name === "search_drive_files") {
      const query = args.query as string;
      // Level1 folder lookup
      if (query.includes(`name = '${PRIMARY_L1}'`) && query.includes("mimeType = 'application/vnd.google-apps.folder'") && !query.includes("in parents")) {
        return jsonArrayResult([{ id: "techlab-folder-id", name: PRIMARY_L1 }]);
      }
      // Level2 folder lookup — only PRIMARY_L2 resolves
      if (query.includes(`name = '${PRIMARY_L2}'`) && query.includes("'techlab-folder-id' in parents")) {
        return jsonArrayResult([{ id: "invoicing-folder-id", name: PRIMARY_L2 }]);
      }
      // Processed/errors subfolder check
      if (query.includes("name = 'processed'") || query.includes("name = 'errors'")) {
        return jsonArrayResult([{ id: "subfolder-exists", name: query.includes("processed") ? "processed" : "errors" }]);
      }
      return textResult("No results");
    }

    if (name === "list_drive_items") {
      if (files.length === 0) {
        return textResult("No items found");
      }
      return jsonArrayResult(files);
    }

    return { content: [] };
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("gdrive-watcher integration", () => {
  let tmpDir: string;
  let db: Database;
  let wfDb: ReturnType<typeof openWorkflowDb>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gdrive-int-test-"));
    db = openDb(join(tmpDir, "test.db"));
    wfDb = openWorkflowDb(join(tmpDir, "workflow.db"));
    // Reset module-level caches so each test starts fresh
    resetWatchFolders();
    resetDriveClient();
  });

  afterEach(() => {
    db.close();
    try { wfDb.close(); } catch {}
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows WAL lock
    }
  });

  // -------------------------------------------------------------------------
  // pollCycle: detect new file and create workflow job
  // -------------------------------------------------------------------------
  test("pollCycle detects new file and creates workflow job", async () => {
    const driveFile = {
      id: "file-abc123",
      name: "scan_invoice_march.pdf",
      mimeType: "application/pdf",
      createdTime: "2026-03-25T14:30:00Z",
      modifiedTime: "2026-03-25T14:30:00Z",
    };

    callToolImpl = createStandardCallTool([driveFile]);
    const channel = createMockChannel();

    await pollCycle(db, wfDb);

    // File should be inserted into gdrive DB
    expect(fileExists(db, "file-abc123")).toBe(true);

    // No channel notification — jobs are created directly
    expect(channel.notification).toHaveBeenCalledTimes(0);

    // Workflow job should exist with correct fields
    const job = getJobByIdempotencyKey(wfDb, "gdrive:file-abc123");
    expect(job).not.toBeNull();
    expect(job!.workflow_type).toBe("scan_intake");
    expect(job!.state).toBe("queued");
    expect(job!.source_ref).toBe("gdrive:file-abc123");

    const input = JSON.parse(job!.input_json!);
    expect(input.source).toBe("gdrive");
    expect(input.file_id).toBe("file-abc123");
    expect(input.filename).toBe("scan_invoice_march.pdf");
    expect(input.month_tag).toBe("2026-03");
    expect(input.watch_folder).toBe(PRIMARY_WATCH);
  });

  // -------------------------------------------------------------------------
  // pollCycle: per-file root span for trace-per-file topology (task 48)
  // -------------------------------------------------------------------------
  test("pollCycle starts a root span per file for trace-per-file topology", async () => {
    const driveFiles = [
      { id: "trace-file-1", name: "invoice_a.pdf", mimeType: "application/pdf", createdTime: "2026-03-15T10:00:00Z", modifiedTime: "2026-03-15T10:00:00Z" },
      { id: "trace-file-2", name: "invoice_b.pdf", mimeType: "application/pdf", createdTime: "2026-03-16T10:00:00Z", modifiedTime: "2026-03-16T10:00:00Z" },
    ];
    callToolImpl = createStandardCallTool(driveFiles);

    // Spy on startActiveSpan for the per-file span name. See the equivalent
    // test in email-watcher.integration.test.ts for the rationale — we assert
    // the code structure rather than real OTel trace_ids because bun + OTel
    // SDK interactions make real trace_id generation unreliable in tests.
    const { getTracer } = await import("../../lib/tracing");
    const realTracer = getTracer("gdrive-poller");
    const spanCalls: Array<{ name: string; options: any }> = [];
    const orig = realTracer.startActiveSpan.bind(realTracer);
    (realTracer as any).startActiveSpan = function (
      name: string,
      optionsOrFn: any,
      ctxOrFn?: any,
      fn?: any,
    ) {
      if (name === "gdrive-poller.process_file") {
        spanCalls.push({ name, options: optionsOrFn });
      }
      return orig(name, optionsOrFn, ctxOrFn, fn);
    };

    try {
      await pollCycle(db, wfDb);

      expect(spanCalls).toHaveLength(2);
      for (const call of spanCalls) {
        expect(call.options.root).toBe(true);
      }
      expect(spanCalls[0].options.attributes["gdrive.file_id"]).toBe("trace-file-1");
      expect(spanCalls[0].options.attributes["gdrive.filename"]).toBe("invoice_a.pdf");
      expect(spanCalls[1].options.attributes["gdrive.file_id"]).toBe("trace-file-2");
    } finally {
      (realTracer as any).startActiveSpan = orig;
    }
  });

  // -------------------------------------------------------------------------
  // pollCycle: skip already-seen files
  // -------------------------------------------------------------------------
  test("pollCycle skips already-seen files", async () => {
    // Pre-insert a file into the DB
    insertFile(db, {
      id: "file-existing",
      filename: "already_seen.pdf",
      mime_type: "application/pdf",
      created_at: "2026-03-20T10:00:00Z",
      watch_folder: PRIMARY_WATCH,
    });

    const driveFile = {
      id: "file-existing",
      name: "already_seen.pdf",
      mimeType: "application/pdf",
      createdTime: "2026-03-20T10:00:00Z",
      modifiedTime: "2026-03-20T10:00:00Z",
    };

    callToolImpl = createStandardCallTool([driveFile]);
    const channel = createMockChannel();

    await pollCycle(db, wfDb);

    // No job created — file was already known
    expect(channel.notification).toHaveBeenCalledTimes(0);
    const job = getJobByIdempotencyKey(wfDb, "gdrive:file-existing");
    expect(job).toBeNull();
  });

  // -------------------------------------------------------------------------
  // pollCycle: handles MCP error gracefully
  // -------------------------------------------------------------------------
  test("pollCycle handles MCP error gracefully", async () => {
    // Make callTool throw on list_drive_items
    callToolImpl = async (params) => {
      const { name, arguments: args } = params;
      if (name === "search_drive_files") {
        const query = args.query as string;
        if (query.includes(`name = '${PRIMARY_L1}'`) && !query.includes("in parents")) {
          return jsonArrayResult([{ id: "techlab-folder-id", name: PRIMARY_L1 }]);
        }
        if (query.includes(`name = '${PRIMARY_L2}'`) && query.includes("'techlab-folder-id' in parents")) {
          return jsonArrayResult([{ id: "invoicing-folder-id", name: PRIMARY_L2 }]);
        }
        if (query.includes("name = 'processed'") || query.includes("name = 'errors'")) {
          return jsonArrayResult([{ id: "sub", name: "sub" }]);
        }
      }
      if (name === "list_drive_items") {
        throw new Error("MCP connection lost");
      }
      return { content: [] };
    };

    const channel = createMockChannel();

    // Should not throw — error is caught internally
    await pollCycle(db, wfDb);

    // No notifications since poll returned empty due to error
    expect(channel.notification).toHaveBeenCalledTimes(0);
    // DB should have no files
    expect(getRecentFiles(db, { limit: 10 })).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // pollCycle: multiple files in one cycle
  // -------------------------------------------------------------------------
  test("pollCycle processes multiple files in one cycle", async () => {
    const files = [
      {
        id: "file-001",
        name: "invoice_jan.pdf",
        mimeType: "application/pdf",
        createdTime: "2026-01-15T10:00:00Z",
        modifiedTime: "2026-01-15T10:00:00Z",
      },
      {
        id: "file-002",
        name: "receipt_feb.jpg",
        mimeType: "image/jpeg",
        createdTime: "2026-02-20T11:30:00Z",
        modifiedTime: "2026-02-20T11:30:00Z",
      },
      {
        id: "file-003",
        name: "scan_march.pdf",
        mimeType: "application/pdf",
        createdTime: "2026-03-10T09:00:00Z",
        modifiedTime: "2026-03-10T09:00:00Z",
      },
    ];

    callToolImpl = createStandardCallTool(files);
    const channel = createMockChannel();

    await pollCycle(db, wfDb);

    // All three files inserted
    expect(fileExists(db, "file-001")).toBe(true);
    expect(fileExists(db, "file-002")).toBe(true);
    expect(fileExists(db, "file-003")).toBe(true);

    // No channel notifications — jobs created directly
    expect(channel.notification).toHaveBeenCalledTimes(0);

    // Three workflow jobs with correct month tags
    const job1 = getJobByIdempotencyKey(wfDb, "gdrive:file-001");
    const job2 = getJobByIdempotencyKey(wfDb, "gdrive:file-002");
    const job3 = getJobByIdempotencyKey(wfDb, "gdrive:file-003");
    expect(job1).not.toBeNull();
    expect(job2).not.toBeNull();
    expect(job3).not.toBeNull();
    expect(JSON.parse(job1!.input_json!).month_tag).toBe("2026-01");
    expect(JSON.parse(job2!.input_json!).month_tag).toBe("2026-02");
    expect(JSON.parse(job3!.input_json!).month_tag).toBe("2026-03");

    // Verify DB records
    const rows = getRecentFiles(db, { limit: 10 });
    expect(rows).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // pollCycle: mix of new and existing files
  // -------------------------------------------------------------------------
  test("pollCycle only creates jobs for new files in mixed batch", async () => {
    // Pre-insert one file
    insertFile(db, {
      id: "file-old",
      filename: "old_scan.pdf",
      mime_type: "application/pdf",
      created_at: "2026-03-01T08:00:00Z",
      watch_folder: PRIMARY_WATCH,
    });

    const driveFiles = [
      {
        id: "file-old",
        name: "old_scan.pdf",
        mimeType: "application/pdf",
        createdTime: "2026-03-01T08:00:00Z",
        modifiedTime: "2026-03-01T08:00:00Z",
      },
      {
        id: "file-new",
        name: "new_scan.pdf",
        mimeType: "application/pdf",
        createdTime: "2026-03-25T16:00:00Z",
        modifiedTime: "2026-03-25T16:00:00Z",
      },
    ];

    callToolImpl = createStandardCallTool(driveFiles);
    const channel = createMockChannel();

    await pollCycle(db, wfDb);

    // No channel notifications
    expect(channel.notification).toHaveBeenCalledTimes(0);

    // Only the new file gets a job
    const jobOld = getJobByIdempotencyKey(wfDb, "gdrive:file-old");
    const jobNew = getJobByIdempotencyKey(wfDb, "gdrive:file-new");
    expect(jobOld).toBeNull();
    expect(jobNew).not.toBeNull();
    expect(jobNew!.workflow_type).toBe("scan_intake");

    // Both exist in gdrive DB
    expect(fileExists(db, "file-old")).toBe(true);
    expect(fileExists(db, "file-new")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // pollCycle: caps new files per cycle (MAX_NEW_PER_CYCLE = 5)
  // -------------------------------------------------------------------------
  test("pollCycle caps new files at MAX_NEW_PER_CYCLE", async () => {
    // Create 7 files (exceeds default cap of 5)
    const files = Array.from({ length: 7 }, (_, i) => ({
      id: `file-cap-${i}`,
      name: `scan_${i}.pdf`,
      mimeType: "application/pdf",
      createdTime: `2026-03-${String(10 + i).padStart(2, "0")}T10:00:00Z`,
      modifiedTime: `2026-03-${String(10 + i).padStart(2, "0")}T10:00:00Z`,
    }));

    callToolImpl = createStandardCallTool(files);
    const channel = createMockChannel();

    await pollCycle(db, wfDb);

    // No channel notifications — jobs created directly
    expect(channel.notification).toHaveBeenCalledTimes(0);

    // Only 5 files in DB (capped) and 5 jobs created
    const rows = getRecentFiles(db, { limit: 20 });
    expect(rows).toHaveLength(5);

    // Verify exactly 5 jobs exist (first 5 files)
    let jobCount = 0;
    for (let i = 0; i < 7; i++) {
      const job = getJobByIdempotencyKey(wfDb, `gdrive:file-cap-${i}`);
      if (job) jobCount++;
    }
    expect(jobCount).toBe(5);
  });

  // -------------------------------------------------------------------------
  // pollCycle: empty folder (no files)
  // -------------------------------------------------------------------------
  test("pollCycle handles empty folder gracefully", async () => {
    callToolImpl = createStandardCallTool([]);
    const channel = createMockChannel();

    await pollCycle(db, wfDb);

    expect(channel.notification).toHaveBeenCalledTimes(0);
    expect(getRecentFiles(db, { limit: 10 })).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // pollCycle: text format response from Drive MCP
  // -------------------------------------------------------------------------
  test("pollCycle handles text format drive response", async () => {
    // Some MCP servers return human-readable text instead of JSON
    callToolImpl = async (params) => {
      const { name, arguments: args } = params;
      if (name === "search_drive_files") {
        const query = args.query as string;
        if (query.includes(`name = '${PRIMARY_L1}'`) && !query.includes("in parents")) {
          return textResult(`- Name: "${PRIMARY_L1}" (ID: techlab-folder-id, Type: application/vnd.google-apps.folder, Modified: 2026-01-01T00:00:00Z) Link: url`);
        }
        if (query.includes(`name = '${PRIMARY_L2}'`) && query.includes("'techlab-folder-id' in parents")) {
          return textResult(`- Name: "${PRIMARY_L2}" (ID: invoicing-folder-id, Type: application/vnd.google-apps.folder, Modified: 2026-01-01T00:00:00Z) Link: url`);
        }
        if (query.includes("name = 'processed'") || query.includes("name = 'errors'")) {
          return textResult('- Name: "processed" (ID: sub-id, Type: application/vnd.google-apps.folder, Modified: 2026-01-01T00:00:00Z) Link: url');
        }
      }
      if (name === "list_drive_items") {
        return textResult(
          '- Name: "text_format_scan.pdf" (ID: text-file-id, Type: application/pdf, Size: 54321, Modified: 2026-03-28T15:00:00Z) Link: https://drive.google.com/file/text-file-id'
        );
      }
      return { content: [] };
    };

    const channel = createMockChannel();

    await pollCycle(db, wfDb);

    expect(fileExists(db, "text-file-id")).toBe(true);
    // No channel notification — job created directly
    expect(channel.notification).toHaveBeenCalledTimes(0);

    // Job should exist with correct file metadata
    const job = getJobByIdempotencyKey(wfDb, "gdrive:text-file-id");
    expect(job).not.toBeNull();
    const input = JSON.parse(job!.input_json!);
    expect(input.file_id).toBe("text-file-id");
    expect(input.filename).toBe("text_format_scan.pdf");
  });

  // -------------------------------------------------------------------------
  // pollCycle: job input_json includes all expected fields
  // -------------------------------------------------------------------------
  test("job input_json includes all expected fields", async () => {
    const driveFile = {
      id: "file-detail-check",
      name: "detailed_scan.pdf",
      mimeType: "application/pdf",
      createdTime: "2026-06-15T08:45:00Z",
      modifiedTime: "2026-06-15T08:45:00Z",
    };

    callToolImpl = createStandardCallTool([driveFile]);
    const channel = createMockChannel();

    await pollCycle(db, wfDb);

    // No channel notification
    expect(channel.notification).toHaveBeenCalledTimes(0);

    // Verify job fields
    const job = getJobByIdempotencyKey(wfDb, "gdrive:file-detail-check");
    expect(job).not.toBeNull();
    expect(job!.workflow_type).toBe("scan_intake");
    expect(job!.state).toBe("queued");
    expect(job!.source_ref).toBe("gdrive:file-detail-check");
    expect(job!.idempotency_key).toBe("gdrive:file-detail-check");

    const input = JSON.parse(job!.input_json!);
    expect(input).toEqual({
      source: "gdrive",
      file_id: "file-detail-check",
      filename: "detailed_scan.pdf",
      month_tag: "2026-06",
      watch_folder: PRIMARY_WATCH,
      owner: PRIMARY_OWNER_ROLE,
      bucket: PRIMARY_BUCKET,
      folder_id: PRIMARY_FOLDER_ID,
    });
  });

  // -------------------------------------------------------------------------
  // backward-compat (GDRIVE_ROOT unset): job carries the resolved owner/bucket
  // -------------------------------------------------------------------------
  test("2-deep (no root): job carries owner role + bucket + folder_id", async () => {
    const driveFile = {
      id: "file-bc",
      name: "bc.pdf",
      mimeType: "application/pdf",
      createdTime: "2026-05-15T10:00:00Z",
      modifiedTime: "2026-05-15T10:00:00Z",
    };
    callToolImpl = createStandardCallTool([driveFile]);

    await pollCycle(db, wfDb);

    const job = getJobByIdempotencyKey(wfDb, "gdrive:file-bc");
    const input = JSON.parse(job!.input_json!);
    expect(input.owner).toBe(PRIMARY_OWNER_ROLE);
    expect(input.bucket).toBe(PRIMARY_BUCKET);
    expect(input.folder_id).toBe(PRIMARY_FOLDER_ID);
    expect(input.watch_folder).toBe(PRIMARY_WATCH);
  });

  // -------------------------------------------------------------------------
  // 3-deep resolution with GDRIVE_ROOT set (the nested-root path)
  // -------------------------------------------------------------------------
  test("3-deep with GDRIVE_ROOT: resolves root → owner → bucket, job carries role", async () => {
    process.env.GDRIVE_ROOT = "_documents_intake";
    process.env.GDRIVE_OWNERS = "techlab,personal";
    process.env.GDRIVE_BUCKETS = "accounting,documents";
    resetWatchFolders();
    resetDriveClient();

    // Root → owners under root → buckets under each owner. Returns one file
    // only from techlab/accounting so the assertion target is unambiguous.
    callToolImpl = async (params) => {
      const { name, arguments: args } = params;
      if (name === "search_drive_files") {
        const q = args.query as string;
        if (q.includes("name = '_documents_intake'") && !q.includes("in parents")) {
          return jsonArrayResult([{ id: "root-id", name: "_documents_intake" }]);
        }
        if (q.includes("name = 'techlab'") && q.includes("'root-id' in parents")) {
          return jsonArrayResult([{ id: "techlab-id", name: "techlab" }]);
        }
        if (q.includes("name = 'personal'") && q.includes("'root-id' in parents")) {
          return jsonArrayResult([{ id: "personal-id", name: "personal" }]);
        }
        if (q.includes("name = 'accounting'") && q.includes("'techlab-id' in parents")) {
          return jsonArrayResult([{ id: "techlab-acct-id", name: "accounting" }]);
        }
        if (q.includes("name = 'documents'") && q.includes("'techlab-id' in parents")) {
          return jsonArrayResult([{ id: "techlab-docs-id", name: "documents" }]);
        }
        if (q.includes("name = 'accounting'") && q.includes("'personal-id' in parents")) {
          return jsonArrayResult([{ id: "personal-acct-id", name: "accounting" }]);
        }
        if (q.includes("name = 'documents'") && q.includes("'personal-id' in parents")) {
          return jsonArrayResult([{ id: "personal-docs-id", name: "documents" }]);
        }
        if (q.includes("name = 'processed'") || q.includes("name = 'errors'")) {
          return jsonArrayResult([{ id: "sub", name: "sub" }]);
        }
        return textResult("No results");
      }
      if (name === "list_drive_items") {
        // Only the techlab/accounting bucket (id techlab-acct-id) yields a file.
        if (args.folder_id === "techlab-acct-id") {
          return jsonArrayResult([{
            id: "root-file-1", name: "nested.pdf", mimeType: "application/pdf",
            createdTime: "2026-05-15T10:00:00Z", modifiedTime: "2026-05-15T10:00:00Z",
          }]);
        }
        return textResult("No items found");
      }
      return { content: [] };
    };

    try {
      await pollCycle(db, wfDb);

      const job = getJobByIdempotencyKey(wfDb, "gdrive:root-file-1");
      expect(job).not.toBeNull();
      const input = JSON.parse(job!.input_json!);
      // techlab folder maps to the business ROLE; folder_id is the resolved
      // techlab/accounting bucket id (root excluded from the watch_folder label).
      expect(input.owner).toBe("business");
      expect(input.bucket).toBe("accounting");
      expect(input.folder_id).toBe("techlab-acct-id");
      expect(input.watch_folder).toBe("techlab/accounting");
    } finally {
      delete process.env.GDRIVE_ROOT;
      delete process.env.GDRIVE_OWNERS;
      delete process.env.GDRIVE_BUCKETS;
      resetWatchFolders();
      resetDriveClient();
    }
  });

  // -------------------------------------------------------------------------
  // pollCycle: DB record has correct fields after insert
  // -------------------------------------------------------------------------
  test("DB record has correct fields after pollCycle insert", async () => {
    const driveFile = {
      id: "file-db-check",
      name: "db_verify.pdf",
      mimeType: "application/pdf",
      createdTime: "2026-04-10T12:00:00Z",
      modifiedTime: "2026-04-10T12:00:00Z",
    };

    callToolImpl = createStandardCallTool([driveFile]);
    const channel = createMockChannel();

    await pollCycle(db, wfDb);

    const rows = getRecentFiles(db, { limit: 1 });
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.id).toBe("file-db-check");
    expect(row.filename).toBe("db_verify.pdf");
    expect(row.mime_type).toBe("application/pdf");
    expect(row.created_at).toBe("2026-04-10T12:00:00Z");
    expect(row.watch_folder).toBe(PRIMARY_WATCH);
  });

  // -------------------------------------------------------------------------
  // pollCycle: second poll cycle finds no new files
  // -------------------------------------------------------------------------
  test("second pollCycle does not re-create job for same files", async () => {
    const driveFile = {
      id: "file-once",
      name: "once_only.pdf",
      mimeType: "application/pdf",
      createdTime: "2026-03-25T10:00:00Z",
      modifiedTime: "2026-03-25T10:00:00Z",
    };

    callToolImpl = createStandardCallTool([driveFile]);
    const channel = createMockChannel();

    // First poll — should create job
    await pollCycle(db, wfDb);
    const job1 = getJobByIdempotencyKey(wfDb, "gdrive:file-once");
    expect(job1).not.toBeNull();

    // Reset watch folders cache (simulates fresh poll resolution)
    // but keep DB and drive client
    resetWatchFolders();

    // Second poll — same file still in Drive, should not create a new job
    await pollCycle(db, wfDb);

    // No channel notifications at all
    expect(channel.notification).toHaveBeenCalledTimes(0);

    // Job ID should be the same (no duplicate)
    const job2 = getJobByIdempotencyKey(wfDb, "gdrive:file-once");
    expect(job2!.id).toBe(job1!.id);
  });

  // -------------------------------------------------------------------------
  // pollCycle: folders that skip during resolution
  // -------------------------------------------------------------------------
  test("pollCycle skips folders that fail to resolve", async () => {
    // Level1 resolves but level2 returns no results
    callToolImpl = async (params) => {
      const { name, arguments: args } = params;
      if (name === "search_drive_files") {
        const query = args.query as string;
        if (query.includes(`name = '${PRIMARY_L1}'`) && !query.includes("in parents")) {
          return jsonArrayResult([{ id: "techlab-folder-id", name: PRIMARY_L1 }]);
        }
        // All level2 folders not found
        return textResult("No results found");
      }
      return { content: [] };
    };

    const channel = createMockChannel();

    // Should throw since no watch folders resolved
    try {
      await pollCycle(db, wfDb);
      // pollGdrive catches the error from resolveWatchFolders, so no throw
      // but no files or notifications
    } catch {
      // resolveWatchFolders throws if no folders resolved — that's caught by pollGdrive
    }

    // No notifications, no DB entries
    expect(channel.notification).toHaveBeenCalledTimes(0);
    expect(getRecentFiles(db, { limit: 10 })).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // pollCycle: idempotency — same file processed twice creates only one job
  // -------------------------------------------------------------------------
  test("idempotency: same file in two cycles creates only one job", async () => {
    const driveFile = {
      id: "file-idempotent",
      name: "idempotent_scan.pdf",
      mimeType: "application/pdf",
      createdTime: "2026-04-01T09:00:00Z",
      modifiedTime: "2026-04-01T09:00:00Z",
    };

    callToolImpl = createStandardCallTool([driveFile]);
    const channel = createMockChannel();

    // First poll — creates file in gdrive DB + job in workflow DB
    await pollCycle(db, wfDb);

    const job1 = getJobByIdempotencyKey(wfDb, "gdrive:file-idempotent");
    expect(job1).not.toBeNull();
    expect(job1!.workflow_type).toBe("scan_intake");

    // Manually remove file from gdrive DB to simulate a scenario where
    // the file appears as "new" again (e.g. DB corruption/reset)
    db.prepare("DELETE FROM gdrive_files WHERE id = ?").run("file-idempotent");
    expect(fileExists(db, "file-idempotent")).toBe(false);

    // Reset watch folders so pollGdrive re-resolves
    resetWatchFolders();

    // Second poll — file appears "new" again, but workflow DB idempotency
    // key prevents a duplicate job
    await pollCycle(db, wfDb);

    const job2 = getJobByIdempotencyKey(wfDb, "gdrive:file-idempotent");
    expect(job2).not.toBeNull();
    // Same job ID — not a new row
    expect(job2!.id).toBe(job1!.id);
  });

  // -------------------------------------------------------------------------
  // pollGdrive: returns files from Drive
  // -------------------------------------------------------------------------
  test("pollGdrive returns parsed files from Drive", async () => {
    const driveFiles = [
      {
        id: "poll-file-1",
        name: "poll_test.pdf",
        mimeType: "application/pdf",
        createdTime: "2026-03-20T10:00:00Z",
        modifiedTime: "2026-03-20T10:00:00Z",
      },
    ];

    callToolImpl = createStandardCallTool(driveFiles);

    const result = await pollGdrive();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("poll-file-1");
    expect(result[0].name).toBe("poll_test.pdf");
    expect(result[0].watchFolder).toBe(PRIMARY_WATCH);
  });

  // -------------------------------------------------------------------------
  // pollGdrive: filters out folder entries from JSON response
  // -------------------------------------------------------------------------
  test("pollGdrive filters out folder entries", async () => {
    const items = [
      {
        id: "folder-id",
        name: "processed",
        mimeType: "application/vnd.google-apps.folder",
        createdTime: "2026-03-01T00:00:00Z",
        modifiedTime: "2026-03-01T00:00:00Z",
      },
      {
        id: "real-file-id",
        name: "actual_scan.pdf",
        mimeType: "application/pdf",
        createdTime: "2026-03-25T14:00:00Z",
        modifiedTime: "2026-03-25T14:00:00Z",
      },
    ];

    callToolImpl = createStandardCallTool(items);

    const result = await pollGdrive();

    // Only the PDF, not the folder
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("real-file-id");
  });

  // -------------------------------------------------------------------------
  // pollGdrive: returns empty array on error
  // -------------------------------------------------------------------------
  test("pollGdrive returns empty array on error", async () => {
    // Need to reset so resolveWatchFolders runs fresh and can hit the error
    resetWatchFolders();
    resetDriveClient();

    callToolImpl = async () => {
      throw new Error("Network timeout");
    };

    const result = await pollGdrive();
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // unknown owner skip path (task 96 bug fix — ReferenceError on OWNER_BUSINESS_LABEL)
  //
  // resolveWatchFolders must skip an unrecognised owner folder with a log
  // message, NOT throw a ReferenceError that pollGdrive's catch swallows.
  // Concretely: when GDRIVE_OWNERS contains an unknown name alongside a valid
  // one, the poll cycle must (a) continue past the bad owner, (b) still
  // resolve the valid owner and return/create jobs for its files, and (c) emit
  // no job for the bad owner.
  // -------------------------------------------------------------------------
  test("pollCycle skips unknown owner folder and still processes valid owner", async () => {
    // Set GDRIVE_OWNERS to include one unknown name and the valid "techlab".
    process.env.GDRIVE_OWNERS = "bad-owner,techlab";
    process.env.GDRIVE_BUCKETS = "accounting";
    resetWatchFolders();
    resetDriveClient();

    const driveFile = {
      id: "file-valid-owner",
      name: "valid_owner_scan.pdf",
      mimeType: "application/pdf",
      createdTime: "2026-06-25T10:00:00Z",
      modifiedTime: "2026-06-25T10:00:00Z",
    };

    // Mock: "bad-owner" never reaches an MCP search (ownerFolderToRole returns
    // null first); "techlab" resolves normally.
    callToolImpl = async (params) => {
      const { name, arguments: args } = params;
      if (name === "search_drive_files") {
        const q = args.query as string;
        if (q.includes("name = 'techlab'") && !q.includes("in parents")) {
          return jsonArrayResult([{ id: "techlab-folder-id", name: "techlab" }]);
        }
        if (q.includes("name = 'accounting'") && q.includes("'techlab-folder-id' in parents")) {
          return jsonArrayResult([{ id: "techlab-acct-id", name: "accounting" }]);
        }
        if (q.includes("name = 'processed'") || q.includes("name = 'errors'")) {
          return jsonArrayResult([{ id: "sub", name: "sub" }]);
        }
        return textResult("No results");
      }
      if (name === "list_drive_items" && args.folder_id === "techlab-acct-id") {
        return jsonArrayResult([driveFile]);
      }
      return textResult("No items found");
    };

    try {
      // (b) poll cycle must NOT throw — if OWNER_BUSINESS_LABEL were still
      // referenced, the ReferenceError would propagate through resolveWatchFolders,
      // be caught by pollGdrive, and return [], causing pollCycle to create zero jobs.
      await pollCycle(db, wfDb);

      // (b) valid owner's file was still processed
      const job = getJobByIdempotencyKey(wfDb, "gdrive:file-valid-owner");
      expect(job).not.toBeNull();
      expect(job!.workflow_type).toBe("scan_intake");
      const input = JSON.parse(job!.input_json!);
      expect(input.owner).toBe("business");
      expect(input.bucket).toBe("accounting");
      expect(input.watch_folder).toBe("techlab/accounting");

      // (c) no job for bad-owner (its folder was never searched)
      const rows = (wfDb as any).prepare("SELECT id FROM jobs").all() as any[];
      expect(rows).toHaveLength(1); // exactly one job — for the valid owner file
    } finally {
      delete process.env.GDRIVE_OWNERS;
      delete process.env.GDRIVE_BUCKETS;
      resetWatchFolders();
      resetDriveClient();
    }
  });
});
