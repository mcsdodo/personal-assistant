import { describe, expect, test } from "bun:test";
import { formatNotification } from "./telegram-notify";

describe("formatNotification", () => {
  test("uploaded — all fields present", () => {
    expect(formatNotification({
      outcome: "uploaded",
      vendor: "Slovak Telekom",
      total_amount: 42.99,
      currency: "EUR",
      doc_type: "invoice",
      owner: "techlab",
      month_tag: "2026-04",
    })).toBe("✔️  Slovak Telekom | 42.99 EUR | invoice | techlab | 2026-04");
  });

  test("uploaded — null amount shows ?", () => {
    expect(formatNotification({
      outcome: "uploaded",
      vendor: "Alza",
      total_amount: null,
      currency: "EUR",
      doc_type: "receipt",
      owner: "personal",
      month_tag: "2026-03",
    })).toBe("✔️  Alza | ? EUR | receipt | personal | 2026-03");
  });

  test("uploaded — null currency defaults to EUR", () => {
    expect(formatNotification({
      outcome: "uploaded",
      vendor: "Tesco",
      total_amount: 18.50,
      currency: null,
      doc_type: "invoice",
      owner: "techlab",
      month_tag: "2026-04",
    })).toBe("✔️  Tesco | 18.5 EUR | invoice | techlab | 2026-04");
  });

  test("uploaded — null owner shows ?", () => {
    expect(formatNotification({
      outcome: "uploaded",
      vendor: "Orange",
      total_amount: 29.99,
      currency: "EUR",
      doc_type: "invoice",
      owner: null,
      month_tag: "2026-03",
    })).toBe("✔️  Orange | 29.99 EUR | invoice | ? | 2026-03");
  });

  test("uploaded — null month_tag shows no-period", () => {
    expect(formatNotification({
      outcome: "uploaded",
      vendor: "SomeVendor",
      total_amount: null,
      currency: null,
      doc_type: "invoice",
      owner: null,
      month_tag: null,
    })).toBe("✔️  SomeVendor | ? EUR | invoice | ? | no-period");
  });

  test("uploaded — missing month_tag shows no-period", () => {
    expect(formatNotification({
      outcome: "uploaded",
      vendor: "SomeVendor",
      total_amount: null,
      currency: null,
      doc_type: "invoice",
      owner: null,
    })).toBe("✔️  SomeVendor | ? EUR | invoice | ? | no-period");
  });

  test("duplicate_likely — shows duplicate message", () => {
    expect(formatNotification({
      outcome: "duplicate_likely",
      vendor: "Tesco",
      total_amount: 18.50,
      currency: "EUR",
      doc_type: "invoice",
      owner: "techlab",
      duplicate_message: 'duplicate of "Tesco FA-2026-001"',
    })).toBe('♻️  Tesco | 18.5 EUR | duplicate of "Tesco FA-2026-001"');
  });

  test("failed — shows error", () => {
    expect(formatNotification({
      outcome: "failed",
      vendor: "Orange",
      total_amount: null,
      currency: null,
      doc_type: "invoice",
      owner: "techlab",
      error: "download failed: 404",
    })).toBe("❌  Orange | ? EUR | invoice | techlab | download failed: 404");
  });

  test("failed — null error shows unknown error", () => {
    expect(formatNotification({
      outcome: "failed",
      vendor: "Orange",
      total_amount: 10,
      currency: "EUR",
      doc_type: "invoice",
      owner: null,
      error: null,
    })).toBe("❌  Orange | 10 EUR | invoice | ? | unknown error");
  });

  test("duplicate — returns null (no notification)", () => {
    expect(formatNotification({
      outcome: "duplicate",
      vendor: "Tesco",
      total_amount: 18.5,
      currency: "EUR",
      doc_type: "invoice",
      owner: "techlab",
    })).toBeNull();
  });
});
