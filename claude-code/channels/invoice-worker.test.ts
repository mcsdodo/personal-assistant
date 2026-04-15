import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { executeInvoiceIntake, executeScanIntake, type InvoiceIntakeInput, type InvoiceClassification, type ScanIntakeInput, type ScanClassification } from "./invoice/intake-worker";
import { PaperlessFieldRegistry } from "./paperless-fields";
import type { NotifyFn } from "./telegram-notify";
import {
  addJobEvent,
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
let notifyCalls: string[];
const notify: NotifyFn = async (msg) => { notifyCalls.push(msg); };

/** Build a minimal valid InvoiceIntakeInput (V2: only source + message_id) */
function makeInput(overrides: Partial<InvoiceIntakeInput> = {}): InvoiceIntakeInput {
  return {
    email_source: "outlook",
    message_id: "msg-123",
    ...overrides,
  };
}

/** Default email classification result (what Claude returns via submit_classification) */
function defaultEmailClassification(overrides: Partial<InvoiceClassification> = {}): InvoiceClassification {
  return {
    is_invoice: true,
    confidence: "high",
    vendor: "Alza",
    doc_type: "invoice",
    is_fuel: false,
    owner: "techlab",
    action: "download_and_upload",
    download_strategy: "attachment",
    strategy_confidence: "high",
    requires_review: false,
    order_id: "FA2026030001",
    subtitle: null,
    total_amount: 59.99,
    currency: "EUR",
    sender: "noreply@alza.sk",
    subject: "Your invoice FA2026030001",
    received_at: "2026-03-27T10:00:00Z",
    ...overrides,
  };
}

/** Default doc classification result.
 *  This is the shape passed to seedClassificationSteps which writes raw events,
 *  bypassing submitClassification validation. Existing tests rely on these
 *  exact fields (and absence of order_id/etc.) to exercise specific merge
 *  paths in invoice-pipeline.mergeClassifications. Do NOT add extra defaults
 *  here without understanding the test impact. */
function defaultDocClassification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vendor: "Alza",
    total_amount: 59.99,
    owner: "techlab",
    doc_type: "invoice",
    doc_date: "2026-03-25",
    ...overrides,
  };
}

/** Create a job with the given input and claim it (set state=running).
 *  Seeds classify_email and classify_document step_completed events to simulate
 *  the channel roundtrip that happens in production. */
function createRunningJob(
  input: InvoiceIntakeInput,
  emailClass?: InvoiceClassification,
  docClass?: Record<string, unknown>,
): JobRow {
  const job = createJob(db, {
    workflowType: "invoice_intake",
    inputJson: JSON.stringify(input),
    sourceRef: `${input.email_source}:${input.message_id}`,
    idempotencyKey: `${input.email_source}:${input.message_id}`,
  });
  // Simulate claim — started_at must use the same ISO 8601 format nowIso() writes
  // in production (workflow-db.ts claimNextQueuedJob). Schema-default datetime('now')
  // emits space format and can hide format-mismatch comparison bugs. See CLAUDE.md
  // "Test fixtures must match production writers".
  db.prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    job.id,
  );
  // Seed classification steps (production path: channel roundtrip completed)
  addJobEvent(db, job.id, "step_completed", {
    step: "classify_email",
    result: emailClass ?? defaultEmailClassification(),
  });
  addJobEvent(db, job.id, "step_completed", {
    step: "classify_document",
    result: docClass ?? defaultDocClassification(),
  });
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

