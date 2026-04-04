/**
 * Workflow lifecycle integration tests.
 *
 * Unlike invoice-worker.test.ts which calls executeInvoiceIntake / executeScanIntake
 * directly on pre-claimed (running) jobs, these tests exercise the full lifecycle
 * through executeNextJob: createJob → executeNextJob → verify final state.
 *
 * This validates job claiming, state transitions, tracing spans, dispatch by
 * workflow_type, and error wrapping — the orchestration layer in workflow-core.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { executeNextJob } from "./workflow-core";
import type { InvoiceIntakeInput, InvoiceClassification, ScanIntakeInput } from "./invoice-worker";
import { PaperlessFieldRegistry } from "./paperless-fields";
import {
  addJobEvent,
  createJob,
  getJob,
  getJobEvents,
  openWorkflowDb,
  submitClassification,
} from "./workflow-db";

// ── Test helpers ───────────────────────────────────────────────────────

let tmpDir: string;
let db: Database;
let registry: PaperlessFieldRegistry;

const logger = { log(_msg: string) {} };

/** Build a minimal valid InvoiceIntakeInput (V2: only source + message_id) */
function makeInput(overrides: Partial<InvoiceIntakeInput> = {}): InvoiceIntakeInput {
  return {
    email_source: "outlook",
    message_id: "msg-lifecycle-001",
    ...overrides,
  };
}

/** Default email classification result */
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
    order_id: "FA2026040001",
    subtitle: null,
    total_amount: 42.50,
    currency: "EUR",
    sender: "invoices@alza.sk",
    subject: "Your invoice FA2026040001",
    received_at: "2026-03-31T10:00:00Z",
    ...overrides,
  };
}

/** Default doc classification result */
function defaultDocClassification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vendor: "Alza",
    total_amount: 42.50,
    owner: "techlab",
    doc_type: "invoice",
    doc_date: "2026-03-25",
    ...overrides,
  };
}

/** Seed classification step_completed events on a job (simulates channel roundtrip) */
function seedClassificationSteps(
  jobId: string,
  emailClass?: InvoiceClassification,
  docClass?: Record<string, unknown>,
): void {
  addJobEvent(db, jobId, "step_completed", {
    step: "classify_email",
    result: emailClass ?? defaultEmailClassification(),
  });
  addJobEvent(db, jobId, "step_completed", {
    step: "classify_document",
    result: docClass ?? defaultDocClassification(),
  });
}

/** Build a minimal valid ScanIntakeInput */
function makeScanInput(overrides: Partial<ScanIntakeInput> = {}): ScanIntakeInput {
  return {
    source: "gdrive",
    file_id: "gdrive-file-lifecycle",
    filename: "scan_lifecycle.pdf",
    month_tag: "2026-03",
    watch_folder: "techlab/accounting",
    classification: {
      doc_type: "invoice",
      vendor: "Orange",
      total_amount: 29.99,
      currency: "EUR",
      is_fuel: false,
      owner: "techlab",
      confidence: "high",
      order_id: "OR2026040001",
      subtitle: null,
    },
    ...overrides,
  };
}

/** JSON-RPC response wrapper (matches MCP Streamable HTTP format) */
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
    if (callIndex < fetchHandlers.length) {
      return fetchHandlers[callIndex++](url, init!);
    }
    throw new Error(`Unexpected fetch call #${callIndex}: ${url}`);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mock handlers for setDocumentCustomFields: task poll → PATCH → verify GET */
function customFieldsMockHandlers(docId = 999): FetchHandler[] {
  return [
    // task poll → SUCCESS
    () => jsonResponse([{ status: "SUCCESS", result: `Success. New document id ${docId} created` }]),
    // PATCH custom fields → OK
    () => jsonResponse({ id: docId, custom_fields: [] }),
    // verify GET → OK
    () => jsonResponse({ id: docId, custom_fields: [{ field: 1, value: 42.50 }] }),
  ];
}

/** Mock handlers for moveGdriveFile: search watch folder, search target folder, move file */
function moveGdriveMockHandlers(): FetchHandler[] {
  return [
    // search_drive_files → watch folder ID
    () => jsonResponse(rpcResponse([{ id: "watch-folder-id", name: "accounting" }])),
    // search_drive_files → target subfolder ("processed") ID
    () => jsonResponse(rpcResponse([{ id: "processed-folder-id", name: "processed" }])),
    // update_drive_file → move file
    () => jsonResponse(rpcResponse({ id: "gdrive-file-lifecycle" })),
  ];
}

// ── Setup / Teardown ───────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "workflow-lifecycle-test-"));
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

