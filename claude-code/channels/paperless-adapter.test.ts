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