/** Mock handler for resolveStoragePath: GET /api/storage_paths/ */
function storagePathsMockHandler(): FetchHandler {
  return () => jsonResponse({ results: [
    { id: 2, name: "Techlab Invoices" },
    { id: 3, name: "Techlab Documents" },
    { id: 4, name: "Personal Invoices" },
    { id: 5, name: "Personal Documents" },
  ]});
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
  process.env.DOWNLOAD_DIR = join(tmpDir, "downloads");
  fetchHandlers = [];
  notifyCalls = [];

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

describe("invoice-worker approval gates (removed)", () => {
  test("unknown vendor proceeds without pausing", async () => {
    const input = makeInput();
    const job = createRunningJob(
      input,
      defaultEmailClassification({ vendor: "unknown" }),
      defaultDocClassification({ vendor: "unknown" }),
    );

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "att-1", name: "invoice.pdf", content_type: "application/pdf", size: 1024 }])),
      () => jsonResponse(rpcResponse({ name: "invoice.pdf", content_type: "application/pdf", size: 1024, content_base64: "AAAA" })),
      () => jsonResponse(rpcResponse([])),
      () => jsonResponse(rpcResponse({ id: 99, name: "unknown" })),
      // dedup check (direct Paperless API)
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([{ id: 11, name: "accounting" }])),
      () => jsonResponse(rpcResponse({ id: 2 })),
      () => jsonResponse(rpcResponse({ id: 3 })),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid"', { status: 200 }),
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    expect(getJob(db, job.id)!.state).toBe("completed");
  });

  test("low confidence proceeds without pausing", async () => {
    const input = makeInput();
    const job = createRunningJob(input, defaultEmailClassification({ confidence: "low" }));

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "att-1", name: "inv.pdf", content_type: "application/pdf", size: 100 }])),
      () => jsonResponse(rpcResponse({ name: "inv.pdf", content_type: "application/pdf", size: 100, content_base64: "AA" })),
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // dedup check (direct Paperless API)
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([{ id: 11, name: "accounting" }])),
      () => jsonResponse(rpcResponse({ id: 2 })),
      () => jsonResponse(rpcResponse({ id: 3 })),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid"', { status: 200 }),
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    expect(getJob(db, job.id)!.state).toBe("completed");
  });

  test("duplicate_likely still pauses (only remaining gate)", async () => {
    const input = makeInput();
    const job = createRunningJob(input);

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "att-1", name: "inv.pdf", content_type: "application/pdf", size: 512 }])),
      () => jsonResponse(rpcResponse({ name: "inv.pdf", content_type: "application/pdf", size: 512, content_base64: "AA" })),
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // dedup check (direct Paperless API) — duplicate with different amount
      () => jsonResponse({ results: [{
        id: 77,
        title: "Alza - FA2026030001",
        custom_fields: [{ field: 4, value: "FA2026030001" }, { field: 1, value: 100.0 }],
      }] }),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    expect(getJob(db, job.id)!.state).toBe("awaiting_approval");
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
      // 4. dedup check (direct Paperless API)
      () => jsonResponse({ results: [] }),
      // 5. list_tags (derived: ["techlab", "accounting", "2026-03"])
      () =>
        jsonResponse(rpcResponse([{ id: 3, name: "techlab" }, { id: 11, name: "accounting" }, { id: 7, name: "2026-03" }])),
      // 6. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      // 7. resolveStoragePath: GET /api/storage_paths/
      storagePathsMockHandler(),
      // 8. post_document
      () => new Response('"task-uuid"', { status: 200 }),
      // 9-11. setDocumentCustomFields: task poll, PATCH, verify
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
    expect(output.title).toBe("Alza - FA2026030001");
    // paperless_document_id is undefined: uploadToPaperless returns a task_uuid,
    // not a document ID. The doc ID is resolved later by setDocumentCustomFields.
    expect(output.paperless_document_id).toBeUndefined();
    expect(output.correspondent).toBe("Alza");
    expect(output.tags).toEqual(["techlab", "accounting", "2026-03"]);

    // Verify events were recorded
    const events = getJobEvents(db, job.id);
    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toContain("step_started");
    expect(eventTypes).toContain("step_completed");
    expect(eventTypes).toContain("completed");
  });

  // Regression: Outlook downloadAttachment used to return `parsed.size` (the
  // attachment-list metadata size) instead of `dlParsed.size` (the actual
  // downloaded payload). The two diverge in real life because Outlook reports
  // the raw size in the list response and the base64-decoded size in the
  // download response. Verify the worker records the *download* size in the
  // download step_completed event, not the metadata size.
  test("Outlook downloadAttachment records actual download size, not metadata size", async () => {
    const input = makeInput({ email_source: "outlook", message_id: "msg-size-bug" });
    const job = createRunningJob(input);

    const METADATA_SIZE = 9999; // wrong number — must NOT appear in the recorded event
    const ACTUAL_SIZE = 1234;   // correct number — must appear in the recorded event

    mockFetch(
      // 1. get_attachments — list response carries METADATA_SIZE
      () =>
        jsonResponse(
          rpcResponse([
            { id: "att-1", name: "invoice.pdf", content_type: "application/pdf", size: METADATA_SIZE },
          ]),
        ),
      // 2. download_attachment — download response carries ACTUAL_SIZE
      () =>
        jsonResponse(
          rpcResponse({
            name: "invoice.pdf",
            content_type: "application/pdf",
            size: ACTUAL_SIZE,
            content_base64: "JVBER",
          }),
        ),
      // 3. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 4. dedup
      () => jsonResponse({ results: [] }),
      // 5. list_tags
      () => jsonResponse(rpcResponse([{ id: 3, name: "techlab" }, { id: 11, name: "accounting" }, { id: 7, name: "2026-03" }])),
      // 6. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      // 7. resolveStoragePath
      storagePathsMockHandler(),
      // 8. post_document
      () => new Response('"task-uuid"', { status: 200 }),
      // 9-11. setDocumentCustomFields
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    expect(getJob(db, job.id)!.state).toBe("completed");

    const events = getJobEvents(db, job.id);
    const downloadCompleted = events.find((e) => {
      if (e.event_type !== "step_completed") return false;
      const payload = JSON.parse(e.payload_json ?? "{}");
      return payload.step === "download";
    });
    expect(downloadCompleted).toBeDefined();
    const recorded = JSON.parse(downloadCompleted!.payload_json ?? "{}");
    expect(recorded.size).toBe(ACTUAL_SIZE);
    expect(recorded.size).not.toBe(METADATA_SIZE);
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
      // 4. dedup check (direct Paperless API) → exact duplicate
      () => jsonResponse({ results: [{
        id: 77,
        title: "Alza - FA2026030001",
        custom_fields: [{ field: 4, value: "FA2026030001" }, { field: 1, value: 59.99 }],
      }] }),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

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
      // 4. dedup check (direct Paperless API) → match but different amount
      () => jsonResponse({ results: [{
        id: 77,
        title: "Alza - FA2026030001",
        custom_fields: [{ field: 4, value: "FA2026030001" }, { field: 1, value: 100.0 }],
      }] }),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("awaiting_approval");
  });

  test("creates new correspondent when not found", async () => {
    const input = makeInput();
    const job = createRunningJob(
      input,
      defaultEmailClassification({ vendor: "NewVendor", order_id: null }),
      defaultDocClassification({ vendor: "NewVendor" }),
    );

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
      // NO dedup (order_id is null)
      // 5. list_tags (derived: ["techlab", "accounting", "2026-03"])
      () => jsonResponse(rpcResponse([{ id: 11, name: "accounting" }])),
      // 6. create_tag for "techlab"
      () => jsonResponse(rpcResponse({ id: 88 })),
      // 6b. create_tag for "2026-03" (month derived from doc_date)
      () => jsonResponse(rpcResponse({ id: 89 })),
      // 7. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      // 8. resolveStoragePath
      storagePathsMockHandler(),
      // 9. post_document
      () => new Response('"task-uuid"', { status: 200 }),
      // 10-12. setDocumentCustomFields: task poll, PATCH, verify
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
    expect(output.correspondent).toBe("NewVendor");
  });

  test("skips dedup when no order_id", async () => {
    const input = makeInput();
    const job = createRunningJob(input, defaultEmailClassification({ order_id: null }));

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
      // 4. list_tags (derived: ["techlab", "accounting", "2026-03"])
      () => jsonResponse(rpcResponse([{ id: 11, name: "accounting" }])),
      // 5. create_tag for "techlab"
      () => jsonResponse(rpcResponse({ id: 2 })),
      // 5b. create_tag for "2026-03"
      () => jsonResponse(rpcResponse({ id: 3 })),
      // 6. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      // 7. resolveStoragePath
      storagePathsMockHandler(),
      // 8. post_document
      () => new Response('"task-uuid"', { status: 200 }),
      // 9-11. setDocumentCustomFields: task poll, PATCH, verify (total_amount is set)
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
    // Title uses subject when no order_id
    expect(output.title).toBe("Alza - Your invoice FA2026030001");
  });
});