describe("workflow lifecycle: invoice_intake", () => {
  test("full lifecycle: create job → executeNextJob → completed", async () => {
    const filePath = join(tmpDir, "lifecycle-invoice.pdf");
    writeFileSync(filePath, Buffer.from("JVBER-fake-pdf"));

    const input = makeInput({ file_path: filePath });
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify(input),
      sourceRef: `outlook:${input.message_id}`,
      idempotencyKey: `outlook:${input.message_id}`,
    });
    seedClassificationSteps(job.id);

    // Verify initial state
    expect(getJob(db, job.id)!.state).toBe("queued");

    mockFetch(
      // 1. list_correspondents → match
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 2. dedup check (direct Paperless API) → no duplicate
      () => jsonResponse({ results: [] }),
      // 3. list_tags
      () => jsonResponse(rpcResponse([{ id: 3, name: "techlab" }, { id: 11, name: "accounting" }, { id: 7, name: "2026-03" }])),
      // 4. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      // 5. resolveStoragePath
      () => jsonResponse({ results: [
        { id: 2, name: "Techlab Invoices" },
        { id: 3, name: "Techlab Documents" },
        { id: 4, name: "Personal Invoices" },
        { id: 5, name: "Personal Documents" },
      ]}),
      // 6. post_document → task UUID
      () => new Response('"task-uuid-lifecycle"', { status: 200 }),
      // 7-9. setDocumentCustomFields
      ...customFieldsMockHandlers(),
    );

    const claimed = await executeNextJob(db, logger, registry);

    // executeNextJob returns the claimed job
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(job.id);

    // Job should be completed
    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
    expect(output.title).toBe("Alza - FA2026040001");
    expect(output.correspondent).toBe("Alza");
    expect(output.tags).toEqual(["techlab", "accounting", "2026-03"]);

    // Verify events include job lifecycle steps
    const events = getJobEvents(db, job.id);
    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toContain("step_started");
    expect(eventTypes).toContain("step_completed");
    expect(eventTypes).toContain("completed");
  });

  test("duplicate detected → completed with skip outcome", async () => {
    const filePath = join(tmpDir, "dup-invoice.pdf");
    writeFileSync(filePath, Buffer.from("JVBER-fake-pdf"));

    const input = makeInput({ file_path: filePath });
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify(input),
      sourceRef: `outlook:${input.message_id}`,
    });
    seedClassificationSteps(job.id);

    mockFetch(
      // 1. list_correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 2. dedup check → exact duplicate (same order_id + same amount)
      () =>
        jsonResponse({
          results: [
            {
              id: 77,
              title: "Alza - FA2026040001",
              custom_fields: [
                { field: 4, value: "FA2026040001" },
                { field: 1, value: 42.50 },
              ],
            },
          ],
        }),
    );

    await executeNextJob(db, logger, registry);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("duplicate");
    expect(output.duplicate_of).toBe(77);
  });
});

describe("workflow lifecycle: scan_intake", () => {
  test("full lifecycle: create scan job → executeNextJob → completed", async () => {
    const filePath = join(tmpDir, "lifecycle-scan.pdf");
    writeFileSync(filePath, Buffer.from("JVBER-fake-scan-pdf"));

    const input = makeScanInput({ file_path: filePath });
    const job = createJob(db, {
      workflowType: "scan_intake",
      inputJson: JSON.stringify(input),
      sourceRef: `gdrive:${input.file_id}`,
      idempotencyKey: `gdrive:${input.file_id}`,
    });

    expect(getJob(db, job.id)!.state).toBe("queued");

    mockFetch(
      // 1. list_correspondents → match
      () => jsonResponse(rpcResponse([{ id: 15, name: "Orange" }])),
      // 2. dedup check → no duplicate
      () => jsonResponse({ results: [] }),
      // 3. list_tags
      () =>
        jsonResponse(
          rpcResponse([
            { id: 11, name: "accounting" },
            { id: 3, name: "techlab" },
          ]),
        ),
      // 4. create_tag for "2026-03" (month_tag not in existing tags)
      () => jsonResponse(rpcResponse({ id: 20 })),
      // 5. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      // 6. resolveStoragePath
      () => jsonResponse({ results: [
        { id: 2, name: "Techlab Invoices" },
        { id: 3, name: "Techlab Documents" },
        { id: 4, name: "Personal Invoices" },
        { id: 5, name: "Personal Documents" },
      ]}),
      // 7. post_document → task UUID
      () => new Response('"task-uuid-scan-lifecycle"', { status: 200 }),
      // 8-10. setDocumentCustomFields
      ...customFieldsMockHandlers(),
      // 11-13. moveGdriveFile to processed/
      ...moveGdriveMockHandlers(),
    );

    const claimed = await executeNextJob(db, logger, registry);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(job.id);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    const output = JSON.parse(updated.output_json!);
    expect(output.outcome).toBe("uploaded");
    expect(output.title).toBe("Orange - OR2026040001");
    expect(output.correspondent).toBe("Orange");
    expect(output.tags).toEqual(["techlab", "accounting", "2026-03"]);
  });
});

