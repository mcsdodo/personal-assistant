import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { executeInvoiceIntake, type InvoiceIntakeInput } from "./invoice-worker";
import { PaperlessFieldRegistry } from "./paperless-fields";
import {
  createJob,
  getJob,
  getJobEvents,
  openWorkflowDb,
  type JobRow,
} from "./workflow-db";

// ── Test helpers ───────────────────────────────────────────────────────

let tmpDir: string;
let db: Database;
let registry: PaperlessFieldRegistry;

const logger = { log(_msg: string) {} };

/** Build a minimal valid InvoiceIntakeInput */
function makeInput(overrides: Partial<InvoiceIntakeInput> = {}): InvoiceIntakeInput {
  return {
    email_source: "outlook",
    message_id: "msg-123",
    classification: {
      is_invoice: true,
      confidence: "high",
      vendor: "Alza",
      doc_type: "invoice",
      is_fuel: false,
      suggested_tags: ["invoicing", "2026-03"],
      action: "download_and_upload",
      download_strategy: "attachment",
      strategy_confidence: "high",
      requires_review: false,
      order_id: "FA2026030001",
      total_amount: 59.99,
      currency: "EUR",
    },
    subject: "Your invoice FA2026030001",
    sender: "invoices@alza.sk",
    received_at: "2026-03-27T10:00:00Z",
    ...overrides,
  };
}

/** Create a job with the given input and claim it (set state=running) */
function createRunningJob(input: InvoiceIntakeInput): JobRow {
  const job = createJob(db, {
    workflowType: "invoice_intake",
    inputJson: JSON.stringify(input),
    sourceRef: `${input.email_source}:${input.message_id}`,
    idempotencyKey: `${input.email_source}:${input.message_id}`,
  });
  // Simulate claim (worker normally does this via claimNextQueuedJob)
  db.prepare("UPDATE jobs SET state = 'running', started_at = datetime('now') WHERE id = ?").run(
    job.id,
  );
  return getJob(db, job.id)!;
}

/** JSON-RPC response wrapper */
function rpcResponse(result: unknown) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(result) }],
    },
  };
}

// ── Timer mock (instant setTimeout for setDocumentCustomFields polling) ──

const originalSetTimeout = globalThis.setTimeout;

// ── Fetch mock infrastructure ──────────────────────────────────────────

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;
let fetchHandlers: FetchHandler[];
const originalFetch = globalThis.fetch;

function mockFetch(...handlers: FetchHandler[]) {
  fetchHandlers = [...handlers];
  let callIndex = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // Find the right handler — use sequential call order
    if (callIndex < fetchHandlers.length) {
      return fetchHandlers[callIndex++](url, init!);
    }
    throw new Error(`Unexpected fetch call #${callIndex}: ${url}`);
  }) as typeof fetch;
}