describe("invoice-worker link download", () => {
  test("downloads via get_email HTML extraction + direct fetch for outlook", async () => {
    const input = makeInput();
    const job = createRunningJob(input, defaultEmailClassification({ download_strategy: "known_link", order_id: null }));

    mockFetch(
      // 1. get_email → returns HTML body with extractable invoice link
      () =>
        jsonResponse(
          rpcResponse({
            body_html: '<a href="https://example.com/invoice.pdf">Stiahnuť faktúru</a>',
          }),
        ),
      // 2. direct fetch of extracted URL → PDF content
      () =>
        new Response(Buffer.from("%PDF-fake"), {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="invoice.pdf"',
          },
        }),
      // 3. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // NO dedup (order_id is null)
      // 4. list_tags (derived: ["techlab", "accounting", "2026-03"])
      () => jsonResponse(rpcResponse([{ id: 11, name: "accounting" }])),
      // 5. create_tag for "techlab"
      () => jsonResponse(rpcResponse({ id: 2 })),
      // 5b. create_tag for "2026-03"
      () => jsonResponse(rpcResponse({ id: 3 })),
      // 6. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      // 7. resolveStoragePath
      storagePathsMockHandler(),
      // 8. post_document
      () => new Response('"task-uuid"', { status: 200 }),
      // 9-11. setDocumentCustomFields: task poll, PATCH, verify
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
  });

  test("fails when link download returns 403 (expired)", async () => {
    const input = makeInput();
    const job = createRunningJob(input, defaultEmailClassification({ download_strategy: "known_link", order_id: null }));

    mockFetch(
      // 1. get_email → HTML with extractable link
      () =>
        jsonResponse(
          rpcResponse({
            body_html: '<a href="https://example.com/expired-link">Stiahnuť faktúru</a>',
          }),
        ),
      // 2. direct fetch → 403 (first attempt)
      () => new Response("Forbidden", { status: 403 }),
      // 3. retry with browser headers → still 403
      () => new Response("Forbidden", { status: 403 }),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("retryable");
    expect(updated.error_json).toContain("Link may have expired");
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

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("retryable");
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
    await executeInvoiceIntake(db, runningJob, logger, registry, notify);

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

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("retryable");
    expect(updated.error_json).toContain("500");
  });

  test("browser_required strategy pauses for manual intervention", async () => {
    const input = makeInput();
    const job = createRunningJob(input, defaultEmailClassification({ download_strategy: "browser_required" as any }));

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("awaiting_approval");
  });

  test("unsupported download strategy fails", async () => {
    const input = makeInput();
    const job = createRunningJob(input, defaultEmailClassification({ download_strategy: "nonexistent" as any }));

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "a1", name: "invoice.pdf", content_type: "application/pdf", size: 100 }])),
      () => jsonResponse(rpcResponse({ name: "invoice.pdf", content_type: "application/pdf", size: 100, content_base64: "X" })),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("retryable");
    expect(updated.error_json).toContain("Unsupported download strategy");
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
      // dedup check (direct Paperless API)
      () => jsonResponse({ results: [] }),
      // list_tags (derived: ["techlab", "accounting", "2026-03"])
      () => jsonResponse(rpcResponse([{ id: 11, name: "accounting" }])),
      // create_tag for "techlab"
      () => jsonResponse(rpcResponse({ id: 2 })),
      // create_tag for "2026-03"
      () => jsonResponse(rpcResponse({ id: 3 })),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid"', { status: 200 }),
      // setDocumentCustomFields: task poll, PATCH, verify
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    expect(output.title).toBe("Alza - FA2026030001");
  });

  test("uses vendor + subject when no order_id", async () => {
    const input = makeInput();
    const job = createRunningJob(input, defaultEmailClassification({ order_id: null, subject: "Fwd: Monthly billing statement" }));

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "a1", name: "bill.pdf", content_type: "application/pdf", size: 100 }])),
      () => jsonResponse(rpcResponse({ name: "bill.pdf", content_type: "application/pdf", size: 100, content_base64: "X" })),
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // no dedup (no order_id)
      // list_tags (derived: ["techlab", "accounting", "2026-03"])
      () => jsonResponse(rpcResponse([{ id: 11, name: "accounting" }])),
      // create_tag for "techlab"
      () => jsonResponse(rpcResponse({ id: 2 })),
      // create_tag for "2026-03"
      () => jsonResponse(rpcResponse({ id: 3 })),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid"', { status: 200 }),
      // setDocumentCustomFields: task poll, PATCH, verify (total_amount is set)
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    // Subject has "Fwd:" stripped
    expect(output.title).toBe("Alza - Monthly billing statement");
  });
});

describe("invoice-worker file_path from disk", () => {
  test("reads file from disk when file_path is present and file exists", async () => {
    const filePath = join(tmpDir, "test-invoice.pdf");
    writeFileSync(filePath, Buffer.from("JVBER-fake-pdf"));

    const input = makeInput({ file_path: filePath });
    const job = createRunningJob(input);

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // dedup check (direct Paperless API)
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([{ id: 11, name: "accounting" }])),
      () => jsonResponse(rpcResponse({ id: 2 })),
      () => jsonResponse(rpcResponse({ id: 3 })),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid-123"', { status: 200 }),
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    expect(JSON.parse(updated.output_json!).outcome).toBe("uploaded");
  });

  test("falls back to MCP download when file_path is missing", async () => {
    const input = makeInput();
    const job = createRunningJob(input);

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "att-1", name: "invoice.pdf", content_type: "application/pdf", size: 2048 }])),
      () => jsonResponse(rpcResponse({ name: "invoice.pdf", content_type: "application/pdf", size: 2048, content_base64: "JVBER" })),
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // dedup check (direct Paperless API)
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([{ id: 11, name: "accounting" }])),
      () => jsonResponse(rpcResponse({ id: 2 })),
      () => jsonResponse(rpcResponse({ id: 3 })),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid-456"', { status: 200 }),
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    expect(getJob(db, job.id)!.state).toBe("completed");
  });

  test("falls back to MCP download when file_path file doesn't exist", async () => {
    const input = makeInput({ file_path: "/nonexistent/path/invoice.pdf" });
    const job = createRunningJob(input);

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "att-1", name: "invoice.pdf", content_type: "application/pdf", size: 100 }])),
      () => jsonResponse(rpcResponse({ name: "invoice.pdf", content_type: "application/pdf", size: 100, content_base64: "AA" })),
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // dedup check (direct Paperless API)
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([{ id: 11, name: "accounting" }])),
      () => jsonResponse(rpcResponse({ id: 2 })),
      () => jsonResponse(rpcResponse({ id: 3 })),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid-789"', { status: 200 }),
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    expect(getJob(db, job.id)!.state).toBe("completed");
  });
});

