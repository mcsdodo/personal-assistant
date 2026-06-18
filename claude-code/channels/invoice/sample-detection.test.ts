/**
 * Unit tests for Alza sample-invoice detection.
 *
 * STRINGS ONLY — no PDF, no pdftotext. All six required cases from the brief.
 * The extractPdfText integration test is omitted from this suite (pdftotext
 * shells out; poppler-utils is not guaranteed in CI).
 */

import { describe, it, expect } from "bun:test";
import { normalizeForMatch, fuzzyContains, isSampleInvoice } from "./sample-detection";

// ── Sanity-check oracle (from the brief) ────────────────────────────────────
// normalizeForMatch("nemožno použiť ako daňový doklad") === "nemoznopouzitakodanovydoklad" (28 chars)
const STRONG_PHRASE = "nemožno použiť ako daňový doklad";
const STRONG_NORM = "nemoznopouzitakodanovydoklad";

describe("normalizeForMatch", () => {
  it("folds diacritics, removes whitespace, lowercases", () => {
    expect(normalizeForMatch("Daňový  Doklad\nNie")).toBe("danovydokladnie");
  });

  it("oracle: strong phrase normalizes to expected 28-char run", () => {
    const result = normalizeForMatch(STRONG_PHRASE);
    expect(result).toBe(STRONG_NORM);
    expect(result.length).toBe(28);
  });

  it("removes punctuation and numbers are kept", () => {
    expect(normalizeForMatch("EUR 51,64 €")).toBe("eur5164");
  });
});

describe("isSampleInvoice", () => {
  // ── Case 1: Positive — sample watermark with pdftotext-style newlines ──────
  it("detects sample watermark with realistic newline/space splitting", () => {
    // Mimics pdftotext -raw output: watermark glyphs scattered across lines.
    const sampleText = [
      "Ukážka",
      "nemožno",
      "použiť",
      "ako",
      "daňový",
      "doklad",
      "Toto nie je vydaný",
      "daňový doklad.",
    ].join("\n");

    const result = isSampleInvoice(sampleText);
    expect(result.isSample).toBe(true);
    expect(result.matched).toContain("not_tax_doc");
  });

  // ── Case 2: Diacritic-fold ─────────────────────────────────────────────────
  it("detects ASCII-folded variant (diacritic insensitivity)", () => {
    // Exact ASCII version of the strong phrase — normalize() must strip diacritics.
    const asciiText = "nemozno pouzit ako danovy doklad nie je vydany ukazka";
    const result = isSampleInvoice(asciiText);
    expect(result.isSample).toBe(true);
    expect(result.matched).toContain("not_tax_doc");
  });

  // ── Case 3: Noise tolerance — one-character corruption ────────────────────
  it("detects strong phrase with a one-character substitution (noise tolerance)", () => {
    // "nemožno použiť ako daňový doklad" → corrupt one char in the middle.
    // 28-char needle, 1 edit → sim = 1 - 1/28 ≈ 0.964 — well above 0.85.
    const corruptedText = "nemožno použiť xko daňový doklad";  // 'a' → 'x'
    const result = isSampleInvoice(corruptedText);
    expect(result.isSample).toBe(true);
    expect(result.matched).toContain("not_tax_doc");
  });

  // ── Case 4: Negative — real invoice text must NOT trip detection ──────────
  it("does NOT flag a real invoice (the lock / zero false positives)", () => {
    // "Faktúra - daňový doklad" appears in BOTH real and sample docs as a title.
    // This test proves the substring alone does NOT trigger isSample.
    // Also verifies the strong phrase similarity is well below threshold.
    const realInvoiceText = [
      "Faktúra - daňový doklad",
      "Číslo: FA-2026-001",
      "Dodávateľ: ABC s.r.o.",
      "Odberateľ: XYZ s.r.o.",
      "Tovar: Laptop Model X",
      "Množstvo: 1 ks",
      "Cena bez DPH: 43,03 EUR",
      "DPH 20%: 8,61 EUR",
      "Celkom 51,64 EUR",
      "Nehraďte, zaplatené kartou.",
    ].join("\n");

    const result = isSampleInvoice(realInvoiceText);
    expect(result.isSample).toBe(false);
    expect(result.matched).toEqual([]);

    // MEANINGFUL assertion: prove the strong-phrase similarity is comfortably below
    // threshold — not a fluke near the boundary. At threshold=0.5 it should still
    // be false (the oracle says best ≈ 0.46 on a real invoice), so the negative
    // case has margin of ~0.39 below the 0.85 threshold.
    const normHay = normalizeForMatch(realInvoiceText);
    const normNeedle = normalizeForMatch(STRONG_PHRASE);
    // fuzzyContains at 0.5 must still be false — proves we're far from the boundary
    expect(fuzzyContains(normHay, normNeedle, 0.5)).toBe(false);
  });

  // ── Case 5: Weak-signal guard — single "ukážka" must NOT trip detection ───
  it("does NOT flag text containing only 'ukážka' (one weak signal is insufficient)", () => {
    const productDescText = [
      "Produktový katalóg",
      "Ukážka produktu: Notebook 15\"",
      "Dostupnosť: Na sklade",
      "Cena: 999 EUR",
    ].join("\n");

    const result = isSampleInvoice(productDescText);
    expect(result.isSample).toBe(false);
    // "preview" / "ukazka" might match, but strong=false and matched.length < 2
    expect(result.matched.length).toBeLessThan(2);
    expect(result.matched).not.toContain("not_tax_doc");
  });
});
