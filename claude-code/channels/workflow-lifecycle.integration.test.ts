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
import type { InvoiceIntakeInput, ScanIntakeInput } from "./invoice-worker";
import { PaperlessFieldRegistry } from "./paperless-fields";
import {
  createJob,
  getJob,
  getJobEvents,
  openWorkflowDb,
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
    message_id: "msg-lifecycle-001",
    classification: {
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
      total_amount: 42.50,
      currency: "EUR",
    },
    subject: "Your invoice FA2026040001",
    sender: "invoices@alza.sk",
    received_at: "2026-03-31T10:00:00Z",
    ...overrides,
  };
}

/** Build a minimal valid ScanIntakeInput */
function makeScanInput(overrides: Partial<ScanIntakeInput> = {}): ScanIntakeInput {
  return {
    source: "gdrive",
    file_id: "gdrive-file-lifecycle",
    filename: "scan_lifecycle.pdf",
    month_tag: "2026-03",
    watch_folder: "techlab/invoicing",
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
    () => jsonResponse(rpcResponse([{ id: "watch-folder-id", name: "invoicing" }])),
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

    // Verify initial state
    expect(getJob(db, job.id)!.state).toBe("queued");

    mockFetch(
      // 1. list_correspondents → match
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
      // 2. dedup check (direct Paperless API) → no duplicate
      () => jsonResponse({ results: [] }),
      // 3. list_tags
      () => jsonResponse(rpcResponse([{ id: 1, name: "invoicing" }])),
      // 4. create_tag for "techlab"
      () => jsonResponse(rpcResponse({ id: 2 })),
      // 5. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "invoice" }])),
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
    expect(output.tags).toEqual(["techlab", "invoicing"]);

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
            { id: 1, name: "invoicing" },
            { id: 3, name: "techlab" },
          ]),
        ),
      // 4. create_tag for "2026-03" (month_tag not in existing tags)
      () => jsonResponse(rpcResponse({ id: 20 })),
      // 5. list_document_types
      () => jsonResponse(rpcResponse([{ id: 5, name: "Invoice" }])),
      // 6. post_document → task UUID
      () => new Response('"task-uuid-scan-lifecycle"', { status: 200 }),
      // 7-9. setDocumentCustomFields
      ...customFieldsMockHandlers(),
      // 10-12. moveGdriveFile to processed/
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
    expect(output.tags).toEqual(["techlab", "invoicing", "2026-03"]);
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

  test("job crash (fetch throws) → failed with error details", async () => {
    // Use attachment download strategy so the worker will make a fetch call.
    // executeInvoiceIntake has its own try/catch that calls failJob with
    // code "invoice_intake_error" — errors don't propagate to workflow-core's
    // catch block. This test verifies that the full lifecycle still ends in
    // a failed state with the original error message preserved.
    const input = makeInput();
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify(input),
      sourceRef: `outlook:${input.message_id}`,
    });

    // First fetch call throws an exception (simulating network failure)
    mockFetch(() => {
      throw new Error("Network connection refused");
    });

    const claimed = await executeNextJob(db, logger, registry);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(job.id);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("failed");
    const error = JSON.parse(updated.error_json!);
    expect(error.code).toBe("invoice_intake_error");
    expect(error.message).toContain("Network connection refused");
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