describe("invoice-worker unified tag derivation", () => {
  test("derives tags deterministically from classification fields", async () => {
    const filePath = join(tmpDir, "tagged.pdf");
    writeFileSync(filePath, Buffer.from("fake pdf"));
    const input = makeInput({ file_path: filePath });
    const job = createRunningJob(
      input,
      defaultEmailClassification({ is_fuel: true, doc_type: "receipt" }),
      defaultDocClassification({ doc_type: "receipt", doc_date: "2026-02-15" }),
    );

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // dedup check (direct Paperless API)
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([{ id: 11, name: "accounting" }, { id: 3, name: "techlab" }])),
      () => jsonResponse(rpcResponse({ id: 10 })),
      () => jsonResponse(rpcResponse({ id: 11 })),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid"', { status: 200 }),
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    expect(output.tags).toContain("accounting");
    expect(output.tags).toContain("techlab");
    expect(output.tags).toContain("fuel");
    expect(output.tags).toContain("2026-02");
    expect(output.tags).not.toContain("invoicing");
  });

  test("techlab document gets accounting tag, not invoicing or documents", async () => {
    const filePath = join(tmpDir, "worklog.pdf");
    writeFileSync(filePath, Buffer.from("fake pdf"));
    const input = makeInput({ file_path: filePath });
    const job = createRunningJob(
      input,
      defaultEmailClassification({ doc_type: "document", is_fuel: false, order_id: null, total_amount: null }),
      defaultDocClassification({ doc_type: "document", total_amount: null }),
    );

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      () => jsonResponse(rpcResponse([{ id: 11, name: "accounting" }, { id: 3, name: "techlab" }, { id: 7, name: "2026-03" }])),
      () => jsonResponse(rpcResponse([])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid"', { status: 200 }),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    expect(output.tags).toContain("accounting");
    expect(output.tags).toContain("techlab");
    expect(output.tags).not.toContain("invoicing");
    expect(output.tags).not.toContain("documents");
  });

  test("owner techlab: invoice gets techlab + accounting + month tag", async () => {
    const filePath = join(tmpDir, "biz-invoice.pdf");
    writeFileSync(filePath, Buffer.from("fake pdf"));
    const input = makeInput({ file_path: filePath });
    const job = createRunningJob(input);

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([
        { id: 11, name: "accounting" },
        { id: 3, name: "techlab" },
        { id: 7, name: "2026-03" },
      ])),
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid"', { status: 200 }),
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    expect(output.tags).toContain("techlab");
    expect(output.tags).toContain("accounting");
    expect(output.tags).toContain("2026-03");
    expect(output.tags).not.toContain("invoicing");
    expect(output.tags).not.toContain("personal");
  });

  test("owner personal: invoice gets personal + month tag, no invoicing", async () => {
    const filePath = join(tmpDir, "personal-invoice.pdf");
    writeFileSync(filePath, Buffer.from("fake pdf"));
    const input = makeInput({ file_path: filePath });
    const job = createRunningJob(
      input,
      defaultEmailClassification({ owner: "personal" }),
      defaultDocClassification({ owner: "personal" }),
    );

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([
        { id: 8, name: "personal" },
        { id: 7, name: "2026-03" },
      ])),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid"', { status: 200 }),
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    expect(output.tags).toContain("personal");
    expect(output.tags).toContain("2026-03");
    expect(output.tags).not.toContain("techlab");
    expect(output.tags).not.toContain("invoicing");
  });

  test("owner personal + fuel: gets personal + fuel + month tag, no invoicing", async () => {
    const filePath = join(tmpDir, "personal-fuel.pdf");
    writeFileSync(filePath, Buffer.from("fake pdf"));
    const input = makeInput({ file_path: filePath });
    const job = createRunningJob(
      input,
      defaultEmailClassification({ doc_type: "receipt", is_fuel: true, owner: "personal" }),
      defaultDocClassification({ doc_type: "receipt", owner: "personal" }),
    );

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([
        { id: 8, name: "personal" },
        { id: 4, name: "fuel" },
        { id: 7, name: "2026-03" },
      ])),
      () => jsonResponse(rpcResponse([{ id: 5, name: "receipt" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid"', { status: 200 }),
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    expect(output.tags).toContain("personal");
    expect(output.tags).toContain("fuel");
    expect(output.tags).toContain("2026-03");
    expect(output.tags).not.toContain("techlab");
    expect(output.tags).not.toContain("invoicing");
  });

  test("missing owner fails job with missing_owner error", async () => {
    const filePath = join(tmpDir, "no-owner.pdf");
    writeFileSync(filePath, Buffer.from("fake pdf"));
    const input = makeInput({ file_path: filePath });
    const job = createRunningJob(
      input,
      defaultEmailClassification({ owner: undefined as any }),
      defaultDocClassification({ owner: undefined as any }),
    );

    mockFetch(
      // 1. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 2. dedup check → no duplicate
      () => jsonResponse({ results: [] }),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("failed");
    const error = JSON.parse(updated.error_json!);
    expect(error.code).toBe("missing_owner");
    expect(error.message).toContain("Missing owner field");
  });
});

// ── Production flow tests (classification via channel roundtrip) ────────

describe("invoice-worker channel classification flow", () => {
  /** Create a running job WITHOUT seeding classification steps — simulates first entry */
  function createJobWithoutClassification(input: InvoiceIntakeInput): JobRow {
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify(input),
      sourceRef: `${input.email_source}:${input.message_id}`,
      idempotencyKey: `${input.email_source}:${input.message_id}`,
    });
    db.prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    return getJob(db, job.id)!;
  }

  test("parks job for email classification when no completed steps", async () => {
    const input = makeInput();
    const job = createJobWithoutClassification(input);

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("awaiting_classification");
    const events = getJobEvents(db, job.id);
    const stepStarted = events.find(e => e.event_type === "step_started");
    expect(stepStarted).toBeTruthy();
    expect(JSON.parse(stepStarted!.payload_json!).step).toBe("classify_email");
  });

  test("parks job for doc classification after download", async () => {
    const input = makeInput();
    const job = createJobWithoutClassification(input);

    // Seed only classify_email — no classify_document
    addJobEvent(db, job.id, "step_completed", {
      step: "classify_email",
      result: defaultEmailClassification(),
    });

    mockFetch(
      // downloadAttachment: get_attachments
      () => jsonResponse(rpcResponse([{ id: "a1", name: "invoice.pdf", content_type: "application/pdf", size: 100 }])),
      // downloadAttachment: download_attachment
      () => jsonResponse(rpcResponse({ name: "invoice.pdf", content_type: "application/pdf", size: 100, content_base64: "JVBER" })),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("awaiting_classification");
    const events = getJobEvents(db, job.id);
    const docStep = events.find(e =>
      e.event_type === "step_started" && JSON.parse(e.payload_json!).step === "classify_document"
    );
    expect(docStep).toBeTruthy();
  });

  test("ignore action completes job without processing", async () => {
    const input = makeInput();
    const job = createJobWithoutClassification(input);

    addJobEvent(db, job.id, "step_completed", {
      step: "classify_email",
      result: defaultEmailClassification({ action: "ignore" }),
    });

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("ignored");
  });

  test("month_tag derived from doc_date when present", async () => {
    const input = makeInput();
    const job = createRunningJob(
      input,
      defaultEmailClassification({ subject: "No date here", received_at: "2026-04-01T10:00:00Z" }),
      defaultDocClassification({ doc_date: "2026-02-15" }),
    );

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "a1", name: "invoice.pdf", content_type: "application/pdf", size: 100 }])),
      () => jsonResponse(rpcResponse({ name: "invoice.pdf", content_type: "application/pdf", size: 100, content_base64: "JVBER" })),
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([
        { id: 1, name: "techlab" }, { id: 2, name: "accounting" }, { id: 3, name: "2026-02" },
      ])),
      () => jsonResponse({ results: [{ id: 1, name: "Invoice" }] }),
      storagePathsMockHandler(),
      () => jsonResponse("task-uuid-123"),
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.tags).toContain("2026-02");
  });

  test("month_tag falls back to subject regex when no doc_date", async () => {
    const input = makeInput();
    const job = createRunningJob(
      input,
      defaultEmailClassification({ subject: "Faktúra 03/2026", received_at: "2026-04-01T10:00:00Z" }),
      defaultDocClassification({ doc_date: null }),
    );

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "a1", name: "invoice.pdf", content_type: "application/pdf", size: 100 }])),
      () => jsonResponse(rpcResponse({ name: "invoice.pdf", content_type: "application/pdf", size: 100, content_base64: "JVBER" })),
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([
        { id: 1, name: "techlab" }, { id: 2, name: "accounting" }, { id: 3, name: "2026-03" },
      ])),
      () => jsonResponse({ results: [{ id: 1, name: "Invoice" }] }),
      storagePathsMockHandler(),
      () => jsonResponse("task-uuid-123"),
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.tags).toContain("2026-03");
  });
});

