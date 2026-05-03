/**
 * Tests for the PaperlessAdapter — the unified Paperless boundary that
 * the worker calls instead of mixing MCP + direct HTTP.
 *
 * These tests are deliberately tight wire-format checks because the adapter
 * was extracted from invoice-worker.ts as a behavior-preserving refactor.
 * Anything that diverges from the previous wire format would silently break
 * production. The existing invoice-worker.test.ts also exercises the
 * adapter through the worker; this file tests the adapter in isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PaperlessAdapter } from "./paperless-adapter";
import { PaperlessFieldRegistry } from "./paperless-fields";
import { setDocumentCustomFields, patchExistingDocument } from "./invoice/postprocess-service";

// ── Test infrastructure ────────────────────────────────────────────────

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;
let fetchHandlers: FetchHandler[];
let fetchCallLog: Array<{ url: string; init: RequestInit | undefined }>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rpcResponse(result: unknown) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(result) }] },
  };
}

function mockFetch(...handlers: FetchHandler[]) {
  fetchHandlers = [...handlers];
  let callIndex = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCallLog.push({ url, init });
    if (callIndex < fetchHandlers.length) {
      return fetchHandlers[callIndex++](url, init!);
    }
    throw new Error(`Unexpected fetch call #${callIndex}: ${url}`);
  }) as typeof fetch;
}

const logger = { log(_msg: string) {} };

let registry: PaperlessFieldRegistry;
let adapter: PaperlessAdapter;

beforeEach(async () => {
  fetchHandlers = [];
  fetchCallLog = [];

  // Build a pre-populated registry without hitting any mock
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
  registry = new PaperlessFieldRegistry("http://paperless", "tok");
  await registry.init();
  globalThis.fetch = originalFetch;

  adapter = new PaperlessAdapter({
    paperlessUrl: "http://paperless",
    paperlessToken: "tok",
    paperlessMcpUrl: "http://paperless-mcp:3000/mcp",
    fieldRegistry: registry,
  });

  // Make setTimeout resolve instantly so waitForConsumption polling
  // doesn't take 60 seconds.
  globalThis.setTimeout = ((fn: Function, _ms?: number, ...args: unknown[]) => {
    fn(...args);
    return 0 as any;
  }) as typeof setTimeout;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Correspondent operations ──────────────────────────────────────────

describe("PaperlessAdapter.findCorrespondent", () => {
  test("returns fuzzy match against existing correspondents", async () => {
    mockFetch(
      () => jsonResponse(rpcResponse([
        { id: 10, name: "Alza" },
        { id: 11, name: "Orange" },
      ])),
    );
    const match = await adapter.findCorrespondent("Alza");
    expect(match).toEqual({ id: 10, name: "Alza", score: expect.any(Number) });
    expect(fetchCallLog[0].url).toContain("paperless-mcp");
    expect(fetchCallLog[0].url).toContain("/mcp");
  });

  test("handles paginated MCP response { results: [...] }", async () => {
    mockFetch(
      () => jsonResponse(rpcResponse({
        count: 2,
        results: [
          { id: 10, name: "Alza" },
          { id: 11, name: "Orange" },
        ],
      })),
    );
    const match = await adapter.findCorrespondent("Orange");
    expect(match?.id).toBe(11);
  });

  test("returns null when no fuzzy match passes threshold", async () => {
    mockFetch(
      () => jsonResponse(rpcResponse([{ id: 10, name: "Alza" }])),
    );
    const match = await adapter.findCorrespondent("CompletelyDifferentVendor");
    expect(match).toBeNull();
  });

  test("walks paginated list_correspondents until exhausted (finds entry on page 2)", async () => {
    // Simulates the exact production bug: Paperless has 34 correspondents,
    // default page_size=25, "Techlab s.r.o." is at id=13 on page 2.
    // Before the fix, findCorrespondent only saw page 1 and returned null.
    mockFetch(
      () => jsonResponse(rpcResponse({
        count: 34,
        next: "http://paperless/api/correspondents/?page=2",
        previous: null,
        results: Array.from({ length: 25 }, (_, i) => ({
          id: 100 + i,
          name: `OtherVendor${i}`,
        })),
      })),
      () => jsonResponse(rpcResponse({
        count: 34,
        next: null,
        previous: "http://paperless/api/correspondents/?page=1",
        results: [
          { id: 13, name: "Techlab s.r.o." },
          ...Array.from({ length: 8 }, (_, i) => ({ id: 200 + i, name: `MoreVendor${i}` })),
        ],
      })),
    );
    const match = await adapter.findCorrespondent("Techlab s.r.o.");
    expect(match?.id).toBe(13);
    expect(match?.name).toBe("Techlab s.r.o.");
    expect(fetchCallLog).toHaveLength(2); // proves it walked past page 1
  });
});

describe("PaperlessAdapter.createCorrespondent", () => {
  test("calls MCP create_correspondent and returns id+name", async () => {
    mockFetch(
      () => jsonResponse(rpcResponse({ id: 50, name: "NewVendor" })),
    );
    const created = await adapter.createCorrespondent("NewVendor");
    expect(created).toEqual({ id: 50, name: "NewVendor" });
  });

  test("throws when MCP tool returns isError:true (duplicate name)", async () => {
    // Reproduces doc 413 root cause: paperless-mcp returns isError:true when
    // Paperless rejects a duplicate correspondent, but extractText was
    // silently returning the error JSON as if it were the tool output, and
    // the `as` type assertion then produced {id: undefined, name: undefined}.
    mockFetch(
      () => jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Request failed with status code 400",
              responseData: { error: "Object violates owner / name unique constraint" },
              status: 400,
            }),
          }],
          isError: true,
        },
      }),
    );
    await expect(adapter.createCorrespondent("Techlab s.r.o.")).rejects.toThrow(
      /unique constraint|isError|paperless/i,
    );
  });

  test("throws when MCP response is valid JSON but missing id field", async () => {
    // Defense against the `as {id, name}` type assertion silently producing
    // undefined when the server returns an unexpected shape.
    mockFetch(
      () => jsonResponse(rpcResponse({ foo: "bar", message: "something weird" })),
    );
    await expect(adapter.createCorrespondent("AnyVendor")).rejects.toThrow(
      /unexpected|id|shape/i,
    );
  });
});

// ── Tag operations ────────────────────────────────────────────────────

describe("PaperlessAdapter.resolveTagIds", () => {
  test("returns ids in input order, matches case-insensitive", async () => {
    mockFetch(
      () => jsonResponse(rpcResponse([
        { id: 3, name: "techlab" },
        { id: 11, name: "Accounting" },
        { id: 7, name: "2026-04" },
      ])),
    );
    const ids = await adapter.resolveTagIds(["techlab", "accounting", "2026-04"], logger);
    expect(ids).toEqual([3, 11, 7]);
  });

  test("creates missing tags via create_tag", async () => {
    mockFetch(
      () => jsonResponse(rpcResponse([{ id: 3, name: "techlab" }])),
      () => jsonResponse(rpcResponse({ id: 88 })), // create_tag for "accounting"
      () => jsonResponse(rpcResponse({ id: 99 })), // create_tag for "2026-04"
    );
    const ids = await adapter.resolveTagIds(["techlab", "accounting", "2026-04"], logger);
    expect(ids).toEqual([3, 88, 99]);
  });

  test("returns empty array for empty input without any fetch", async () => {
    mockFetch(); // no handlers
    const ids = await adapter.resolveTagIds([], logger);
    expect(ids).toEqual([]);
    expect(fetchCallLog).toHaveLength(0);
  });
});

// ── Document type ────────────────────────────────────────────────────

describe("PaperlessAdapter.findDocumentTypeId", () => {
  test("matches case-insensitive", async () => {
    mockFetch(
      () => jsonResponse(rpcResponse([
        { id: 5, name: "Invoice" },
        { id: 6, name: "Receipt" },
      ])),
    );
    expect(await adapter.findDocumentTypeId("invoice", logger)).toBe(5);
  });

  test("returns undefined when MCP throws", async () => {
    mockFetch(() => { throw new Error("not implemented"); });
    expect(await adapter.findDocumentTypeId("invoice", logger)).toBeUndefined();
  });
});

// ── Storage path ─────────────────────────────────────────────────────

describe("PaperlessAdapter.findStoragePathId", () => {
  test("matches case-insensitive against /api/storage_paths/", async () => {
    mockFetch(
      () => jsonResponse({
        results: [
          { id: 2, name: "Techlab Invoices" },
          { id: 3, name: "Techlab Documents" },
          { id: 4, name: "Personal Invoices" },
        ],
      }),
    );
    expect(await adapter.findStoragePathId("techlab invoices", logger)).toBe(2);
    expect(fetchCallLog[0].url).toContain("/api/storage_paths/");
    const headers = fetchCallLog[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Token tok");
  });

  test("returns undefined when name not found", async () => {
    mockFetch(() => jsonResponse({ results: [{ id: 2, name: "Techlab Invoices" }] }));
    expect(await adapter.findStoragePathId("Mystery Path", logger)).toBeUndefined();
  });
});

// ── Dedup search ─────────────────────────────────────────────────────

describe("PaperlessAdapter.searchDocumentsByCustomFieldAndCorrespondent", () => {
  test("hits /api/documents/ with custom_fields__icontains + correspondent__id", async () => {
    mockFetch(
      () => jsonResponse({ results: [{ id: 77, title: "Alza - FA1", custom_fields: [] }] }),
    );
    const docs = await adapter.searchDocumentsByCustomFieldAndCorrespondent("FA1", 10, logger);
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe(77);
    expect(fetchCallLog[0].url).toContain("/api/documents/");
    expect(fetchCallLog[0].url).toContain("custom_fields__icontains=FA1");
    expect(fetchCallLog[0].url).toContain("correspondent__id=10");
    expect(fetchCallLog[0].url).toContain("page_size=10");
  });

  test("returns empty array on non-OK response", async () => {
    mockFetch(() => new Response("err", { status: 500 }));
    const docs = await adapter.searchDocumentsByCustomFieldAndCorrespondent("X", 1, logger);
    expect(docs).toEqual([]);
  });
});

// ── Upload ────────────────────────────────────────────────────────────

describe("PaperlessAdapter.uploadDocument", () => {
  test("POSTs multipart/form-data to /api/documents/post_document/", async () => {
    mockFetch(
      () => new Response('"task-uuid-1"', { status: 200 }),
    );
    const r = await adapter.uploadDocument(
      { filename: "inv.pdf", content_base64: "JVBER", content_type: "application/pdf" },
      {
        title: "Alza - FA1",
        correspondentId: 10,
        tagIds: [3, 11, 7],
        documentTypeId: 5,
        storagePathId: 2,
      },
      logger,
    );
    expect(r.task_uuid).toBe("task-uuid-1");

    const call = fetchCallLog[0];
    expect(call.url).toContain("/api/documents/post_document/");
    expect(call.init?.method).toBe("POST");

    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Token tok");
    expect(headers["Content-Type"]).toContain("multipart/form-data; boundary=");

    const body = call.init?.body as Buffer;
    const bodyStr = body.toString("utf-8");
    expect(bodyStr).toContain('name="document"; filename="inv.pdf"');
    expect(bodyStr).toContain('name="title"\r\n\r\nAlza - FA1');
    expect(bodyStr).toContain('name="correspondent"\r\n\r\n10');
    expect(bodyStr).toContain('name="document_type"\r\n\r\n5');
    expect(bodyStr).toContain('name="storage_path"\r\n\r\n2');
    // Tags appear once per id
    expect(bodyStr.match(/name="tags"/g)).toHaveLength(3);
  });

  test("strips quotes/whitespace from task uuid response", async () => {
    mockFetch(
      () => new Response('  "trimmed-uuid"  ', { status: 200 }),
    );
    const r = await adapter.uploadDocument(
      { filename: "x.pdf", content_base64: "AA", content_type: "application/pdf" },
      { title: "T", correspondentId: 1, tagIds: [] },
      logger,
    );
    expect(r.task_uuid).toBe("trimmed-uuid");
  });

  test("throws on non-OK upload", async () => {
    mockFetch(() => new Response("400 nope", { status: 400 }));
    await expect(
      adapter.uploadDocument(
        { filename: "x.pdf", content_base64: "AA", content_type: "application/pdf" },
        { title: "T", correspondentId: 1, tagIds: [] },
        logger,
      ),
    ).rejects.toThrow(/upload failed/);
  });
});

// ── Patch ─────────────────────────────────────────────────────────────

describe("PaperlessAdapter.patchDocument", () => {
  test("PATCHes /api/documents/{id}/ with the supplied fields", async () => {
    mockFetch(
      () => jsonResponse({ id: 411 }),
    );
    const r = await adapter.patchDocument(
      411,
      {
        title: "Alza - FA1",
        correspondentId: 10,
        tagIds: [3, 11, 7],
        documentTypeId: 5,
        storagePathId: 2,
        customFields: [
          { field: 1, value: 59.99 },
          { field: 4, value: "FA1" },
        ],
      },
      logger,
    );
    expect(r).toEqual({ document_id: 411, title: "Alza - FA1" });

    const call = fetchCallLog[0];
    expect(call.url).toContain("/api/documents/411/");
    expect(call.init?.method).toBe("PATCH");
    const body = JSON.parse(call.init?.body as string);
    expect(body.title).toBe("Alza - FA1");
    expect(body.correspondent).toBe(10);
    expect(body.tags).toEqual([3, 11, 7]);
    expect(body.document_type).toBe(5);
    expect(body.storage_path).toBe(2);
    expect(body.custom_fields).toContainEqual({ field: 1, value: 59.99 });
    expect(body.custom_fields).toContainEqual({ field: 4, value: "FA1" });
  });

  test("omits document_type/storage_path/custom_fields when not provided", async () => {
    mockFetch(() => jsonResponse({ id: 100 }));
    await adapter.patchDocument(
      100,
      { title: "T", correspondentId: 1, tagIds: [] },
      logger,
    );
    const body = JSON.parse(fetchCallLog[0].init?.body as string);
    expect(body.document_type).toBeUndefined();
    expect(body.storage_path).toBeUndefined();
    expect(body.custom_fields).toBeUndefined();
  });
});

// ── Task polling ─────────────────────────────────────────────────────

describe("PaperlessAdapter.waitForConsumption", () => {
  test("returns doc_id parsed from result string on SUCCESS", async () => {
    mockFetch(
      () => jsonResponse([{ status: "SUCCESS", result: "Success. New document id 379 created" }]),
    );
    const r = await adapter.waitForConsumption("uuid-1", logger);
    expect(r.status).toBe("SUCCESS");
    expect(r.doc_id).toBe(379);
  });

  test("falls back to related_document if no id in result string", async () => {
    mockFetch(
      () => jsonResponse([{ status: "SUCCESS", result: "no id here", related_document: "999" }]),
    );
    const r = await adapter.waitForConsumption("uuid-2", logger);
    expect(r.doc_id).toBe(999);
  });

  test("returns FAILURE early on task FAILURE status", async () => {
    mockFetch(
      () => jsonResponse([{ status: "FAILURE", result: "consumer crashed" }]),
    );
    const r = await adapter.waitForConsumption("uuid-3", logger);
    expect(r.status).toBe("FAILURE");
    expect(r.doc_id).toBeUndefined();
  });
});

// ── Custom fields ────────────────────────────────────────────────────

describe("PaperlessAdapter.setCustomFields", () => {
  test("PATCHes custom_fields then verifies via GET", async () => {
    mockFetch(
      () => jsonResponse({ id: 99, custom_fields: [] }), // PATCH
      () => jsonResponse({ id: 99, custom_fields: [{ field: 1, value: 42.5 }] }), // verify GET
    );
    const r = await adapter.setCustomFields(99, [{ field: 1, value: 42.5 }], logger);
    expect(r.ok).toBe(true);
    expect(r.verified).toEqual([{ field: 1, value: 42.5 }]);

    expect(fetchCallLog[0].init?.method).toBe("PATCH");
    expect(fetchCallLog[0].url).toContain("/api/documents/99/");
    expect(fetchCallLog[1].init?.method).toBeUndefined();
  });

  test("returns ok=false with error on PATCH failure", async () => {
    mockFetch(() => new Response("nope", { status: 400 }));
    const r = await adapter.setCustomFields(99, [{ field: 1, value: 1 }], logger);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("PATCH failed");
  });

  test("returns ok=false when no fields supplied", async () => {
    mockFetch(); // no handlers
    const r = await adapter.setCustomFields(99, [], logger);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no fields");
    expect(fetchCallLog).toHaveLength(0);
  });
});

// ── setDocumentCustomFields (postprocess-service) ─────────────────────

/**
 * Build a PaperlessFieldRegistry seeded from a name→id map without hitting
 * any real network. Temporarily installs a mock fetch for registry.init(),
 * restores it afterward, then installs mockFetch for the actual test calls.
 */
