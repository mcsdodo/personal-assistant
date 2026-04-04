import { describe, expect, test } from "bun:test";
import {
  mergeClassifications,
  resolveMonthTag,
  buildTagNames,
  generateTitle,
  type EmailClassification,
} from "./invoice-pipeline";

// ── mergeClassifications ────────────────────────────────────────────────

describe("mergeClassifications", () => {
  test("doc-classifier non-null values override email-classifier", () => {
    const email: EmailClassification = {
      vendor: "Alza",
      total_amount: null,
      owner: null,
      doc_type: "invoice",
      confidence: "medium",
      is_fuel: false,
      order_id: null,
      subtitle: null,
      currency: null,
    };
    const doc: Partial<EmailClassification> = {
      vendor: "Alza.sk s.r.o.",
      total_amount: 53.78,
      owner: "personal",
      doc_type: "invoice",
      confidence: "high",
    };
    const merged = mergeClassifications(email, doc);
    expect(merged.vendor).toBe("Alza.sk s.r.o.");
    expect(merged.total_amount).toBe(53.78);
    expect(merged.owner).toBe("personal");
    expect(merged.confidence).toBe("high");
  });

  test("email values preserved when doc returns null", () => {
    const email: EmailClassification = {
      vendor: "Alza",
      total_amount: 53.78,
      owner: null,
      doc_type: "invoice",
      confidence: "high",
      is_fuel: false,
      order_id: null,
      subtitle: null,
      currency: null,
    };
    const doc: Partial<EmailClassification> = {
      vendor: null,
      total_amount: null,
      owner: "personal",
      doc_type: null,
      confidence: null,
    };
    const merged = mergeClassifications(email, doc);
    expect(merged.vendor).toBe("Alza");
    expect(merged.total_amount).toBe(53.78);
    expect(merged.owner).toBe("personal");
  });

  test("undefined doc fields are ignored", () => {
    const email: EmailClassification = {
      vendor: "TestVendor",
      total_amount: 10,
      owner: "personal",
      doc_type: "invoice",
      confidence: "high",
      is_fuel: false,
      order_id: "ORD-1",
      subtitle: null,
      currency: "EUR",
    };
    const doc: Partial<EmailClassification> = {};
    const merged = mergeClassifications(email, doc);
    expect(merged).toEqual(email);
  });
});

// ── resolveMonthTag ─────────────────────────────────────────────────────

describe("resolveMonthTag", () => {
  test("extracts from subject billing period MM/YYYY", () => {
    expect(resolveMonthTag("Faktúra 03/2026", "2026-04-01", null)).toBe("2026-03");
  });

  test("extracts YYYY-MM from subject", () => {
    expect(resolveMonthTag("Statement 2026-02", "2026-04-01", null)).toBe("2026-02");
  });

  test("uses doc date when subject has no period", () => {
    expect(resolveMonthTag("Invoice", null, "2026-03-15")).toBe("2026-03");
  });

  test("falls back to received_at", () => {
    expect(resolveMonthTag("Invoice", "2026-04-01T10:00:00Z", null)).toBe("2026-04");
  });

  test("returns null when nothing available", () => {
    expect(resolveMonthTag("Invoice", null, null)).toBeNull();
  });

  test("null subject still uses doc date", () => {
    expect(resolveMonthTag(null, null, "2026-06-20")).toBe("2026-06");
  });
});

// ── buildTagNames ───────────────────────────────────────────────────────

describe("buildTagNames", () => {
  test("personal owner gets personal tag", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "invoice", is_fuel: false }, "2026-04");
    expect(tags).toContain("personal");
    expect(tags).toContain("2026-04");
    expect(tags).not.toContain("techlab");
  });

  test("techlab owner gets techlab + accounting tags", () => {
    const tags = buildTagNames({ owner: "techlab", doc_type: "invoice", is_fuel: false }, "2026-04");
    expect(tags).toContain("techlab");
    expect(tags).toContain("accounting");
  });

  test("fuel flag adds fuel tag", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "invoice", is_fuel: true }, "2026-04");
    expect(tags).toContain("fuel");
  });

  test("credit_note doc_type adds credit-note tag", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "credit_note", is_fuel: false }, null);
    expect(tags).toContain("credit-note");
  });

  test("account_statement doc_type adds account-statement tag", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "account_statement", is_fuel: false }, null);
    expect(tags).toContain("account-statement");
  });

  test("null month_tag is not included", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "invoice", is_fuel: false }, null);
    expect(tags).not.toContain(null);
    expect(tags).toEqual(["personal"]);
  });
});

// ── generateTitle ───────────────────────────────────────────────────────

describe("generateTitle", () => {
  test("vendor + order_id", () => {
    expect(generateTitle("Alza.sk s.r.o.", "590848993", null, null)).toBe("Alza.sk s.r.o. - 590848993");
  });

  test("vendor + subtitle when no order_id", () => {
    expect(generateTitle("DST s.r.o.", null, "Dochádzka marec 2026", null)).toBe("DST s.r.o. - Dochádzka marec 2026");
  });

  test("vendor + cleaned subject when no order_id or subtitle", () => {
    expect(generateTitle("Vendor", null, null, "Fwd: Your invoice #123")).toBe("Vendor - Your invoice #123");
  });

  test("vendor + fallback when nothing else", () => {
    expect(generateTitle("Vendor", null, null, null)).toBe("Vendor - invoice");
  });

  test("subject is trimmed to 80 chars", () => {
    const longSubject = "A".repeat(100);
    const result = generateTitle("V", null, null, longSubject);
    expect(result).toBe(`V - ${"A".repeat(80)}`);
  });
});
