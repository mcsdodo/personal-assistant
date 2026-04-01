import { describe, expect, test } from "bun:test";
import { findBestCorrespondentMatch } from "./fuzzy-match";

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

  test("does NOT match genuinely different vendors: SHELL Slovakia vs SHELL Slovensko", () => {
    const result = findBestCorrespondentMatch("SHELL Slovakia s.r.o.", CORRESPONDENTS);
    // Should NOT match SHELL Slovensko (id:16) — different entities
    if (result) {
      expect(result.id).not.toBe(16);
    }
  });

  test("does NOT match short dissimilar names: Personal vs Bolt", () => {
    const result = findBestCorrespondentMatch("Personal", CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(15); // should match Personal exactly
  });

  test("does NOT match across different vendor families", () => {
    const result = findBestCorrespondentMatch("Google Slovakia s.r.o.", CORRESPONDENTS);
    // Should NOT match Google Cloud EMEA Limited
    if (result) {
      expect(result.id).not.toBe(9);
    }
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