async function primeFieldRegistry(fields: Record<string, number>): Promise<PaperlessFieldRegistry> {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      count: Object.keys(fields).length,
      next: null,
      results: Object.entries(fields).map(([name, id]) => ({
        id,
        name,
        data_type: name === "litres" || name === "total_amount" ? "float" : "string",
      })),
    }),
  })) as any;
  const reg = new PaperlessFieldRegistry("https://paperless.test", "tok");
  await reg.init();
  globalThis.fetch = savedFetch;
  return reg;
}

describe("setDocumentCustomFields (postprocess-service)", () => {
  test("PATCHes litres + receipt_datetime when fuel doc provides both", async () => {
    const taskUuid = "task-fuel-1";
    const docId = 422;

    const reg = await primeFieldRegistry({ total_amount: 1, order_id: 4, litres: 7, receipt_datetime: 8 });
    const testAdapter = new PaperlessAdapter({
      paperlessUrl: "https://paperless.test",
      paperlessToken: "tok",
      paperlessMcpUrl: "http://paperless-mcp:3000/mcp",
      fieldRegistry: reg,
    });

    mockFetch(
      // waitForConsumption: task poll → SUCCESS with doc id
      () => jsonResponse([{ status: "SUCCESS", result: `Success. New document id ${docId} created` }]),
      // setCustomFields: PATCH
      () => jsonResponse({ id: docId, custom_fields: [] }),
      // setCustomFields: verify GET
      () => jsonResponse({ id: docId, custom_fields: [
        { field: 1, value: 45.30 },
        { field: 4, value: "FA12345" },
        { field: 7, value: 45.30 },
        { field: 8, value: "2026-04-25T14:23:00" },
      ] }),
    );

    const result = await setDocumentCustomFields(
      taskUuid,
      45.30,                       // total_amount
      "FA12345",                   // order_id
      45.30,                       // litres
      "2026-04-25T14:23:00",       // receipt_datetime
      testAdapter,
      reg,
      { log: () => {} },
    );

    expect(result.doc_id).toBe(docId);
    expect(result.error).toBeUndefined();

    // The PATCH call is the second fetch (index 1 — after task poll)
    const patchCall = fetchCallLog.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall!.init!.body as string);
    const cf: Array<{ field: number; value: unknown }> = body.custom_fields;
    expect(cf).toContainEqual({ field: 1, value: 45.30 });   // total_amount
    expect(cf).toContainEqual({ field: 4, value: "FA12345" }); // order_id
    expect(cf).toContainEqual({ field: 7, value: 45.30 });   // litres
    expect(cf).toContainEqual({ field: 8, value: "2026-04-25T14:23:00" }); // receipt_datetime
  });

  test("omits litres and receipt_datetime when both are null (non-fuel doc)", async () => {
    const taskUuid = "task-nonfuel-1";
    const docId = 500;

    const reg = await primeFieldRegistry({ total_amount: 1, order_id: 4, litres: 7, receipt_datetime: 8 });
    const testAdapter = new PaperlessAdapter({
      paperlessUrl: "https://paperless.test",
      paperlessToken: "tok",
      paperlessMcpUrl: "http://paperless-mcp:3000/mcp",
      fieldRegistry: reg,
    });

    mockFetch(
      // waitForConsumption: task poll → SUCCESS
      () => jsonResponse([{ status: "SUCCESS", result: `Success. New document id ${docId} created` }]),
      // setCustomFields: PATCH
      () => jsonResponse({ id: docId, custom_fields: [] }),
      // setCustomFields: verify GET
      () => jsonResponse({ id: docId, custom_fields: [
        { field: 1, value: 99.00 },
        { field: 4, value: "INV-001" },
      ] }),
    );

    const result = await setDocumentCustomFields(
      taskUuid,
      99.00,     // total_amount
      "INV-001", // order_id
      null,      // litres — not a fuel doc
      null,      // receipt_datetime — not a fuel doc
      testAdapter,
      reg,
      { log: () => {} },
    );

    expect(result.doc_id).toBe(docId);
    expect(result.error).toBeUndefined();

    const patchCall = fetchCallLog.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall!.init!.body as string);
    const cf: Array<{ field: number; value: unknown }> = body.custom_fields;
    expect(cf).toContainEqual({ field: 1, value: 99.00 });    // total_amount present
    expect(cf).toContainEqual({ field: 4, value: "INV-001" }); // order_id present
    // litres and receipt_datetime must NOT be in the PATCH body
    expect(cf.find((e) => e.field === 7)).toBeUndefined();
    expect(cf.find((e) => e.field === 8)).toBeUndefined();
  });
});

