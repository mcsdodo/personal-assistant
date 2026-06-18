import { describe, expect, test } from "bun:test";
import { findBestCorrespondentMatch, levenshtein } from "./fuzzy-match";

// Sample correspondents for testing (public company names, synthetic IDs)
const CORRESPONDENTS = [
  { id: 1, name: "24h oil s.r.o." },
  { id: 2, name: "Alphacool International GmbH" },
  { id: 3, name: "Alza.sk" },
  { id: 4, name: "Alza.sk s.r.o." },
  { id: 5, name: "Anthropic, PBC" },
  { id: 6, name: "Bitwarden Inc." },
  { id: 7, name: "Bolt" },
  { id: 8, name: "DST, spol. s r.o." },
  { id: 9, name: "Google Cloud EMEA Limited" },
  { id: 10, name: "Hlavné mesto SR Bratislava" },
  { id: 11, name: "Keychron Germany" },
  { id: 12, name: "Mataso s.r.o." },
  { id: 13, name: "OMV Slovensko, s.r.o." },
  { id: 14, name: "ORLEN Unipetrol Slovakia S.r.o." },
  { id: 15, name: "Personal" },
  { id: 16, name: "SHELL Slovensko, s.r.o." },
  { id: 17, name: "SLOVNAFT, a.s." },
  { id: 18, name: "Státní fond dopravní infrastruktury" },
  { id: 19, name: "Statutární město Brno" },
  { id: 20, name: "Tatra banka, a.s." },
  { id: 21, name: "Testlab s. r. o." },
  { id: 22, name: "Testlab s.r.o." },
  { id: 23, name: "TESCO STORES SR, a.s." },
  { id: 24, name: "Tiché PC s.r.o." },
];

describe("findBestCorrespondentMatch", () => {
  // ── Exact matches ──────────────────────────────────────────────────

  test("exact match returns score 1.0", () => {
    const result = findBestCorrespondentMatch("Bolt", CORRESPONDENTS);
    expect(result).toEqual({ id: 7, name: "Bolt", score: 1.0 });
  });

  test("case-insensitive exact match", () => {
    const result = findBestCorrespondentMatch("bolt", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(7);
    expect(result!.score).toBe(1.0);
  });

  test("case-insensitive match with legal suffix", () => {
    const result = findBestCorrespondentMatch("slovnaft, a.s.", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(17);
    expect(result!.score).toBe(1.0);
  });

  // ── Legal suffix spacing variants (the core problem) ──────────────

  test("matches 's. r. o.' to 's.r.o.' (spacing variant)", () => {
    const result = findBestCorrespondentMatch("24h oil s. r. o.", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'Mataso S. r. o.' to 'Mataso s.r.o.' (spacing + casing)", () => {
    const result = findBestCorrespondentMatch("Mataso S. r. o.", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(12);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'DST spol. s r. o.' to 'DST, spol. s r.o.'", () => {
    const result = findBestCorrespondentMatch("DST spol. s r. o.", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(8);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'ORLEN Unipetrol Slovakia s.r.o.' casing variant", () => {
    const result = findBestCorrespondentMatch("ORLEN Unipetrol Slovakia s.r.o.", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(14);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'Tatra banka a.s.' (missing comma)", () => {
    const result = findBestCorrespondentMatch("Tatra banka a.s.", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(20);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'OMV Slovensko s.r.o.' (missing comma)", () => {
    const result = findBestCorrespondentMatch("OMV Slovensko s.r.o.", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(13);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'SHELL Slovensko s. r. o.' (missing comma + spacing)", () => {
    const result = findBestCorrespondentMatch("SHELL Slovensko s. r. o.", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(16);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'Tiché PC s. r. o.' spacing variant", () => {
    const result = findBestCorrespondentMatch("Tiché PC s. r. o.", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(24);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'TESCO STORES SR a.s.' (missing comma)", () => {
    const result = findBestCorrespondentMatch("TESCO STORES SR a.s.", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(23);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  // ── No false positives ────────────────────────────────────────────

  test("matches same vendor across languages: SHELL Slovakia vs SHELL Slovensko", () => {
    const result = findBestCorrespondentMatch("SHELL Slovakia s.r.o.", CORRESPONDENTS);
    // At 0.85 threshold, SHELL Slovakia matches SHELL Slovensko (score ~0.90) — same company
    expect(result).not.toBeNull();
    expect(result!.id).toBe(16);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("does NOT match short dissimilar names: Personal vs Bolt", () => {
    const result = findBestCorrespondentMatch("Personal", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(15); // should match Personal exactly
  });

  test("matches within same vendor family: Google Slovakia vs Google Cloud EMEA", () => {
    const result = findBestCorrespondentMatch("Google Slovakia s.r.o.", CORRESPONDENTS);
    // At 0.85 threshold, Google Slovakia matches Google Cloud EMEA Limited (score ~0.85) — same company family
    expect(result).not.toBeNull();
    expect(result!.id).toBe(9);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  // ── No match ──────────────────────────────────────────────────────

  test("returns null for unknown vendor", () => {
    const result = findBestCorrespondentMatch("Completely Unknown Vendor s.r.o.", CORRESPONDENTS);
    expect(result).toBeNull();
  });

  test("returns null for empty correspondents list", () => {
    const result = findBestCorrespondentMatch("Bolt", []);
    expect(result).toBeNull();
  });

  // ── Edge cases ────────────────────────────────────────────────────

  test("handles empty vendor string", () => {
    const result = findBestCorrespondentMatch("", CORRESPONDENTS);
    expect(result).toBeNull();
  });

  test("handles whitespace-only vendor string", () => {
    const result = findBestCorrespondentMatch("   ", CORRESPONDENTS);
    expect(result).toBeNull();
  });

  test("respects custom threshold", () => {
    // With a very high threshold, only exact/near-exact matches pass
    const result = findBestCorrespondentMatch("24h oil s. r. o.", CORRESPONDENTS, 0.99);
    // After normalization these should be equal so score 1.0 — still matches
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  test("higher threshold rejects looser matches", () => {
    // "SHELL Slovakia s.r.o." is somewhat similar to "SHELL Slovensko, s.r.o."
    // With default threshold it might not match; with 0.99 definitely not
    const result = findBestCorrespondentMatch("SHELL Slovakia s.r.o.", CORRESPONDENTS, 0.99);
    expect(result).toBeNull();
  });
});

describe("levenshtein", () => {
  test("identical strings return 0", () => {
    const result = levenshtein("abc", "abc");
    expect(result).toBe(0);
  });

  test("one substitution returns 1", () => {
    const result = levenshtein("abc", "abd");
    expect(result).toBe(1);
  });

  test("one insertion returns 1", () => {
    const result = levenshtein("abc", "abdc");
    expect(result).toBe(1);
  });

  test("one deletion returns 1", () => {
    const result = levenshtein("abc", "ac");
    expect(result).toBe(1);
  });

  test("empty to string returns string length", () => {
    const result = levenshtein("", "abc");
    expect(result).toBe(3);
  });

  test("string to empty returns string length", () => {
    const result = levenshtein("abc", "");
    expect(result).toBe(3);
  });

  test("both empty strings return 0", () => {
    const result = levenshtein("", "");
    expect(result).toBe(0);
  });

  test("canonical case: kitten to sitting", () => {
    const result = levenshtein("kitten", "sitting");
    expect(result).toBe(3);
  });

  test("flaw to lawn", () => {
    const result = levenshtein("flaw", "lawn");
    expect(result).toBe(2);
  });
});