describe("workflow lifecycle: error handling", () => {
  test("unknown workflow type → failed", async () => {
    const job = createJob(db, {
      workflowType: "nonexistent_workflow",
      inputJson: JSON.stringify({ foo: "bar" }),
    });

    const claimed = await executeNextJob(db, logger, registry);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(job.id);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("failed");
    const error = JSON.parse(updated.error_json!);
    expect(error.code).toBe("unsupported_workflow_type");
    expect(error.message).toContain("nonexistent_workflow");
  });

  test("job crash (fetch throws) → retryable on first failure", async () => {
    const input = makeInput();
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify(input),
      sourceRef: `outlook:${input.message_id}`,
    });
    seedClassificationSteps(job.id);

    const networkError = () => { throw new Error("Network connection refused"); };
    mockFetch(networkError, networkError, networkError, networkError);

    const claimed = await executeNextJob(db, logger, registry);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(job.id);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("retryable");
    expect(updated.retry_count).toBe(1);
    expect(updated.scheduled_at).not.toBeNull();
    const error = JSON.parse(updated.error_json!);
    expect(error.code).toBe("invoice_intake_error");
    expect(error.message).toContain("Network connection refused");
  });

  test("job crash at max retries → failed permanently", async () => {
    const input = makeInput();
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify(input),
      sourceRef: `outlook:${input.message_id}`,
      idempotencyKey: `outlook:max-retry-test`,
    });
    seedClassificationSteps(job.id);

    // Exhaust all retries: MAX_RETRIES=3 means 3 retryable + 1 final fail = 4 executions
    const networkError = () => { throw new Error("Network connection refused"); };
    for (let i = 0; i < 4; i++) {
      mockFetch(networkError, networkError, networkError, networkError);
      await executeNextJob(db, logger, registry);
      // Set scheduled_at to the past so retryable jobs are immediately claimable
      const j = getJob(db, job.id)!;
      if (j.state === "retryable") {
        db.prepare("UPDATE jobs SET scheduled_at = ? WHERE id = ?")
          .run(new Date(0).toISOString(), job.id);
      }
    }

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("failed");
    expect(updated.retry_count).toBe(3);
  });

  test("no queued jobs → returns null", async () => {
    const result = await executeNextJob(db, logger, registry);
    expect(result).toBeNull();
  });
});

describe("workflow lifecycle: job claiming", () => {
  test("executeNextJob claims the oldest queued job first", async () => {
    // Create two queued jobs
    const job1 = createJob(db, {
      workflowType: "synthetic",
      inputJson: JSON.stringify({ mode: "success", result: "first" }),
    });
    const job2 = createJob(db, {
      workflowType: "synthetic",
      inputJson: JSON.stringify({ mode: "success", result: "second" }),
    });

    // First call should claim job1
    await executeNextJob(db, logger, registry);
    expect(getJob(db, job1.id)!.state).toBe("completed");
    expect(getJob(db, job2.id)!.state).toBe("queued");

    // Second call should claim job2
    await executeNextJob(db, logger, registry);
    expect(getJob(db, job2.id)!.state).toBe("completed");
  });

  test("executeNextJob transitions job through running → final state", async () => {
    const job = createJob(db, {
      workflowType: "synthetic",
      inputJson: JSON.stringify({ mode: "success" }),
    });

    // Before execution: queued
    expect(getJob(db, job.id)!.state).toBe("queued");

    await executeNextJob(db, logger, registry);

    // After execution: completed (went through running internally)
    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("completed");
    expect(updated.started_at).not.toBeNull();
  });
});

// ── 3-tick channel roundtrip E2E ────────────────────────────────────────