// ── Scan intake helpers ─────────────────────────────────────────────────

/** Build a minimal valid ScanIntakeInput (no classification — that comes via step_completed) */
function makeScanInput(overrides: Partial<ScanIntakeInput> = {}): ScanIntakeInput {
  return {
    source: "gdrive",
    file_id: "gdrive-file-abc",
    filename: "scan_invoice.pdf",
    month_tag: "2026-03",
    watch_folder: "techlab/invoicing",
    ...overrides,
  };
}

/** Default scan classification result (what the document-classifier returns via submit_classification) */
function defaultScanClassification(overrides: Partial<ScanClassification> = {}): ScanClassification {
  return {
    doc_type: "invoice",
    vendor: "Alza",
    total_amount: 59.99,
    currency: "EUR",
    is_fuel: false,
    owner: "techlab",
    confidence: "high",
    order_id: "FA2026030001",
    subtitle: null,
    doc_date: null,
    ...overrides,
  };
}

/** Create a scan_intake job, set it to running, and seed a classify_document step_completed event.
 *  Same pattern as createRunningJob for invoice intake. */
function createRunningScanJob(
  input: ScanIntakeInput,
  scanClass?: ScanClassification,
): JobRow {
  const job = createJob(db, {
    workflowType: "scan_intake",
    inputJson: JSON.stringify(input),
    sourceRef: `gdrive:${input.file_id}`,
    idempotencyKey: `gdrive:${input.file_id}`,
  });
  db.prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    job.id,
  );
  // Seed classification step (production path: channel roundtrip completed)
  addJobEvent(db, job.id, "step_completed", {
    step: "classify_document",
    result: scanClass ?? defaultScanClassification(),
  });
  return getJob(db, job.id)!;
}

/** Mock handlers for moveGdriveFile: search watch folder, search target folder, move file */
function moveGdriveMockHandlers(): FetchHandler[] {
  return [
    // search_drive_files → watch folder ID
    () => jsonResponse(rpcResponse([{ id: "watch-folder-id", name: "accounting" }])),
    // search_drive_files → target subfolder ("processed") ID
    () => jsonResponse(rpcResponse([{ id: "processed-folder-id", name: "processed" }])),
    // update_drive_file → move file
    () => jsonResponse(rpcResponse({ id: "gdrive-file-abc" })),
  ];
}

// ── Force re-upload tests ───────────────────────────────────────────────

describe("invoice-worker force-refresh (email pipeline)", () => {
  test("force=true + exact duplicate → PATCH existing doc, outcome=refreshed", async () => {
    const input = makeInput({ force: true });
    const job = createRunningJob(input);

    mockFetch(
      // 1. get_attachments
      () => jsonResponse(rpcResponse([{ id: "att-1", name: "inv.pdf", content_type: "application/pdf", size: 512 }])),
      // 2. download_attachment
      () => jsonResponse(rpcResponse({ name: "inv.pdf", content_type: "application/pdf", size: 512, content_base64: "AA" })),
      // 3. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 4. dedup check → exact duplicate (would normally short-circuit)
      () => jsonResponse({ results: [{
        id: 411,
        title: "Alza - FA2026030001",
        custom_fields: [{ field: 4, value: "FA2026030001" }, { field: 1, value: 59.99 }],
      }] }),
      // 5. list_tags (force-refresh continues the pipeline)
      () => jsonResponse(rpcResponse([{ id: 3, name: "techlab" }, { id: 11, name: "accounting" }, { id: 7, name: "2026-03" }])),
      // 6. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      // 7. resolveStoragePath
      storagePathsMockHandler(),
      // 8. PATCH existing doc (single request — no post_document, no separate custom_fields PATCH)
      (url, init) => {
        expect(url).toContain("/api/documents/411/");
        expect(init?.method).toBe("PATCH");
        const body = JSON.parse(init?.body as string);
        expect(body.title).toBe("Alza - FA2026030001");
        expect(body.correspondent).toBe(10);
        expect(body.tags).toEqual([3, 11, 7]);
        expect(body.document_type).toBe(5);
        expect(body.custom_fields).toContainEqual({ field: 1, value: 59.99 });
        expect(body.custom_fields).toContainEqual({ field: 4, value: "FA2026030001" });
        return jsonResponse({ id: 411 });
      },
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("refreshed");
    expect(output.paperless_document_id).toBe(411);
    expect(output.title).toBe("Alza - FA2026030001");
    expect(output.tags).toEqual(["techlab", "accounting", "2026-03"]);
  });

  test("force=true + duplicate_likely → PATCH (no approval gate)", async () => {
    const input = makeInput({ force: true });
    const job = createRunningJob(input);

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "att-1", name: "inv.pdf", content_type: "application/pdf", size: 512 }])),
      () => jsonResponse(rpcResponse({ name: "inv.pdf", content_type: "application/pdf", size: 512, content_base64: "AA" })),
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // dedup → likely duplicate (amount differs) — would normally pause for approval
      () => jsonResponse({ results: [{
        id: 411,
        title: "Alza - FA2026030001",
        custom_fields: [{ field: 4, value: "FA2026030001" }, { field: 1, value: 100.0 }],
      }] }),
      () => jsonResponse(rpcResponse([{ id: 3, name: "techlab" }, { id: 11, name: "accounting" }, { id: 7, name: "2026-03" }])),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      storagePathsMockHandler(),
      // PATCH the existing doc — operator's force overrides the approval gate
      (url, init) => {
        expect(url).toContain("/api/documents/411/");
        expect(init?.method).toBe("PATCH");
        return jsonResponse({ id: 411 });
      },
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    expect(updated.state).not.toBe("awaiting_approval");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("refreshed");
    expect(output.paperless_document_id).toBe(411);
  });

  test("force=true + no dedup hit → normal upload (force is a no-op)", async () => {
    const input = makeInput({ force: true });
    const job = createRunningJob(input);

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "att-1", name: "inv.pdf", content_type: "application/pdf", size: 512 }])),
      () => jsonResponse(rpcResponse({ name: "inv.pdf", content_type: "application/pdf", size: 512, content_base64: "AA" })),
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // dedup → no match
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([{ id: 3, name: "techlab" }, { id: 11, name: "accounting" }, { id: 7, name: "2026-03" }])),
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
      storagePathsMockHandler(),
      // post_document path runs as normal
      () => new Response('"task-uuid"', { status: 200 }),
      ...customFieldsMockHandlers(),
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
  });

  test("force=false + exact duplicate → unchanged behaviour (short-circuit)", async () => {
    const input = makeInput({ force: false });
    const job = createRunningJob(input);

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: "att-1", name: "inv.pdf", content_type: "application/pdf", size: 512 }])),
      () => jsonResponse(rpcResponse({ name: "inv.pdf", content_type: "application/pdf", size: 512, content_base64: "AA" })),
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      () => jsonResponse({ results: [{
        id: 411,
        title: "Alza - FA2026030001",
        custom_fields: [{ field: 4, value: "FA2026030001" }, { field: 1, value: 59.99 }],
      }] }),
      // No further fetches — pipeline must short-circuit
    );

    await executeInvoiceIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("duplicate");
    expect(output.duplicate_of).toBe(411);
  });
});

