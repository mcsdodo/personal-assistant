import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock MCP SDK modules to prevent side effects from gdrive-watcher.ts module
// initialization (Server creation, main() calling openDb on non-existent path)
// ---------------------------------------------------------------------------

mock.module("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    connect() { return Promise.resolve(); }
    notification() { return Promise.resolve(); }
    setRequestHandler() {}
  },
}));

mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

mock.module("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: Symbol("ListToolsRequestSchema"),
  CallToolRequestSchema: Symbol("CallToolRequestSchema"),
}));

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect() { return Promise.resolve(); }
    callTool() { return Promise.resolve({ content: [] }); }
  },
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor() {}
  },
}));

// ---------------------------------------------------------------------------
// Now import test utilities and the functions under test
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { openDb, insertFile } from "./gdrive-db";
import {
  parseToolResult,
  extractFolderId,
  parseDriveTextOutput,
  renderMetrics,
} from "./gdrive-watcher";

// ---------------------------------------------------------------------------
// parseToolResult
// ---------------------------------------------------------------------------
describe("parseToolResult", () => {
  test("returns null for null/undefined input", () => {
    expect(parseToolResult(null)).toBeNull();
    expect(parseToolResult(undefined)).toBeNull();
  });

  test("returns null when content is missing", () => {
    expect(parseToolResult({})).toBeNull();
    expect(parseToolResult({ content: [] })).toBeNull();
  });

  test("returns null when no text blocks exist", () => {
    expect(
      parseToolResult({
        content: [{ type: "image", data: "abc" }],
      })
    ).toBeNull();
  });

  test("parses single JSON text block", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: '{"id":"abc","name":"test.pdf"}' }],
    });
    expect(result).toEqual({ id: "abc", name: "test.pdf" });
  });

  test("returns raw text for single non-JSON block", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: "plain text response" }],
    });
    expect(result).toBe("plain text response");
  });

  test("parses multiple JSON text blocks into array (FastMCP list)", () => {
    const result = parseToolResult({
      content: [
        { type: "text", text: '{"id":"f1","name":"a.pdf"}' },
        { type: "text", text: '{"id":"f2","name":"b.pdf"}' },
      ],
    });
    expect(result).toEqual([
      { id: "f1", name: "a.pdf" },
      { id: "f2", name: "b.pdf" },
    ]);
  });

  test("handles mixed JSON and non-JSON in multi-block result", () => {
    const result = parseToolResult({
      content: [
        { type: "text", text: '{"id":"f1"}' },
        { type: "text", text: "not json" },
      ],
    });
    expect(result).toEqual([{ id: "f1" }, "not json"]);
  });

  test("ignores non-text blocks among text blocks", () => {
    const result = parseToolResult({
      content: [
        { type: "image", data: "ignored" },
        { type: "text", text: '{"id":"only-text"}' },
      ],
    });
    expect(result).toEqual({ id: "only-text" });
  });

  test("handles text block where text is not a string", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: 42 }],
    });
    // text is not a string, so it's filtered out -> returns null
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractFolderId
// ---------------------------------------------------------------------------
describe("extractFolderId", () => {
  test("returns undefined for null/undefined/false", () => {
    expect(extractFolderId(null)).toBeUndefined();
    expect(extractFolderId(undefined)).toBeUndefined();
    expect(extractFolderId(false)).toBeUndefined();
    expect(extractFolderId(0)).toBeUndefined();
    expect(extractFolderId("")).toBeUndefined();
  });

  // --- Array of objects branch ---
  test("extracts id from array of objects", () => {
    expect(extractFolderId([{ id: "folder-123" }])).toBe("folder-123");
  });

  test("extracts fileId from array when id is missing", () => {
    expect(extractFolderId([{ fileId: "folder-456" }])).toBe("folder-456");
  });

  test("prefers id over fileId in array", () => {
    expect(extractFolderId([{ id: "id-val", fileId: "fid-val" }])).toBe(
      "id-val"
    );
  });

  test("uses first element from array", () => {
    expect(
      extractFolderId([{ id: "first" }, { id: "second" }])
    ).toBe("first");
  });

  test("returns undefined for empty array", () => {
    expect(extractFolderId([])).toBeUndefined();
  });

  // --- String with "ID:" pattern branch ---
  test("extracts folder ID from text with ID: pattern", () => {
    expect(
      extractFolderId('Name: "techlab" (ID: abc123, Type: folder)')
    ).toBe("abc123");
  });

  test("handles ID: with trailing space", () => {
    expect(extractFolderId("ID: xyz789 ")).toBe("xyz789");
  });

  test("handles ID: with comma delimiter", () => {
    expect(extractFolderId("ID: folder-id, Type: folder")).toBe("folder-id");
  });

  test("handles ID: with closing paren delimiter", () => {
    expect(extractFolderId("ID: folder-id)")).toBe("folder-id");
  });

  test("returns undefined for string without ID: pattern", () => {
    expect(extractFolderId("no id here")).toBeUndefined();
  });

  // --- Direct object branch ---
  test("extracts id from a direct object", () => {
    expect(extractFolderId({ id: "direct-id" })).toBe("direct-id");
  });

  test("extracts fileId from a direct object when id is missing", () => {
    expect(extractFolderId({ fileId: "direct-fid" })).toBe("direct-fid");
  });

  test("returns undefined for object without id or fileId", () => {
    expect(extractFolderId({ name: "test" })).toBeUndefined();
  });

  // --- Edge: number passes falsy check but isn't handled ---
  test("returns undefined for non-zero number (no id/fileId property)", () => {
    // Numbers are truthy but typeof !== "string" and not array, not plain object with id
    expect(extractFolderId(42)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseDriveTextOutput
// ---------------------------------------------------------------------------
describe("parseDriveTextOutput", () => {
  const folder = "techlab/invoicing";

  test("parses a single file line", () => {
    const text =
      '- Name: "invoice.pdf" (ID: abc123, Type: application/pdf, Size: 12345, Modified: 2026-03-20T10:00:00Z) Link: https://drive.google.com/file/abc123';
    const files = parseDriveTextOutput(text, folder);
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({
      id: "abc123",
      name: "invoice.pdf",
      mimeType: "application/pdf",
      createdTime: "2026-03-20T10:00:00Z",
      modifiedTime: "2026-03-20T10:00:00Z",
      watchFolder: folder,
    });
  });

  test("parses multiple file lines", () => {
    const text = [
      '- Name: "scan1.pdf" (ID: id1, Type: application/pdf, Size: 100, Modified: 2026-03-20T10:00:00Z) Link: url1',
      '- Name: "scan2.jpg" (ID: id2, Type: image/jpeg, Size: 200, Modified: 2026-03-21T11:00:00Z) Link: url2',
    ].join("\n");
    const files = parseDriveTextOutput(text, folder);
    expect(files).toHaveLength(2);
    expect(files[0].id).toBe("id1");
    expect(files[0].name).toBe("scan1.pdf");
    expect(files[1].id).toBe("id2");
    expect(files[1].mimeType).toBe("image/jpeg");
  });

  test("skips folder entries", () => {
    const text = [
      '- Name: "processed" (ID: fld1, Type: application/vnd.google-apps.folder, Size: 0, Modified: 2026-03-20T10:00:00Z) Link: url1',
      '- Name: "invoice.pdf" (ID: file1, Type: application/pdf, Size: 500, Modified: 2026-03-20T11:00:00Z) Link: url2',
    ].join("\n");
    const files = parseDriveTextOutput(text, folder);
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe("file1");
  });

  test("handles lines without Size field", () => {
    const text =
      '- Name: "doc.pdf" (ID: id-nosize, Type: application/pdf, Modified: 2026-03-22T09:30:00Z) Link: url';
    const files = parseDriveTextOutput(text, folder);
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe("id-nosize");
    expect(files[0].name).toBe("doc.pdf");
  });

  test("returns empty array for empty input", () => {
    expect(parseDriveTextOutput("", folder)).toEqual([]);
  });

  test("returns empty array for text with no matching lines", () => {
    expect(
      parseDriveTextOutput("Some random text\nNo files here", folder)
    ).toEqual([]);
  });

  test("trims whitespace from parsed fields", () => {
    const text =
      '- Name: "  spaced.pdf  " (ID:  id-spaced , Type:  application/pdf , Size: 100, Modified:  2026-03-20T10:00:00Z ) Link: url';
    const files = parseDriveTextOutput(text, folder);
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe("id-spaced");
    expect(files[0].mimeType).toBe("application/pdf");
    expect(files[0].modifiedTime).toBe("2026-03-20T10:00:00Z");
  });

  test("uses createdTime = modifiedTime (both set from Modified field)", () => {
    const text =
      '- Name: "test.pdf" (ID: id1, Type: application/pdf, Size: 10, Modified: 2026-01-15T08:00:00Z) Link: url';
    const files = parseDriveTextOutput(text, folder);
    expect(files[0].createdTime).toBe(files[0].modifiedTime);
    expect(files[0].createdTime).toBe("2026-01-15T08:00:00Z");
  });

  test("passes watchFolder through to all files", () => {
    const text = [
      '- Name: "a.pdf" (ID: a1, Type: application/pdf, Size: 10, Modified: 2026-01-01T00:00:00Z) Link: u',
      '- Name: "b.pdf" (ID: b1, Type: application/pdf, Size: 20, Modified: 2026-01-02T00:00:00Z) Link: u',
    ].join("\n");
    const customFolder = "business/receipts";
    const files = parseDriveTextOutput(text, customFolder);
    expect(files).toHaveLength(2);
    expect(files[0].watchFolder).toBe(customFolder);
    expect(files[1].watchFolder).toBe(customFolder);
  });

  test("name is taken from inside quotes (not trimmed of quotes)", () => {
    const text =
      '- Name: "scan_20260325_tankovanie.pdf" (ID: x1, Type: application/pdf, Size: 50, Modified: 2026-03-25T12:00:00Z) Link: u';
    const files = parseDriveTextOutput(text, folder);
    expect(files[0].name).toBe("scan_20260325_tankovanie.pdf");
  });
});

// ---------------------------------------------------------------------------
// renderMetrics
// ---------------------------------------------------------------------------
describe("renderMetrics", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gdrive-watcher-test-"));
    db = openDb(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // On Windows, WAL files may still be locked briefly after close
    }
  });

  test("returns metrics for empty database", () => {
    const output = renderMetrics(db);
    expect(output).toContain("# HELP gdrive_watcher_files_total");
    expect(output).toContain("# TYPE gdrive_watcher_files_total gauge");
    expect(output).toContain("# HELP gdrive_watcher_last_poll_seconds_ago");
    expect(output).toContain("# TYPE gdrive_watcher_last_poll_seconds_ago gauge");
    expect(output).toContain("gdrive_watcher_last_poll_seconds_ago ");
    // No status lines when empty
    expect(output).not.toContain('gdrive_watcher_files_total{status=');
  });

  test("includes file counts by status", () => {
    insertFile(db, {
      id: "f1",
      filename: "a.pdf",
      mime_type: "application/pdf",
      created_at: "2026-03-20T10:00:00Z",
      watch_folder: "techlab/invoicing",
      status: "new",
    });
    insertFile(db, {
      id: "f2",
      filename: "b.pdf",
      mime_type: "application/pdf",
      created_at: "2026-03-20T11:00:00Z",
      watch_folder: "techlab/invoicing",
      status: "new",
    });
    insertFile(db, {
      id: "f3",
      filename: "c.pdf",
      mime_type: "application/pdf",
      created_at: "2026-03-20T12:00:00Z",
      watch_folder: "techlab/invoicing",
      status: "completed",
    });

    const output = renderMetrics(db);
    expect(output).toContain('gdrive_watcher_files_total{status="new"} 2');
    expect(output).toContain('gdrive_watcher_files_total{status="completed"} 1');
  });

  test("includes poll staleness metric", () => {
    const output = renderMetrics(db);
    // Should have the metric line with a numeric value
    const match = output.match(
      /gdrive_watcher_last_poll_seconds_ago (\d+)/
    );
    expect(match).toBeTruthy();
    // Value should be small since lastSuccessfulPollAt is set to Date.now() at module load
    const seconds = parseInt(match![1], 10);
    expect(seconds).toBeLessThan(60);
  });

  test("output ends with a trailing newline", () => {
    const output = renderMetrics(db);
    expect(output.endsWith("\n")).toBe(true);
  });

  test("output is valid Prometheus exposition format", () => {
    insertFile(db, {
      id: "f1",
      filename: "test.pdf",
      mime_type: "application/pdf",
      created_at: "2026-03-20T10:00:00Z",
      watch_folder: "techlab/invoicing",
      status: "processing",
    });

    const output = renderMetrics(db);
    const lines = output.split("\n").filter((l) => l.length > 0);

    for (const line of lines) {
      // Each line should be a comment (# HELP/TYPE) or a metric line
      const isComment = line.startsWith("#");
      const isMetric = /^[a-z_]+(\{[^}]*\})?\s+\d+/.test(line);
      expect(isComment || isMetric).toBe(true);
    }
  });
});
