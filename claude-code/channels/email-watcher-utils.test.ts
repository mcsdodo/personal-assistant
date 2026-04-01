import { beforeAll, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — registered BEFORE the dynamic import of email-watcher so
// top-level side effects (Server creation, main(), db open) don't crash.
// ---------------------------------------------------------------------------

// MCP SDK — Server constructor + transport
mock.module("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler() {}
    connect() { return Promise.resolve(); }
    notification() { return Promise.resolve(); }
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
  StreamableHTTPClientTransport: class {},
}));

// db module — prevent SQLite file access
mock.module("./db", () => ({
  openDb: () => ({ query: () => ({ get: () => ({}) }) }),
  insertEmail: () => {},
  emailExists: () => false,
  getLastChecked: () => null,
  setLastChecked: () => {},
  updateEmail: () => {},
  getRecentEmails: () => [],
  getEmailStats: () => ({ byStatus: [], last24h: [] }),
}));

// invoice-links — prevent any real import side effects
mock.module("./invoice-links", () => ({
  extractInvoiceLinks: () => [],
}));

// Dynamic import — the mocks above MUST be registered before this runs.
let buildGmailQuery: any;
let parseDuration: any;
let esc: any;
let metricLine: any;
let parseToolResult: any;
let extractGmailIds: any;
let parseGmailEmails: any;

beforeAll(async () => {
  const mod = await import("./email-watcher");
  buildGmailQuery = mod.buildGmailQuery;
  parseDuration = mod.parseDuration;
  esc = mod.esc;
  metricLine = mod.metricLine;
  parseToolResult = mod.parseToolResult;
  extractGmailIds = mod.extractGmailIds;
  parseGmailEmails = mod.parseGmailEmails;
});

// ---------------------------------------------------------------------------
// buildGmailQuery
// ---------------------------------------------------------------------------
// NOTE: buildGmailQuery uses the module-level GMAIL_SEARCH_BASE constant
// which defaults to "" in the test environment (no env vars set).
// We test with that empty-string base.