describe("invoice-worker force-refresh (scan pipeline)", () => {
  test("force=true + exact duplicate → PATCH existing scan doc", async () => {
    const filePath = join(tmpDir, "force_scan.pdf");
    writeFileSync(filePath, Buffer.from("fake-pdf"));

    const input = makeScanInput({ file_path: filePath, force: true });
    const job = createRunningScanJob(input);

    mockFetch(
      // 1. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 2. dedup → exact duplicate
      () => jsonResponse({ results: [{
        id: 222,
        title: "Alza - FA2026030001",
        custom_fields: [{ field: 4, value: "FA2026030001" }, { field: 1, value: 59.99 }],
      }] }),
      // 3. list_tags (continues past dedup under force)
      () => jsonResponse(rpcResponse([
        { id: 11, name: "accounting" },
        { id: 3, name: "techlab" },
        { id: 7, name: "2026-03" },
      ])),
      // 4. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      // 5. resolveStoragePath
      storagePathsMockHandler(),
      // 6. PATCH existing doc 222
      (url, init) => {
        expect(url).toContain("/api/documents/222/");
        expect(init?.method).toBe("PATCH");
        const body = JSON.parse(init?.body as string);
        expect(body.tags).toEqual([3, 11, 7]);
        return jsonResponse({ id: 222 });
      },
      // 7-9. moveGdriveFile to processed/
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("refreshed");
    expect(output.paperless_document_id).toBe(222);
  });
});

// ── Scan intake tests ───────────────────────────────────────────────────

describe("executeScanIntake", () => {
  test("happy path: scan file read from disk, uploaded, moved to processed", async () => {
    const filePath = join(tmpDir, "scan_invoice.pdf");
    writeFileSync(filePath, Buffer.from("JVBER-fake-pdf"));

    const input = makeScanInput({ file_path: filePath });
    const job = createRunningScanJob(input);

    mockFetch(
      // 1. list_correspondents → match found
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 2. dedup check (direct Paperless API) → no duplicate
      () => jsonResponse({ results: [] }),
      // 3. list_tags → "techlab" exists, "accounting" exists
      () => jsonResponse(rpcResponse([
        { id: 11, name: "accounting" },
        { id: 3, name: "techlab" },
      ])),
      // 4. create_tag for "2026-03" (month tag not in existing tags)
      () => jsonResponse(rpcResponse({ id: 20 })),
      // 5. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      // 6. resolveStoragePath
      storagePathsMockHandler(),
      // 7. post_document → task UUID
      () => new Response('"task-uuid-scan"', { status: 200 }),
      // 8-10. setDocumentCustomFields: task poll, PATCH, verify
      ...customFieldsMockHandlers(),
      // 11-13. moveGdriveFile: search watch folder, search target folder, move file
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
    expect(output.title).toBe("Alza - FA2026030001");
    expect(output.correspondent).toBe("Alza");
    expect(output.tags).toEqual(["techlab", "accounting", "2026-03"]);
    expect(output.total_amount).toBe(59.99);

    // Verify events were recorded
    const events = getJobEvents(db, job.id);
    const stepNames = events
      .filter((e) => e.event_type === "step_started" && e.payload_json)
      .map((e) => JSON.parse(e.payload_json!).step);
    expect(stepNames).toContain("read_from_disk");
    expect(stepNames).toContain("resolve_correspondent");
    expect(stepNames).toContain("deduplicate");
    expect(stepNames).toContain("resolve_tags");
    expect(stepNames).toContain("upload");
    expect(stepNames).toContain("set_custom_fields");
  });

  test("null vendor falls back to BUSINESS_COMPANY_NAME env var", async () => {
    // Reproduces the 2026-04-07 cestovný príkaz incident (task 48): the
    // document-classifier returned `vendor: null` for an internal doc (Techlab
    // travel order), which crashed `create_correspondent(name: null)`. After
    // the fix, the worker should fall back to BUSINESS_COMPANY_NAME from env
    // so the pipeline completes with the company as the correspondent.
    const filePath = join(tmpDir, "cestovny_prikaz.pdf");
    writeFileSync(filePath, Buffer.from("JVBER-fake-pdf"));
    process.env.BUSINESS_COMPANY_NAME = "Techlab s.r.o.";

    const input = makeScanInput({
      file_path: filePath,
      watch_folder: "techlab/documents",
    });
    const job = createRunningScanJob(
      input,
      defaultScanClassification({
        doc_type: "document",
        vendor: null as unknown as string, // bypass type for test — production sees this too
        order_id: null,
        total_amount: null,
        subtitle: "Cestovný príkaz 02.-03.03.2026",
      }),
    );

    mockFetch(
      // 1. list_correspondents → Techlab matches (env fallback vendor)
      () => jsonResponse(rpcResponse([{ id: 13, name: "Techlab s.r.o." }])),
      // 2. list_tags
      () => jsonResponse(rpcResponse([
        { id: 11, name: "accounting" },
        { id: 3, name: "techlab" },
      ])),
      // 3. create_tag for "2026-03"
      () => jsonResponse(rpcResponse({ id: 20 })),
      // 4. list_document_types
      () => jsonResponse(rpcResponse([{ id: 6, name: "Document" }])),
      // 5. resolveStoragePath
      storagePathsMockHandler(),
      // 6. post_document
      () => new Response('"task-uuid-cp"', { status: 200 }),
      // 7-9. setDocumentCustomFields (no total_amount/order_id → skipped)
      // NO customFieldsMockHandlers needed — worker skips when both null
      // 7-9. moveGdriveFile
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
    expect(output.correspondent).toBe("Techlab s.r.o.");
    delete process.env.BUSINESS_COMPANY_NAME;
  });

  test("detects exact duplicate, completes and moves to processed", async () => {
    const filePath = join(tmpDir, "dup_scan.pdf");
    writeFileSync(filePath, Buffer.from("fake-pdf"));

    const input = makeScanInput({ file_path: filePath });
    const job = createRunningScanJob(input);

    mockFetch(
      // 1. list_correspondents → match found
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 2. dedup check → exact duplicate (same order_id + same amount)
      () => jsonResponse({ results: [{
        id: 77,
        title: "Alza - FA2026030001",
        custom_fields: [{ field: 4, value: "FA2026030001" }, { field: 1, value: 59.99 }],
      }] }),
      // 3-5. moveGdriveFile to processed/
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("duplicate");
    expect(output.duplicate_of).toBe(77);
  });

  test("detects likely duplicate (amount differs) and pauses without moving", async () => {
    const filePath = join(tmpDir, "likely_dup_scan.pdf");
    writeFileSync(filePath, Buffer.from("fake-pdf"));

    const input = makeScanInput({ file_path: filePath });
    const job = createRunningScanJob(input);

    mockFetch(
      // 1. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 2. dedup check → match but different amount
      () => jsonResponse({ results: [{
        id: 77,
        title: "Alza - FA2026030001",
        custom_fields: [{ field: 4, value: "FA2026030001" }, { field: 1, value: 100.0 }],
      }] }),
      // No moveGdriveFile — job pauses for approval
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("awaiting_approval");
  });

  test("unknown vendor creates new correspondent", async () => {
    const filePath = join(tmpDir, "unknown_vendor.pdf");
    writeFileSync(filePath, Buffer.from("fake-pdf"));

    const input = makeScanInput({ file_path: filePath });
    const job = createRunningScanJob(input, defaultScanClassification({
      vendor: "NewCorp",
      order_id: null,
    }));

    mockFetch(
      // 1. list_correspondents → no match
      () => jsonResponse(rpcResponse([{ id: 1, name: "Alza" }, { id: 2, name: "Orange" }])),
      // 2. create_correspondent
      () => jsonResponse(rpcResponse({ id: 50, name: "NewCorp" })),
      // NO dedup (order_id is null)
      // 3. list_tags → techlab exists, accounting exists
      () => jsonResponse(rpcResponse([
        { id: 11, name: "accounting" },
        { id: 3, name: "techlab" },
      ])),
      // 4. create_tag for "2026-03"
      () => jsonResponse(rpcResponse({ id: 20 })),
      // 5. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      // 6. resolveStoragePath
      storagePathsMockHandler(),
      // 7. post_document
      () => new Response('"task-uuid-new"', { status: 200 }),
      // 8-10. setDocumentCustomFields (total_amount is set)
      ...customFieldsMockHandlers(),
      // 11-13. moveGdriveFile
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
    expect(output.correspondent).toBe("NewCorp");
  });

  test("upload failure marks job retryable on first failure", async () => {
    const filePath = join(tmpDir, "fail_scan.pdf");
    writeFileSync(filePath, Buffer.from("fake-pdf"));

    const input = makeScanInput({ file_path: filePath });
    const job = createRunningScanJob(input, defaultScanClassification({
      order_id: null,
      total_amount: null,
    }));

    mockFetch(
      // 1. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // NO dedup (order_id is null)
      // 2. list_tags
      () => jsonResponse(rpcResponse([
        { id: 11, name: "accounting" },
        { id: 3, name: "techlab" },
      ])),
      // 3. create_tag for "2026-03"
      () => jsonResponse(rpcResponse({ id: 20 })),
      // 4. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      // 5. resolveStoragePath
      storagePathsMockHandler(),
      // 6. post_document → 500 error
      () => jsonResponse({ error: "Internal server error" }, 500),
      // 7-9. moveGdriveFile to errors/
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("retryable");
    expect(updated.error_json).toContain("500");
  });

  test("skips custom fields when no total_amount or order_id", async () => {
    const filePath = join(tmpDir, "no_fields_scan.pdf");
    writeFileSync(filePath, Buffer.from("fake-pdf"));

    const input = makeScanInput({ file_path: filePath });
    const job = createRunningScanJob(input, defaultScanClassification({
      order_id: null,
      total_amount: null,
    }));

    mockFetch(
      // 1. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // NO dedup (order_id is null)
      // 2. list_tags
      () => jsonResponse(rpcResponse([
        { id: 11, name: "accounting" },
        { id: 3, name: "techlab" },
      ])),
      // 3. create_tag for "2026-03"
      () => jsonResponse(rpcResponse({ id: 20 })),
      // 4. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      // 5. resolveStoragePath
      storagePathsMockHandler(),
      // 6. post_document → OK (no custom fields step follows)
      () => new Response('"task-uuid-nf"', { status: 200 }),
      // 7-9. moveGdriveFile (no custom fields mock handlers needed)
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
  });

  test("tags derived from watch_folder owner only, not LEVEL2", async () => {
    const filePath = join(tmpDir, "custom_folder_scan.pdf");
    writeFileSync(filePath, Buffer.from("fake-pdf"));

    const input = makeScanInput({
      file_path: filePath,
      watch_folder: "personal/receipts",
      month_tag: "2026-01",
    });
    const job = createRunningScanJob(input, defaultScanClassification({
      order_id: null,
      total_amount: null,
      is_fuel: true,
    }));

    mockFetch(
      // 1. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // NO dedup (order_id is null)
      // 2. list_tags → "personal" exists, fuel + month need creating
      () => jsonResponse(rpcResponse([{ id: 8, name: "personal" }])),
      // 3. create_tag for "fuel"
      () => jsonResponse(rpcResponse({ id: 31 })),
      // 4. create_tag for "2026-01"
      () => jsonResponse(rpcResponse({ id: 32 })),
      // 5. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      // 6. resolveStoragePath
      storagePathsMockHandler(),
      // 7. post_document
      () => new Response('"task-uuid-tags"', { status: 200 }),
      // 8-10. moveGdriveFile
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    // Only owner tag from LEVEL1 + fuel + month — no "receipts" from LEVEL2
    expect(output.tags).toEqual(["personal", "fuel", "2026-01"]);
  });

  test("title uses subtitle when no order_id", async () => {
    const filePath = join(tmpDir, "subtitle_scan.pdf");
    writeFileSync(filePath, Buffer.from("fake-pdf"));

    const input = makeScanInput({ file_path: filePath });
    const job = createRunningScanJob(input, defaultScanClassification({
      order_id: null,
      total_amount: null,
      subtitle: "Dochádzka marec 2026",
    }));

    mockFetch(
      // 1. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // NO dedup
      // 2. list_tags
      () => jsonResponse(rpcResponse([
        { id: 11, name: "accounting" },
        { id: 3, name: "techlab" },
        { id: 7, name: "2026-03" },
      ])),
      // 3. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      // 4. resolveStoragePath
      storagePathsMockHandler(),
      // 5. post_document
      () => new Response('"task-uuid-sub"', { status: 200 }),
      // 6-8. moveGdriveFile
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    expect(output.title).toBe("Alza - Dochádzka marec 2026");
  });

  test("title uses filename (stripped extension) when no order_id or subtitle", async () => {
    const filePath = join(tmpDir, "20260325_blok_tankovanie.pdf");
    writeFileSync(filePath, Buffer.from("fake-pdf"));

    const input = makeScanInput({
      file_path: filePath,
      filename: "20260325_blok_tankovanie.pdf",
    });
    const job = createRunningScanJob(input, defaultScanClassification({
      order_id: null,
      total_amount: null,
      subtitle: null,
    }));

    mockFetch(
      // 1. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // NO dedup
      // 2. list_tags
      () => jsonResponse(rpcResponse([
        { id: 11, name: "accounting" },
        { id: 3, name: "techlab" },
        { id: 7, name: "2026-03" },
      ])),
      // 3. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      // 4. resolveStoragePath
      storagePathsMockHandler(),
      // 5. post_document
      () => new Response('"task-uuid-fn"', { status: 200 }),
      // 6-8. moveGdriveFile
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    expect(output.title).toBe("Alza - 20260325_blok_tankovanie");
  });

  test("month_tag derived from doc_date overrides scan date", async () => {
    const filePath = join(tmpDir, "docdate_scan.pdf");
    writeFileSync(filePath, Buffer.from("JVBER-fake-pdf"));

    // Input has month_tag 2026-03 (from GDrive creation date)
    // But doc_date is 2026-01-07 → should resolve to 2026-01
    const input = makeScanInput({ file_path: filePath, month_tag: "2026-03" });
    const job = createRunningScanJob(input, defaultScanClassification({
      doc_date: "2026-01-07",
    }));

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([
        { id: 11, name: "accounting" },
        { id: 3, name: "techlab" },
      ])),
      () => jsonResponse(rpcResponse({ id: 20 })),
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid-docdate"', { status: 200 }),
      ...customFieldsMockHandlers(),
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    expect(output.outcome).toBe("uploaded");
    expect(output.tags).toContain("2026-01");
    expect(output.tags).not.toContain("2026-03");
  });

  // Regression: the Telegram notification used classification.owner (the
  // classifier's raw guess) instead of watch_folder-derived owner (the source
  // of truth for scan intake). A fuel receipt scanned into techlab/accounting
  // would be tagged "techlab" in Paperless but the notification said "personal"
  // because the classifier couldn't link the vehicle to the business.
  test("notification owner matches watch_folder owner, not classifier owner", async () => {
    const filePath = join(tmpDir, "fuel_receipt.pdf");
    writeFileSync(filePath, Buffer.from("JVBER-fake-fuel"));

    // watch_folder says techlab, classifier says personal — tags must win
    const input = makeScanInput({
      file_path: filePath,
      watch_folder: "techlab/accounting",
      month_tag: "2026-04",
    });
    const job = createRunningScanJob(input, defaultScanClassification({
      vendor: "24h oil s.r.o.",
      total_amount: 79.32,
      is_fuel: true,
      owner: "personal",  // classifier's wrong guess
      order_id: null,
      subtitle: "Diesel nákup 15.04.2026",
      doc_date: "2026-04-15",
    }));

    mockFetch(
      // 1. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 20, name: "24h oil s.r.o." }])),
      // NO dedup (order_id is null)
      // 2. list_tags
      () => jsonResponse(rpcResponse([
        { id: 3, name: "techlab" },
        { id: 11, name: "accounting" },
        { id: 4, name: "fuel" },
      ])),
      // 3. create_tag for "2026-04"
      () => jsonResponse(rpcResponse({ id: 54 })),
      // 4. list_document_types
      () => jsonResponse(rpcResponse([{ id: 3, name: "receipt" }])),
      // 5. resolveStoragePath
      storagePathsMockHandler(),
      // 6. post_document
      () => new Response('"task-uuid-fuel"', { status: 200 }),
      // 7-9. setDocumentCustomFields
      ...customFieldsMockHandlers(426),
      // 10-12. moveGdriveFile
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.tags).toContain("techlab");
    expect(output.tags).not.toContain("personal");

    // The key assertion: notification must show "techlab" (from watch_folder),
    // not "personal" (from classifier)
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toContain("techlab");
    expect(notifyCalls[0]).not.toContain("personal");
  });

  test("month_tag falls back to scan date when doc_date is null", async () => {
    const filePath = join(tmpDir, "nodocdate_scan.pdf");
    writeFileSync(filePath, Buffer.from("JVBER-fake-pdf"));

    const input = makeScanInput({ file_path: filePath, month_tag: "2026-03" });
    const job = createRunningScanJob(input, defaultScanClassification({
      doc_date: null,
    }));

    mockFetch(
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      () => jsonResponse({ results: [] }),
      () => jsonResponse(rpcResponse([
        { id: 11, name: "accounting" },
        { id: 3, name: "techlab" },
      ])),
      () => jsonResponse(rpcResponse({ id: 20 })),
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      storagePathsMockHandler(),
      () => new Response('"task-uuid-fallback"', { status: 200 }),
      ...customFieldsMockHandlers(),
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    const output = JSON.parse(getJob(db, job.id)!.output_json!);
    expect(output.outcome).toBe("uploaded");
    expect(output.tags).toContain("2026-03");
  });

  test("fails with invalid input_json", async () => {
    const job = createJob(db, {
      workflowType: "scan_intake",
      inputJson: "not-valid-json{{{",
    });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    const runningJob = getJob(db, job.id)!;

    await executeScanIntake(db, runningJob, logger, registry, notify);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("failed");
    expect(updated.error_json).toContain("invalid_input");
  });

  // Regression: downloadFromGdrive used to return `size: fileBuffer.length`
  // but `fileBuffer` was not in scope. Current code uses `arrayBuffer.byteLength`.
  // This test exercises the GDrive download path (no file_path shortcut) and
  // asserts the recorded download size matches the actual binary length, not
  // any other value.
  test("downloadFromGdrive records actual binary size in download step event", async () => {
    // Use scan input WITHOUT file_path so the worker calls downloadFromGdrive
    const input = makeScanInput({ file_path: undefined, file_id: "gdrive-size-bug" });
    const job = createRunningScanJob(input);

    // Build a deterministic 1024-byte payload
    const payload = new Uint8Array(1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

    mockFetch(
      // 1. get_drive_file_download_url (MCP via callMcpTool → fetch)
      () => jsonResponse(rpcResponse({ url: "http://gmail-mcp:8000/drive-direct/gdrive-size-bug" })),
      // 2. fetch the binary itself (Buffer.from(arrayBuffer)) — must return raw bytes
      () => new Response(payload, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
      // 3. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 4. dedup
      () => jsonResponse({ results: [] }),
      // 5. list_tags
      () => jsonResponse(rpcResponse([{ id: 3, name: "techlab" }, { id: 11, name: "accounting" }, { id: 7, name: "2026-03" }])),
      // 6. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      // 7. resolveStoragePath
      storagePathsMockHandler(),
      // 8. post_document
      () => new Response('"task-uuid-scan-size"', { status: 200 }),
      // 9-11. setDocumentCustomFields
      ...customFieldsMockHandlers(),
      // 12-14. moveGdriveFile
      ...moveGdriveMockHandlers(),
    );

    await executeScanIntake(db, job, logger, registry, notify);

    expect(getJob(db, job.id)!.state).toBe("completed");

    const events = getJobEvents(db, job.id);
    const downloadCompleted = events.find((e) => {
      if (e.event_type !== "step_completed") return false;
      const p = JSON.parse(e.payload_json ?? "{}");
      return p.step === "download";
    });
    expect(downloadCompleted).toBeDefined();
    const recorded = JSON.parse(downloadCompleted!.payload_json ?? "{}");
    expect(recorded.size).toBe(payload.length);
  });
});
