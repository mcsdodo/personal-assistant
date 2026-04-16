import { describe, expect, test } from "bun:test";
import { formatGuidanceRequest, formatNotification } from "./telegram-notify";

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

  test("refreshed — includes 🔄 icon, period and (refreshed #N)", () => {
    expect(formatNotification({
      outcome: "refreshed",
      vendor: "Anthropic, PBC",
      total_amount: 100.0,
      currency: "EUR",
      doc_type: "invoice",
      owner: "techlab",
      month_tag: "2026-04",
      paperless_document_id: 411,
    })).toBe("🔄  Anthropic, PBC | 100 EUR | invoice | techlab | 2026-04 (refreshed #411)");
  });

  test("refreshed — without doc id falls back to (refreshed)", () => {
    expect(formatNotification({
      outcome: "refreshed",
      vendor: "Alza",
      total_amount: 53.78,
      currency: "EUR",
      doc_type: "invoice",
      owner: "personal",
      month_tag: "2026-03",
    })).toBe("🔄  Alza | 53.78 EUR | invoice | personal | 2026-03 (refreshed)");
  });
});

describe("formatGuidanceRequest", () => {
  test("encrypted_pdf reason includes filename, sender, and decrypt-failed note", () => {
    const msg = formatGuidanceRequest({
      job_id: "abc123",
      reason: "encrypted_pdf",
      context: {
        filename: "mKonto_c_0157_za_2026-03.pdf",
        sender: "kontakt@mbank.sk",
        subject: "mBank – Mesačný výpis z účtu",
        classifier_notes: "PDF is encrypted; decrypt failed",
      },
      suggested_actions: ["skip", "set:owner=personal,doc_type=account_statement", "send_password"],
    });
    expect(msg).toContain("🤔");
    expect(msg).toContain("mKonto_c_0157_za_2026-03.pdf");
    expect(msg).toContain("kontakt@mbank.sk");
    expect(msg).toContain("encrypted");
    expect(msg).toContain("/skip");
  });

  test("classifier_unknown reason shows missing fields and notes", () => {
    const msg = formatGuidanceRequest({
      job_id: "def456",
      reason: "classifier_unknown",
      missing_fields: ["owner"],
      context: {
        filename: "invoice.pdf",
        vendor: "Alza.sk s.r.o.",
        total_amount: 142.30,
        classifier_notes: "no IČO printed",
      },
      suggested_actions: ["set:owner=personal", "set:owner=techlab", "skip"],
    });
    expect(msg).toContain("Owner unclear");
    expect(msg).toContain("no IČO");
    expect(msg).toContain("/personal");
    expect(msg).toContain("/techlab");
  });
});
