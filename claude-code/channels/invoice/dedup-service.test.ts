import { describe, expect, test } from "bun:test";

import { checkDuplicate } from "./dedup-service";
import type { CorrespondentInfo, PaperlessAdapter, PaperlessDocument } from "../paperless-adapter";
import type { PaperlessFieldRegistry } from "../paperless-fields";

const ORDER_ID_FIELD = 10;
const TOTAL_AMOUNT_FIELD = 20;

const registry = {
  getFieldId: (name: string) => {
    if (name === "order_id") return ORDER_ID_FIELD;
    if (name === "total_amount") return TOTAL_AMOUNT_FIELD;
    throw new Error(`unexpected field ${name}`);
  },
} as unknown as PaperlessFieldRegistry;

const correspondent: CorrespondentInfo = { id: 7, name: "Alza" };

const silentLogger = { log: () => {} };

function fakeAdapter(docs: PaperlessDocument[]): PaperlessAdapter {
  return {
    searchDocumentsByCustomFieldAndCorrespondent: async () => docs,
  } as unknown as PaperlessAdapter;
}

function makeDoc(id: number, orderId: string, amount: number | null): PaperlessDocument {
  return {
    id,
    title: `Doc #${id}`,
    custom_fields: [
      { field: ORDER_ID_FIELD, value: orderId },
      ...(amount != null ? [{ field: TOTAL_AMOUNT_FIELD, value: amount }] : []),
    ],
  };
}

describe("checkDuplicate — base behavior (no received_at context)", () => {
  test("returns null when classification has no order_id", async () => {
    const result = await checkDuplicate(
      { order_id: null, total_amount: 100 },
      correspondent,
      fakeAdapter([]),
      registry,
      silentLogger,
    );
    expect(result).toBeNull();
  });

  test("returns null when no Paperless docs match", async () => {
    const result = await checkDuplicate(
      { order_id: "ORD-1", total_amount: 100 },
      correspondent,
      fakeAdapter([]),
      registry,
      silentLogger,
    );
    expect(result).toBeNull();
  });

  test("returns duplicate when order_id and amount match exactly", async () => {
    const result = await checkDuplicate(
      { order_id: "ORD-1", total_amount: 100 },
      correspondent,
      fakeAdapter([makeDoc(411, "ORD-1", 100)]),
      registry,
      silentLogger,
    );
    expect(result?.outcome).toBe("duplicate");
    expect(result?.existing_id).toBe(411);
  });

  test("returns duplicate_likely when order_id matches but amount differs", async () => {
    const result = await checkDuplicate(
      { order_id: "ORD-1", total_amount: 250 },
      correspondent,
      fakeAdapter([makeDoc(411, "ORD-1", 100)]),
      registry,
      silentLogger,
    );
    expect(result?.outcome).toBe("duplicate_likely");
    expect(result?.existing_id).toBe(411);
  });
});

describe("checkDuplicate — multi-stage refresh decision (with received_at context)", () => {
  test("older new email keeps duplicate outcome (silent skip)", async () => {
    const result = await checkDuplicate(
      { order_id: "ORD-1", total_amount: 100 },
      correspondent,
      fakeAdapter([makeDoc(411, "ORD-1", 100)]),
      registry,
      silentLogger,
      {
        newReceivedAt: "2026-04-20T08:00:00Z",
        lookupExistingReceivedAt: async () => "2026-04-20T09:57:11Z",
      },
    );
    expect(result?.outcome).toBe("duplicate");
    expect(result?.existing_id).toBe(411);
  });

  test("newer new email promotes to force_refresh", async () => {
    const result = await checkDuplicate(
      { order_id: "ORD-1", total_amount: 100 },
      correspondent,
      fakeAdapter([makeDoc(411, "ORD-1", 100)]),
      registry,
      silentLogger,
      {
        newReceivedAt: "2026-04-21T06:12:26Z",
        lookupExistingReceivedAt: async () => "2026-04-20T09:57:11Z",
      },
    );
    expect(result?.outcome).toBe("force_refresh");
    expect(result?.existing_id).toBe(411);
  });

  test("unknown existing received_at (NULL) treats as newer-wins → force_refresh", async () => {
    const result = await checkDuplicate(
      { order_id: "ORD-1", total_amount: 100 },
      correspondent,
      fakeAdapter([makeDoc(411, "ORD-1", 100)]),
      registry,
      silentLogger,
      {
        newReceivedAt: "2026-04-20T08:00:00Z",
        lookupExistingReceivedAt: async () => null,
      },
    );
    expect(result?.outcome).toBe("force_refresh");
  });

  test("equal received_at keeps duplicate (≤ comparison)", async () => {
    const ts = "2026-04-20T09:57:11Z";
    const result = await checkDuplicate(
      { order_id: "ORD-1", total_amount: 100 },
      correspondent,
      fakeAdapter([makeDoc(411, "ORD-1", 100)]),
      registry,
      silentLogger,
      {
        newReceivedAt: ts,
        lookupExistingReceivedAt: async () => ts,
      },
    );
    expect(result?.outcome).toBe("duplicate");
  });

  test("date-aware compare beats lexical: RFC 2822 newer than ISO existing → force_refresh", async () => {
    // Lexical compare would say "2026-04-20T08:00:00Z" < "Wed, 22 Apr 2026 ..."
    // is FALSE because '2'(50) < 'W'(87) — so the new RFC string would lex-sort
    // greater regardless of actual date. Verify date-aware compare wins.
    const result = await checkDuplicate(
      { order_id: "ORD-1", total_amount: 100 },
      correspondent,
      fakeAdapter([makeDoc(411, "ORD-1", 100)]),
      registry,
      silentLogger,
      {
        newReceivedAt: "Wed, 22 Apr 2026 11:16:23 +0200",
        lookupExistingReceivedAt: async () => "2026-04-20T08:00:00Z",
      },
    );
    expect(result?.outcome).toBe("force_refresh");
  });

  test("date-aware compare beats lexical: RFC 2822 older than RFC 2822 → duplicate", async () => {
    // "Sat, 18 Apr" < "Wed, 22 Apr" date-wise, but lex 'S'(83) > 'W'(87) is
    // false, so 'S' < 'W' lexically — opposite of date order. Real fix wins.
    const result = await checkDuplicate(
      { order_id: "ORD-1", total_amount: 100 },
      correspondent,
      fakeAdapter([makeDoc(411, "ORD-1", 100)]),
      registry,
      silentLogger,
      {
        newReceivedAt: "Sat, 18 Apr 2026 10:40:33 +0200",
        lookupExistingReceivedAt: async () => "Wed, 22 Apr 2026 11:16:23 +0200",
      },
    );
    expect(result?.outcome).toBe("duplicate");
  });

  test("amount mismatch still wins as duplicate_likely even when newer email arrives", async () => {
    // duplicate_likely needs human review (amount differs) regardless of timing —
    // refresh-promotion only applies to exact-amount matches.
    const result = await checkDuplicate(
      { order_id: "ORD-1", total_amount: 250 },
      correspondent,
      fakeAdapter([makeDoc(411, "ORD-1", 100)]),
      registry,
      silentLogger,
      {
        newReceivedAt: "2026-04-21T06:12:26Z",
        lookupExistingReceivedAt: async () => "2026-04-20T09:57:11Z",
      },
    );
    expect(result?.outcome).toBe("duplicate_likely");
  });
});