describe("invoice intake 3-tick channel roundtrip", () => {
  test("full flow: park for email class → submit → park for doc class → submit → complete", async () => {
    // Job with no classification — worker must request via channel
    const input = makeInput();
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify(input),
      sourceRef: `${input.email_source}:${input.message_id}`,
    });

    // ── Tick 1: worker claims job, parks for email classification ──
    await executeNextJob(db, logger, registry);
    let state = getJob(db, job.id)!;
    expect(state.state).toBe("awaiting_classification");

    // Verify step_started event for classify_email
    let events = getJobEvents(db, job.id);
    const emailStepStarted = events.find(
      e => e.event_type === "step_started" && JSON.parse(e.payload_json!).step === "classify_email"
    );
    expect(emailStepStarted).toBeTruthy();

    // ── Simulate Claude: submit email classification ──
    const emailClassResult = defaultEmailClassification();
    const ok1 = submitClassification(db, job.id, "classify_email", emailClassResult);
    expect(ok1).toBe(true);
    expect(getJob(db, job.id)!.state).toBe("queued"); // ready for next tick

    // ── Tick 2: worker resumes, downloads, parks for doc classification ──
    // Mock: attachment download (2 fetch calls) — outlook get_attachments + download_attachment
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    let fetchCallIndex = 0;
    const mockResponses = [
      // get_attachments RPC
      () => new Response(JSON.stringify(rpcResponse([
        { id: "att-1", name: "invoice.pdf", content_type: "application/pdf", size: 500 },
      ])), { status: 200, headers: { "Content-Type": "application/json" } }),
      // download_attachment RPC
      () => new Response(JSON.stringify(rpcResponse({
        name: "invoice.pdf", content_type: "application/pdf", size: 500,
        content_base64: Buffer.from("%PDF-1.4 test content").toString("base64"),
      })), { status: 200, headers: { "Content-Type": "application/json" } }),
    ];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push(typeof url === "string" ? url : url.toString());
      if (fetchCallIndex < mockResponses.length) return mockResponses[fetchCallIndex++]();
      throw new Error(`Unexpected fetch #${fetchCallIndex}: ${url}`);
    }) as typeof fetch;

    await executeNextJob(db, logger, registry);
    globalThis.fetch = originalFetch;

    state = getJob(db, job.id)!;
    expect(state.state).toBe("awaiting_classification");

    // Verify download completed and doc classification requested
    events = getJobEvents(db, job.id);
    const downloadCompleted = events.find(
      e => e.event_type === "step_completed" && JSON.parse(e.payload_json!).step === "download"
    );
    expect(downloadCompleted).toBeTruthy();
    const docStepStarted = events.find(
      e => e.event_type === "step_started" && JSON.parse(e.payload_json!).step === "classify_document"
    );
    expect(docStepStarted).toBeTruthy();

    // ── Simulate Claude: submit document classification ──
    const docClassResult = defaultDocClassification();
    const ok2 = submitClassification(db, job.id, "classify_document", docClassResult);
    expect(ok2).toBe(true);
    expect(getJob(db, job.id)!.state).toBe("queued");

    // ── Tick 3: worker resumes, merges classifications, uploads, completes ──
    fetchCallIndex = 0;
    const tick3Responses = [
      // resolveCorrespondent: list correspondents
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // checkDuplicate: search_documents → no results
      () => jsonResponse({ results: [] }),
      // resolveTags: list_tags
      () => jsonResponse(rpcResponse([
        { id: 1, name: "techlab" }, { id: 2, name: "accounting" }, { id: 3, name: "2026-03" },
      ])),
      // resolveDocumentType: list document types
      () => jsonResponse({ results: [{ id: 1, name: "Invoice" }] }),
      // resolveStoragePath: GET storage paths
      () => jsonResponse({ results: [
        { id: 2, name: "Techlab Invoices" }, { id: 4, name: "Personal Invoices" },
      ]}),
      // uploadToPaperless: POST document
      () => jsonResponse("task-uuid-e2e"),
      // setDocumentCustomFields: task poll → SUCCESS
      () => jsonResponse([{ status: "SUCCESS", result: "Success. New document id 888 created" }]),
      // setDocumentCustomFields: PATCH custom fields
      () => jsonResponse({ id: 888, custom_fields: [] }),
      // setDocumentCustomFields: GET verify
      () => jsonResponse({ id: 888, custom_fields: [{ field: 1, value: 42.50 }] }),
    ];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (fetchCallIndex < tick3Responses.length) return tick3Responses[fetchCallIndex++]();
      throw new Error(`Unexpected fetch #${fetchCallIndex}: ${url}`);
    }) as typeof fetch;

    // Make setTimeout instant for custom fields polling
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function) => { fn(); return 0 as any; }) as typeof setTimeout;

    await executeNextJob(db, logger, registry);

    globalThis.setTimeout = origSetTimeout;
    globalThis.fetch = originalFetch;

    // ── Verify final state ──
    state = getJob(db, job.id)!;
    expect(state.state).toBe("completed");
    const output = JSON.parse(state.output_json!);
    expect(output.outcome).toBe("uploaded");
    expect(output.title).toContain("Alza");
    expect(output.total_amount).toBe(42.50);
    expect(output.tags).toContain("techlab");
    expect(output.tags).toContain("2026-03");

    // Verify all step events recorded
    events = getJobEvents(db, job.id);
    const stepNames = events
      .filter(e => e.event_type === "step_completed")
      .map(e => JSON.parse(e.payload_json!).step);
    expect(stepNames).toContain("classify_email");
    expect(stepNames).toContain("download");
    expect(stepNames).toContain("classify_document");
    expect(stepNames).toContain("resolve_correspondent");
    expect(stepNames).toContain("resolve_tags");
    expect(stepNames).toContain("upload");
  });
});