/** Mock handlers for setDocumentCustomFields: task poll → PATCH → verify GET */
function customFieldsMockHandlers(docId = 999): FetchHandler[] {
  return [
    // task poll → SUCCESS
    () => jsonResponse([{ status: "SUCCESS", result: `Success. New document id ${docId} created` }]),
    // PATCH custom fields → OK
    () => jsonResponse({ id: docId, custom_fields: [] }),
    // verify GET → OK
    () => jsonResponse({ id: docId, custom_fields: [{ field: 1, value: 59.99 }] }),
  ];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Setup / Teardown ───────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "invoice-worker-test-"));
  db = openWorkflowDb(join(tmpDir, "workflow.db"));
  fetchHandlers = [];

  // Make setTimeout resolve instantly so setDocumentCustomFields polling doesn't timeout
  globalThis.setTimeout = ((fn: Function, _ms?: number, ...args: unknown[]) => {
    fn(...args);
    return 0 as any;
  }) as typeof setTimeout;

  // Create a pre-populated registry for tests
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      count: 2,
      next: null,
      results: [
        { id: 1, name: "total_amount", data_type: "float" },
        { id: 4, name: "order_id", data_type: "string" },
      ],
    }),
  })) as any;
  registry = new PaperlessFieldRegistry("https://test", "tok");
  await registry.init();
  globalThis.fetch = origFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  db.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("invoice-worker approval gates", () => {
  test("pauses for browser_required strategy", async () => {
    const input = makeInput({
      classification: {
        ...makeInput().classification,
        download_strategy: "browser_required",
      },
    });
    const job = createRunningJob(input);

    await executeInvoiceIntake(db, job, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("awaiting_approval");
    const events = getJobEvents(db, job.id);
    expect(events.some((e) => e.event_type === "approval_requested")).toBe(true);
  });

  test("pauses for manual_review strategy", async () => {
    const input = makeInput({
      classification: {
        ...makeInput().classification,
        download_strategy: "manual_review",
      },
    });
    const job = createRunningJob(input);

    await executeInvoiceIntake(db, job, logger, registry);

    expect(getJob(db, job.id)!.state).toBe("awaiting_approval");
  });

  test("pauses for unknown vendor", async () => {
    const input = makeInput({
      classification: {
        ...makeInput().classification,
        vendor: "unknown",
      },
    });
    const job = createRunningJob(input);

    await executeInvoiceIntake(db, job, logger, registry);

    expect(getJob(db, job.id)!.state).toBe("awaiting_approval");
  });

  test("pauses for low confidence", async () => {
    const input = makeInput({
      classification: {
        ...makeInput().classification,
        confidence: "low",
      },
    });
    const job = createRunningJob(input);

    await executeInvoiceIntake(db, job, logger, registry);

    expect(getJob(db, job.id)!.state).toBe("awaiting_approval");
  });

  test("pauses for requires_review flag", async () => {
    const input = makeInput({
      classification: {
        ...makeInput().classification,
        requires_review: true,
      },
    });
    const job = createRunningJob(input);

    await executeInvoiceIntake(db, job, logger, registry);

    expect(getJob(db, job.id)!.state).toBe("awaiting_approval");
  });

  test("skips unknown vendor gate if already approved", async () => {
    const input = makeInput({
      classification: {
        ...makeInput().classification,
        vendor: "unknown",
        confidence: "high",
        requires_review: false,
      },
    });
    const job = createRunningJob(input);
    // Simulate prior approval
    db.prepare("UPDATE jobs SET approved_by = 'tester' WHERE id = ?").run(job.id);
    const approvedJob = getJob(db, job.id)!;

    // Mock the fetch calls for download path
    // Even with unknown vendor, after approval it should try to download
    mockFetch(
      // get_attachments
      () => jsonResponse(rpcResponse([{ id: "att-1", name: "invoice.pdf", content_type: "application/pdf", size: 1024 }])),
      // download_attachment
      () =>
        jsonResponse(
          rpcResponse({ name: "invoice.pdf", content_type: "application/pdf", size: 1024, content_base64: "AAAA" }),
        ),
      // list_correspondents (resolve correspondent)
      () => jsonResponse(rpcResponse([])),
      // create_correspondent
      () => jsonResponse(rpcResponse({ id: 99, name: "unknown" })),
      // search_documents (dedup — order_id is FA2026030001 from makeInput)
      () => jsonResponse(rpcResponse([])),
      // list_tags (resolve tags)
      () => jsonResponse(rpcResponse([{ id: 1, name: "invoicing" }])),
      // create_tag for "2026-03"
      () => jsonResponse(rpcResponse({ id: 2 })),
      // list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      // post_document
      () => jsonResponse(rpcResponse({ id: 42 })),
      // setDocumentCustomFields: task poll, PATCH, verify
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, approvedJob, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
  });
});

describe("invoice-worker attachment download + upload", () => {
  test("full happy path: attachment download, no duplicate, upload", async () => {
    const input = makeInput();
    const job = createRunningJob(input);

    mockFetch(
      // 1. get_attachments (outlook)
      () =>
        jsonResponse(
          rpcResponse([
            { id: "att-1", name: "invoice.pdf", content_type: "application/pdf", size: 2048 },
          ]),
        ),
      // 2. download_attachment
      () =>
        jsonResponse(
          rpcResponse({
            name: "invoice.pdf",
            content_type: "application/pdf",
            size: 2048,
            content_base64: "JVBER",
          }),
        ),
      // 3. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 4. search_documents (dedup check)
      () => jsonResponse(rpcResponse([])),
      // 5. list_tags
      () =>
        jsonResponse(rpcResponse([{ id: 1, name: "invoicing" }, { id: 7, name: "2026-03" }])),
      // 6. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      // 7. post_document
      () => jsonResponse(rpcResponse({ id: 42 })),
      // 8-10. setDocumentCustomFields: task poll, PATCH, verify
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
    expect(output.title).toBe("Alza - FA2026030001");
    // paperless_document_id is undefined: uploadToPaperless returns a task_uuid,
    // not a document ID. The doc ID is resolved later by setDocumentCustomFields.
    expect(output.paperless_document_id).toBeUndefined();
    expect(output.correspondent).toBe("Alza");
    expect(output.tags).toEqual(["invoicing", "2026-03"]);

    // Verify events were recorded
    const events = getJobEvents(db, job.id);
    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toContain("step_started");
    expect(eventTypes).toContain("step_completed");
    expect(eventTypes).toContain("completed");
  });

  test("detects exact duplicate and completes without upload", async () => {
    const input = makeInput();
    const job = createRunningJob(input);

    mockFetch(
      // 1. get_attachments
      () =>
        jsonResponse(
          rpcResponse([{ id: "att-1", name: "inv.pdf", content_type: "application/pdf", size: 512 }]),
        ),
      // 2. download_attachment
      () =>
        jsonResponse(
          rpcResponse({ name: "inv.pdf", content_type: "application/pdf", size: 512, content_base64: "AA" }),
        ),
      // 3. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 4. search_documents → returns a match with same order_id
      () =>
        jsonResponse(
          rpcResponse([
            {
              id: 77,
              title: "Alza - FA2026030001",
              custom_fields: { order_id: "FA2026030001", total_amount: 59.99 },
            },
          ]),
        ),
    );

    await executeInvoiceIntake(db, job, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("duplicate");
    expect(output.duplicate_of).toBe(77);
  });

  test("detects likely duplicate (amount differs) and pauses", async () => {
    const input = makeInput();
    const job = createRunningJob(input);

    mockFetch(
      // 1. get_attachments
      () =>
        jsonResponse(
          rpcResponse([{ id: "att-1", name: "inv.pdf", content_type: "application/pdf", size: 512 }]),
        ),
      // 2. download_attachment
      () =>
        jsonResponse(
          rpcResponse({ name: "inv.pdf", content_type: "application/pdf", size: 512, content_base64: "AA" }),
        ),
      // 3. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 4. search_documents → match but different amount
      () =>
        jsonResponse(
          rpcResponse([
            {
              id: 77,
              title: "Alza - FA2026030001",
              custom_fields: { order_id: "FA2026030001", total_amount: 100.0 },
            },
          ]),
        ),
    );

    await executeInvoiceIntake(db, job, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("awaiting_approval");
  });

  test("creates new correspondent when not found", async () => {
    const input = makeInput({
      classification: {
        ...makeInput().classification,
        vendor: "NewVendor",
        order_id: null, // skip dedup
      },
    });
    const job = createRunningJob(input);

    mockFetch(
      // 1. get_attachments
      () =>
        jsonResponse(
          rpcResponse([{ id: "att-1", name: "doc.pdf", content_type: "application/pdf", size: 256 }]),
        ),
      // 2. download_attachment
      () =>
        jsonResponse(
          rpcResponse({ name: "doc.pdf", content_type: "application/pdf", size: 256, content_base64: "BB" }),
        ),
      // 3. list_correspondents → no match
      () => jsonResponse(rpcResponse([{ id: 1, name: "Alza" }, { id: 2, name: "Orange" }])),
      // 4. create_correspondent
      () => jsonResponse(rpcResponse({ id: 50, name: "NewVendor" })),
      // 5. list_tags
      () => jsonResponse(rpcResponse([{ id: 1, name: "invoicing" }])),
      // 6. create_tag for "2026-03"
      () => jsonResponse(rpcResponse({ id: 88 })),
      // 7. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      // 8. post_document
      () => jsonResponse(rpcResponse({ id: 55 })),
      // 9-11. setDocumentCustomFields: task poll, PATCH, verify
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
    expect(output.correspondent).toBe("NewVendor");
  });

  test("skips dedup when no order_id", async () => {
    const input = makeInput({
      classification: {
        ...makeInput().classification,
        order_id: null,
      },
    });
    const job = createRunningJob(input);

    mockFetch(
      // 1. get_attachments
      () =>
        jsonResponse(
          rpcResponse([{ id: "att-1", name: "inv.pdf", content_type: "application/pdf", size: 100 }]),
        ),
      // 2. download_attachment
      () =>
        jsonResponse(
          rpcResponse({ name: "inv.pdf", content_type: "application/pdf", size: 100, content_base64: "CC" }),
        ),
      // 3. list_correspondents → match
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // NO dedup call — order_id is null
      // 4. list_tags
      () => jsonResponse(rpcResponse([{ id: 1, name: "invoicing" }, { id: 7, name: "2026-03" }])),
      // 5. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      // 6. post_document
      () => jsonResponse(rpcResponse({ id: 60 })),
      // 7-9. setDocumentCustomFields: task poll, PATCH, verify (total_amount is set)
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
    // Title uses subject when no order_id
    expect(output.title).toBe("Alza - Your invoice FA2026030001");
  });
});

describe("invoice-worker link download", () => {
  test("downloads via extract_invoice_links + download_invoice_link for outlook", async () => {
    const input = makeInput({
      classification: {
        ...makeInput().classification,
        download_strategy: "known_link",
        order_id: null,
      },
    });
    const job = createRunningJob(input);

    mockFetch(
      // 1. extract_invoice_links
      () =>
        jsonResponse(
          rpcResponse([
            { url: "https://example.com/invoice.pdf", text: "Download Invoice", doc_id: "INV-1" },
          ]),
        ),
      // 2. download_invoice_link
      () =>
        jsonResponse(
          rpcResponse({
            filename: "invoice.pdf",
            content_type: "application/pdf",
            size: 4096,
            content_base64: "JVBER",
          }),
        ),
      // 3. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 4. list_tags
      () => jsonResponse(rpcResponse([{ id: 1, name: "invoicing" }, { id: 7, name: "2026-03" }])),
      // 5. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      // 6. post_document
      () => jsonResponse(rpcResponse({ id: 70 })),
      // 7-9. setDocumentCustomFields: task poll, PATCH, verify (total_amount is set)
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
  });

  test("fails when link download returns error", async () => {
    const input = makeInput({
      classification: {
        ...makeInput().classification,
        download_strategy: "known_link",
        order_id: null,
      },
    });
    const job = createRunningJob(input);

    mockFetch(
      // 1. extract_invoice_links
      () =>
        jsonResponse(
          rpcResponse([{ url: "https://example.com/expired-link", text: "Download" }]),
        ),
      // 2. download_invoice_link → returns error
      () =>
        jsonResponse(
          rpcResponse({
            filename: "",
            content_type: "",
            size: 0,
            content_base64: "",
            error: "Link expired",
            status_code: 403,
          }),
        ),
    );

    await executeInvoiceIntake(db, job, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("failed");
    expect(updated.error_json).toContain("Link expired");
  });
});

describe("invoice-worker error handling", () => {
  test("fails gracefully when no attachments found", async () => {
    const input = makeInput();
    const job = createRunningJob(input);

    mockFetch(
      // get_attachments → empty
      () => jsonResponse(rpcResponse([])),
    );

    await executeInvoiceIntake(db, job, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("failed");
    expect(updated.error_json).toContain("No attachments found");
  });

  test("fails with invalid input_json", async () => {
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: "not-valid-json{{{",
    });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    const runningJob = getJob(db, job.id)!;

    // parseJobJson will throw on invalid JSON, which gets caught
    await executeInvoiceIntake(db, runningJob, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("failed");
  });

  test("fails when MCP server returns HTTP error", async () => {
    const input = makeInput();
    const job = createRunningJob(input);

    mockFetch(
      // get_attachments → 500
      () => jsonResponse({ error: "Internal server error" }, 500),
    );

    await executeInvoiceIntake(db, job, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("failed");
    expect(updated.error_json).toContain("500");
  });

  test("fails for unsupported email source in link download", async () => {
    const input = makeInput({
      email_source: "gmail",
      classification: {
        ...makeInput().classification,
        download_strategy: "known_link",
      },
    });
    const job = createRunningJob(input);

    await executeInvoiceIntake(db, job, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("failed");
    expect(updated.error_json).toContain("not yet supported");
  });
});

describe("invoice-worker title building", () => {
  test("uses vendor + order_id when available", async () => {
    const input = makeInput();
    const job = createRunningJob(input);

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "a1", name: "invoice.pdf", content_type: "application/pdf", size: 100 }])),
      () => jsonResponse(rpcResponse({ name: "invoice.pdf", content_type: "application/pdf", size: 100, content_base64: "X" })),
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      () => jsonResponse(rpcResponse([])), // no duplicate
      () => jsonResponse(rpcResponse([{ id: 1, name: "invoicing" }, { id: 7, name: "2026-03" }])),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      () => jsonResponse(rpcResponse({ id: 1 })),
      // setDocumentCustomFields: task poll, PATCH, verify
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    expect(output.title).toBe("Alza - FA2026030001");
  });

  test("uses vendor + subject when no order_id", async () => {
    const input = makeInput({
      classification: { ...makeInput().classification, order_id: null },
      subject: "Fwd: Monthly billing statement",
    });
    const job = createRunningJob(input);

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "a1", name: "bill.pdf", content_type: "application/pdf", size: 100 }])),
      () => jsonResponse(rpcResponse({ name: "bill.pdf", content_type: "application/pdf", size: 100, content_base64: "X" })),
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // no dedup (no order_id)
      () => jsonResponse(rpcResponse([{ id: 1, name: "invoicing" }, { id: 7, name: "2026-03" }])),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      () => jsonResponse(rpcResponse({ id: 1 })),
      // setDocumentCustomFields: task poll, PATCH, verify (total_amount is set)
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    // Subject has "Fwd:" stripped
    expect(output.title).toBe("Alza - Monthly billing statement");
  });
});