// ── patchExistingDocument (postprocess-service) ───────────────────────

describe("patchExistingDocument (postprocess-service)", () => {
  test("includes litres + receipt_datetime in custom_fields", async () => {
    const reg = await primeFieldRegistry({ total_amount: 1, order_id: 4, litres: 7, receipt_datetime: 8 });
    const testAdapter = new PaperlessAdapter({
      paperlessUrl: "https://paperless.test",
      paperlessToken: "tok",
      paperlessMcpUrl: "http://paperless-mcp:3000/mcp",
      fieldRegistry: reg,
    });

    mockFetch(
      () => jsonResponse({ id: 422, title: "Slovnaft - FA12345" }),
    );

    await patchExistingDocument(
      {
        documentId: 422,
        title: "Slovnaft - FA12345",
        correspondentId: 10,
        tagIds: [1, 2],
        totalAmount: 45.30,
        orderId: "FA12345",
        litres: 45.30,
        receiptDatetime: "2026-04-25T14:23:00",
      },
      testAdapter,
      reg,
      { log: () => {} },
    );

    const patchCall = fetchCallLog.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall!.init!.body as string);
    const cf: Array<{ field: number; value: unknown }> = body.custom_fields;
    expect(cf).toContainEqual({ field: 7, value: 45.30 });
    expect(cf).toContainEqual({ field: 8, value: "2026-04-25T14:23:00" });
  });

  test("omits litres + receipt_datetime when not provided (non-fuel force-refresh)", async () => {
    const reg = await primeFieldRegistry({ total_amount: 1, order_id: 4, litres: 7, receipt_datetime: 8 });
    const testAdapter = new PaperlessAdapter({
      paperlessUrl: "https://paperless.test",
      paperlessToken: "tok",
      paperlessMcpUrl: "http://paperless-mcp:3000/mcp",
      fieldRegistry: reg,
    });

    mockFetch(
      () => jsonResponse({ id: 300, title: "Alza - INV-001" }),
    );

    await patchExistingDocument(
      {
        documentId: 300,
        title: "Alza - INV-001",
        correspondentId: 5,
        tagIds: [3],
        totalAmount: 99.00,
        orderId: "INV-001",
        litres: null,
        receiptDatetime: null,
      },
      testAdapter,
      reg,
      { log: () => {} },
    );

    const patchCall = fetchCallLog.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall!.init!.body as string);
    const cf: Array<{ field: number; value: unknown }> = body.custom_fields;
    // litres and receipt_datetime must NOT appear
    expect(cf.find((e) => e.field === 7)).toBeUndefined();
    expect(cf.find((e) => e.field === 8)).toBeUndefined();
  });
});
