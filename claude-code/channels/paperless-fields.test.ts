import { afterEach, describe, expect, mock, test } from "bun:test";
import { PaperlessFieldRegistry } from "./paperless-fields";

// Mock global fetch
const originalFetch = globalThis.fetch;

function mockFetch(responses: Array<{ ok: boolean; json?: () => Promise<unknown>; text?: () => Promise<string>; status?: number }>) {
  let callIndex = 0;
  globalThis.fetch = mock(async () => {
    const resp = responses[callIndex++];
    return resp as Response;
  }) as any;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("PaperlessFieldRegistry", () => {
  test("resolves existing fields from API", async () => {
    mockFetch([{
      ok: true,
      json: async () => ({
        count: 2,
        next: null,
        results: [
          { id: 1, name: "total_amount", data_type: "float" },
          { id: 4, name: "order_id", data_type: "string" },
        ],
      }),
    }]);

    const registry = new PaperlessFieldRegistry("https://paperless.test", "token123");
    await registry.init();

    expect(registry.getFieldId("total_amount")).toBe(1);
    expect(registry.getFieldId("order_id")).toBe(4);
  });

  test("creates missing fields and caches returned ID", async () => {
    mockFetch([
      // GET list — only total_amount exists
      {
        ok: true,
        json: async () => ({
          count: 1,
          next: null,
          results: [{ id: 1, name: "total_amount", data_type: "float" }],
        }),
      },
      // POST create order_id — returns new field
      {
        ok: true,
        json: async () => ({ id: 7, name: "order_id", data_type: "string" }),
      },
    ]);

    const registry = new PaperlessFieldRegistry("https://paperless.test", "token123");
    await registry.init();

    expect(registry.getFieldId("total_amount")).toBe(1);
    expect(registry.getFieldId("order_id")).toBe(7);
  });

  test("throws on unknown field name", async () => {
    mockFetch([{
      ok: true,
      json: async () => ({
        count: 2,
        next: null,
        results: [
          { id: 1, name: "total_amount", data_type: "float" },
          { id: 4, name: "order_id", data_type: "string" },
        ],
      }),
    }]);

    const registry = new PaperlessFieldRegistry("https://paperless.test", "token123");
    await registry.init();

    expect(() => registry.getFieldId("nonexistent")).toThrow("Unknown custom field: nonexistent");
  });

  test("logs warning and skips field if creation fails", async () => {
    const logs: string[] = [];
    mockFetch([
      // GET list — empty
      {
        ok: true,
        json: async () => ({ count: 0, next: null, results: [] }),
      },
      // POST create total_amount — succeeds
      {
        ok: true,
        json: async () => ({ id: 10, name: "total_amount", data_type: "float" }),
      },
      // POST create order_id — fails (403)
      {
        ok: false,
        status: 403,
        text: async () => "Permission denied",
      },
    ]);

    const registry = new PaperlessFieldRegistry("https://paperless.test", "token123", (msg) => logs.push(msg));
    await registry.init();

    expect(registry.getFieldId("total_amount")).toBe(10);
    expect(() => registry.getFieldId("order_id")).toThrow();
    expect(logs.some(l => l.includes("order_id"))).toBe(true);
  });

  test("auto-creates litres and receipt_datetime when missing from Paperless", async () => {
    const created: Array<{ name: string; data_type: string }> = [];
    let callIndex = 0;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const isPost = init?.method === "POST";
      if (!isPost) {
        // GET — empty list
        callIndex++;
        return {
          ok: true,
          json: async () => ({ count: 0, next: null, results: [] }),
        } as Response;
      }
      // POST — record and return synthetic created field
      const body = JSON.parse(init!.body as string);
      created.push(body);
      callIndex++;
      return {
        ok: true,
        json: async () => ({ id: created.length, name: body.name, data_type: body.data_type }),
      } as Response;
    }) as any;

    const registry = new PaperlessFieldRegistry("https://paperless.test", "tok");
    await registry.init();

    const names = created.map((c) => c.name);
    expect(names).toContain("total_amount");
    expect(names).toContain("order_id");
    expect(names).toContain("litres");
    expect(names).toContain("receipt_datetime");

    const litres = created.find((c) => c.name === "litres");
    expect(litres?.data_type).toBe("float");

    const datetime = created.find((c) => c.name === "receipt_datetime");
    expect(datetime?.data_type).toBe("string");
  });

  test("handles paginated results", async () => {
    mockFetch([
      // Page 1
      {
        ok: true,
        json: async () => ({
          count: 2,
          next: "https://paperless.test/api/custom_fields/?page=2",
          results: [{ id: 1, name: "total_amount", data_type: "float" }],
        }),
      },
      // Page 2
      {
        ok: true,
        json: async () => ({
          count: 2,
          next: null,
          results: [{ id: 4, name: "order_id", data_type: "string" }],
        }),
      },
    ]);

    const registry = new PaperlessFieldRegistry("https://paperless.test", "token123");
    await registry.init();

    expect(registry.getFieldId("total_amount")).toBe(1);
    expect(registry.getFieldId("order_id")).toBe(4);
  });
});