describe("buildGmailQuery", () => {
  test("returns empty string when no lastChecked and no base", () => {
    expect(buildGmailQuery(null)).toBe("");
  });

  test("returns after:epoch when lastChecked is provided", () => {
    const ts = "2026-03-15T12:00:00Z";
    const epoch = Math.floor(new Date(ts).getTime() / 1000);
    expect(buildGmailQuery(ts)).toBe(`after:${epoch}`);
  });

  test("epoch is correct for a known timestamp", () => {
    // 2026-01-01T00:00:00Z = 1767225600
    const result = buildGmailQuery("2026-01-01T00:00:00Z");
    expect(result).toBe("after:1767225600");
  });
});

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe("parseDuration", () => {
  test("parses hours", () => {
    expect(parseDuration("3h")).toBe(3 * 60 * 60 * 1000);
  });

  test("parses days", () => {
    expect(parseDuration("2d")).toBe(2 * 24 * 60 * 60 * 1000);
  });

  test("parses weeks", () => {
    expect(parseDuration("1w")).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("parses months (30 days)", () => {
    expect(parseDuration("2m")).toBe(2 * 30 * 24 * 60 * 60 * 1000);
  });

  test("is case-insensitive", () => {
    expect(parseDuration("5H")).toBe(5 * 60 * 60 * 1000);
    expect(parseDuration("1D")).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration("2W")).toBe(2 * 7 * 24 * 60 * 60 * 1000);
    expect(parseDuration("1M")).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("returns 24h default for invalid input", () => {
    const oneDay = 24 * 60 * 60 * 1000;
    expect(parseDuration("")).toBe(oneDay);
    expect(parseDuration("abc")).toBe(oneDay);
    expect(parseDuration("10x")).toBe(oneDay);
    expect(parseDuration("h")).toBe(oneDay);       // no digits
    expect(parseDuration("3.5h")).toBe(oneDay);    // non-integer
  });

  test("allows whitespace between number and unit", () => {
    // The regex is /^(\d+)\s*(h|d|w|m)$/i — \s* allows spaces
    expect(parseDuration("3 h")).toBe(3 * 60 * 60 * 1000);
    expect(parseDuration("2  d")).toBe(2 * 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// esc
// ---------------------------------------------------------------------------

describe("esc", () => {
  test("returns empty string for null", () => {
    expect(esc(null)).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(esc(undefined)).toBe("");
  });

  test("returns plain string unchanged", () => {
    expect(esc("hello")).toBe("hello");
  });

  test("escapes backslashes", () => {
    expect(esc("a\\b")).toBe("a\\\\b");
  });

  test("escapes newlines", () => {
    expect(esc("line1\nline2")).toBe("line1\\nline2");
  });

  test("escapes double quotes", () => {
    expect(esc('say "hi"')).toBe('say \\"hi\\"');
  });

  test("escapes all special characters together", () => {
    expect(esc('a\\b\n"c"')).toBe('a\\\\b\\n\\"c\\"');
  });

  test("converts non-string values to string via String()", () => {
    // null/undefined handled above; empty string stays empty
    expect(esc("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// metricLine
// ---------------------------------------------------------------------------

describe("metricLine", () => {
  test("renders metric with labels", () => {
    expect(metricLine("my_metric", { source: "gmail" }, 42)).toBe(
      'my_metric{source="gmail"} 42',
    );
  });

  test("renders metric with multiple labels", () => {
    const result = metricLine("m", { source: "outlook", status: "new" }, 10);
    expect(result).toBe('m{source="outlook",status="new"} 10');
  });

  test("renders metric without labels when all are empty/null/undefined", () => {
    expect(metricLine("m", { a: null, b: undefined, c: "" }, 5)).toBe("m 5");
  });

  test("filters out null/undefined/empty labels", () => {
    const result = metricLine("m", { keep: "yes", drop: null, also_drop: "" }, 1);
    expect(result).toBe('m{keep="yes"} 1');
  });

  test("escapes label values using esc()", () => {
    const result = metricLine("m", { label: 'has"quote' }, 1);
    expect(result).toBe('m{label="has\\"quote"} 1');
  });

  test("renders metric with no labels object entries", () => {
    expect(metricLine("m", {}, 99)).toBe("m 99");
  });

  test("handles zero value", () => {
    expect(metricLine("m", { a: "b" }, 0)).toBe('m{a="b"} 0');
  });
});

// ---------------------------------------------------------------------------
// parseToolResult
// ---------------------------------------------------------------------------

describe("parseToolResult", () => {
  test("returns null for null/undefined result", () => {
    expect(parseToolResult(null)).toBeNull();
    expect(parseToolResult(undefined)).toBeNull();
  });

  test("returns null when content is missing", () => {
    expect(parseToolResult({})).toBeNull();
    expect(parseToolResult({ content: null })).toBeNull();
  });

  test("returns null when no text blocks present", () => {
    expect(parseToolResult({ content: [] })).toBeNull();
    expect(
      parseToolResult({ content: [{ type: "image", data: "..." }] }),
    ).toBeNull();
  });

  test("parses single JSON text block", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: '{"id": 1, "name": "test"}' }],
    });
    expect(result).toEqual({ id: 1, name: "test" });
  });

  test("returns raw text when single block is not valid JSON", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: "just plain text" }],
    });
    expect(result).toBe("just plain text");
  });

  test("parses multiple JSON text blocks into array", () => {
    const result = parseToolResult({
      content: [
        { type: "text", text: '{"id": 1}' },
        { type: "text", text: '{"id": 2}' },
      ],
    });
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("mixed blocks: parseable JSON and plain text", () => {
    const result = parseToolResult({
      content: [
        { type: "text", text: '{"id": 1}' },
        { type: "text", text: "not json" },
      ],
    });
    expect(result).toEqual([{ id: 1 }, "not json"]);
  });

  test("ignores non-text blocks", () => {
    const result = parseToolResult({
      content: [
        { type: "image", data: "..." },
        { type: "text", text: '{"ok": true}' },
      ],
    });
    expect(result).toEqual({ ok: true });
  });

  test("ignores text blocks where text is not a string", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: 123 }],
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractGmailIds
// ---------------------------------------------------------------------------

describe("extractGmailIds", () => {
  test("extracts from array of strings", () => {
    expect(extractGmailIds(["abc123", "def456"])).toEqual(["abc123", "def456"]);
  });

  test("extracts from array of objects with id field", () => {
    expect(extractGmailIds([{ id: "a1" }, { id: "b2" }])).toEqual([
      "a1",
      "b2",
    ]);
  });

  test("returns empty array for empty array", () => {
    expect(extractGmailIds([])).toEqual([]);
  });

  test("extracts from object with messages array", () => {
    const data = { messages: [{ id: "m1" }, { id: "m2" }] };
    expect(extractGmailIds(data)).toEqual(["m1", "m2"]);
  });

  test("extracts from object with messageIds array", () => {
    const data = { messageIds: ["id1", "id2"] };
    expect(extractGmailIds(data)).toEqual(["id1", "id2"]);
  });

  test("extracts single id from object with id field", () => {
    expect(extractGmailIds({ id: "solo" })).toEqual(["solo"]);
  });

  test("extracts hex IDs from raw text", () => {
    const text =
      "Found messages: 18f1a2b3c4d5e6f7 and 19a0b1c2d3e4f5a6 done.";
    const result = extractGmailIds(text);
    expect(result).toEqual(["18f1a2b3c4d5e6f7", "19a0b1c2d3e4f5a6"]);
  });

  test("returns empty array for text with no hex IDs", () => {
    expect(extractGmailIds("no ids here")).toEqual([]);
  });

  test("returns empty array for non-matching types", () => {
    expect(extractGmailIds(42)).toEqual([]);
    expect(extractGmailIds(true)).toEqual([]);
  });

  test("converts id to string in object array", () => {
    const result = extractGmailIds([{ id: 12345 }]);
    expect(result).toEqual(["12345"]);
  });

  test("converts single object id to string", () => {
    expect(extractGmailIds({ id: 999 })).toEqual(["999"]);
  });

  test("handles messages key recursively with string array", () => {
    const data = { messages: ["id1", "id2"] };
    expect(extractGmailIds(data)).toEqual(["id1", "id2"]);
  });
});

// ---------------------------------------------------------------------------
// parseGmailEmails
// ---------------------------------------------------------------------------

describe("parseGmailEmails", () => {
  test("parses array of email objects", () => {
    const data = [
      {
        id: "msg1",
        from: "alice@example.com",
        to: "bob@example.com",
        subject: "Hello",
        snippet: "Hi there",
        hasAttachments: true,
        date: "2026-03-01T10:00:00Z",
      },
    ];
    const result = parseGmailEmails(data, ["msg1"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "msg1",
      source: "gmail",
      sender: "alice@example.com",
      to: "bob@example.com",
      subject: "Hello",
      preview: "Hi there",
      hasAttachments: true,
      receivedAt: "2026-03-01T10:00:00Z",
    });
  });

  test("handles alternative field names", () => {
    const data = [
      {
        messageId: "msg2",
        sender: "sender@test.com",
        toAddress: "recip@test.com",
        subject: "Alt",
        preview: "Preview text",
        has_attachments: true,
        received_at: "2026-01-01",
      },
    ];
    const result = parseGmailEmails(data, []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg2");
    expect(result[0].sender).toBe("sender@test.com");
    expect(result[0].to).toBe("recip@test.com");
    expect(result[0].preview).toBe("Preview text");
    expect(result[0].hasAttachments).toBe(true);
    expect(result[0].receivedAt).toBe("2026-01-01");
  });

  test("handles message_id field name", () => {
    const data = [{ message_id: "msg3", subject: "Test" }];
    const result = parseGmailEmails(data, []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg3");
  });

  test("skips objects without any id field", () => {
    const data = [{ subject: "No ID" }, { id: "has-id", subject: "With ID" }];
    const result = parseGmailEmails(data, []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("has-id");
  });

  test("body is truncated to 200 chars for preview", () => {
    const longBody = "A".repeat(300);
    const data = [{ id: "m1", body: longBody }];
    const result = parseGmailEmails(data, []);
    expect(result[0].preview).toBe("A".repeat(200));
  });

  test("parses formatted text with Message ID blocks", () => {
    const text = [
      "Message ID: abc123",
      "From: Alice <alice@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Test Subject",
      "Date: Mon, 1 Mar 2026 10:00:00 +0000",
      "",
      "Message ID: def456",
      "From: charlie@example.com",
      "Subject: Another",
      "Date: Tue, 2 Mar 2026",
    ].join("\n");

    const result = parseGmailEmails(text, []);
    expect(result).toHaveLength(2);

    expect(result[0].id).toBe("abc123");
    expect(result[0].sender).toBe("alice@example.com");
    expect(result[0].to).toBe("bob@example.com");
    expect(result[0].subject).toBe("Test Subject");
    expect(result[0].receivedAt).toBe("Mon, 1 Mar 2026 10:00:00 +0000");
    expect(result[0].source).toBe("gmail");
    expect(result[0].hasAttachments).toBe(false);

    expect(result[1].id).toBe("def456");
    expect(result[1].sender).toBe("charlie@example.com");
    expect(result[1].to).toBeUndefined();
    expect(result[1].subject).toBe("Another");
  });

  test("formatted text: From without angle brackets uses raw value", () => {
    const text = [
      "Message ID: x1",
      "From: plain@example.com",
      "Subject: Plain from",
    ].join("\n");
    const result = parseGmailEmails(text, []);
    expect(result[0].sender).toBe("plain@example.com");
  });

  test("formatted text: To without angle brackets uses raw value", () => {
    const text = [
      "Message ID: x2",
      "From: a@b.com",
      "To: plain@dest.com",
      "Subject: Test",
    ].join("\n");
    const result = parseGmailEmails(text, []);
    expect(result[0].to).toBe("plain@dest.com");
  });

  test("returns empty array for unrecognized data format", () => {
    expect(parseGmailEmails(42, [])).toEqual([]);
    expect(parseGmailEmails(null, [])).toEqual([]);
    expect(parseGmailEmails("no message id blocks", [])).toEqual([]);
  });

  test("returns empty array for array of non-objects", () => {
    expect(parseGmailEmails([1, 2, 3], [])).toEqual([]);
  });

  test("returns empty array for array of null", () => {
    expect(parseGmailEmails([null, null], [])).toEqual([]);
  });

  test("hasAttachments defaults to false for JSON objects", () => {
    const data = [{ id: "m1", subject: "No attach info" }];
    const result = parseGmailEmails(data, []);
    expect(result[0].hasAttachments).toBe(false);
  });

  test("uses fromAddress when from is missing", () => {
    const data = [{ id: "m1", fromAddress: "fa@test.com" }];
    const result = parseGmailEmails(data, []);
    expect(result[0].sender).toBe("fa@test.com");
  });

  test("uses recipient when to/toAddress are missing", () => {
    const data = [{ id: "m1", recipient: "rec@test.com" }];
    const result = parseGmailEmails(data, []);
    expect(result[0].to).toBe("rec@test.com");
  });

  test("uses internalDate when other date fields missing", () => {
    const data = [{ id: "m1", internalDate: "1709292000" }];
    const result = parseGmailEmails(data, []);
    expect(result[0].receivedAt).toBe("1709292000");
  });
});
