import { describe, expect, test } from "bun:test";
import { findBestCorrespondentMatch } from "./fuzzy-match";

// Real correspondents from production Paperless (2026-03-29)
const REAL_CORRESPONDENTS = [
  { id: 20, name: "24h oil s.r.o." },
  { id: 22, name: "Alphacool International GmbH" },
  { id: 10, name: "Alza.sk" },
  { id: 11, name: "Alza.sk s.r.o." },
  { id: 26, name: "Anthropic, PBC" },
  { id: 15, name: "Bitwarden Inc." },
  { id: 4, name: "Bolt" },
  { id: 14, name: "DST, spol. s r.o." },
  { id: 19, name: "Google Cloud EMEA Limited" },
  { id: 7, name: "Hlavné mesto SR Bratislava" },
  { id: 28, name: "Keychron Germany" },
  { id: 5, name: "Mataso s.r.o." },
  { id: 17, name: "OMV Slovensko, s.r.o." },
  { id: 27, name: "ORLEN Unipetrol Slovakia S.r.o." },
  { id: 2, name: "Personal" },
  { id: 29, name: "SHELL Slovensko, s.r.o." },
  { id: 12, name: "SLOVNAFT, a.s." },
  { id: 24, name: "Státní fond dopravní infrastruktury" },
  { id: 23, name: "Statutární město Brno" },
  { id: 16, name: "Tatra banka, a.s." },
  { id: 21, name: "Techlab s. r. o." },
  { id: 13, name: "Techlab s.r.o." },
  { id: 25, name: "TESCO STORES SR, a.s." },
  { id: 18, name: "Tiché PC s.r.o." },
];

describe("findBestCorrespondentMatch", () => {
  // ── Exact matches ──────────────────────────────────────────────────

  test("exact match returns score 1.0", () => {
    const result = findBestCorrespondentMatch("Bolt", REAL_CORRESPONDENTS);
    expect(result).toEqual({ id: 4, name: "Bolt", score: 1.0 });
  });

  test("case-insensitive exact match", () => {
    const result = findBestCorrespondentMatch("bolt", REAL_CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(4);
    expect(result!.score).toBe(1.0);
  });

  test("case-insensitive match with legal suffix", () => {
    const result = findBestCorrespondentMatch("slovnaft, a.s.", REAL_CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(12);
    expect(result!.score).toBe(1.0);
  });

  // ── Legal suffix spacing variants (the core problem) ──────────────

  test("matches 's. r. o.' to 's.r.o.' (spacing variant)", () => {
    const result = findBestCorrespondentMatch("24h oil s. r. o.", REAL_CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(20);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'Mataso S. r. o.' to 'Mataso s.r.o.' (spacing + casing)", () => {
    const result = findBestCorrespondentMatch("Mataso S. r. o.", REAL_CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(5);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'DST spol. s r. o.' to 'DST, spol. s r.o.'", () => {
    const result = findBestCorrespondentMatch("DST spol. s r. o.", REAL_CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(14);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'ORLEN Unipetrol Slovakia s.r.o.' casing variant", () => {
    const result = findBestCorrespondentMatch("ORLEN Unipetrol Slovakia s.r.o.", REAL_CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(27);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'Tatra banka a.s.' (missing comma)", () => {
    const result = findBestCorrespondentMatch("Tatra banka a.s.", REAL_CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(16);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'OMV Slovensko s.r.o.' (missing comma)", () => {
    const result = findBestCorrespondentMatch("OMV Slovensko s.r.o.", REAL_CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(17);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'SHELL Slovensko s. r. o.' (missing comma + spacing)", () => {
    const result = findBestCorrespondentMatch("SHELL Slovensko s. r. o.", REAL_CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(29);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'Tiché PC s. r. o.' spacing variant", () => {
    const result = findBestCorrespondentMatch("Tiché PC s. r. o.", REAL_CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(18);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  test("matches 'TESCO STORES SR a.s.' (missing comma)", () => {
    const result = findBestCorrespondentMatch("TESCO STORES SR a.s.", REAL_CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(25);
    expect(result!.score).toBeGreaterThan(0.85);
  });

  // ── No false positives ────────────────────────────────────────────

  test("does NOT match genuinely different vendors: SHELL Slovakia vs SHELL Slovensko", () => {
    const result = findBestCorrespondentMatch("SHELL Slovakia s.r.o.", REAL_CORRESPONDENTS);
    // Should NOT match SHELL Slovensko (id:29) — different entities
    if (result) {
      expect(result.id).not.toBe(29);
    }
  });

  test("does NOT match short dissimilar names: Personal vs Bolt", () => {
    const result = findBestCorrespondentMatch("Personal", REAL_CORRESPONDENTS);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(2); // should match Personal exactly
  });

  test("does NOT match across different vendor families", () => {
    const result = findBestCorrespondentMatch("Google Slovakia s.r.o.", REAL_CORRESPONDENTS);
    // Should NOT match Google Cloud EMEA Limited
    if (result) {
      expect(result.id).not.toBe(19);
    }
  });

  // ── No match ──────────────────────────────────────────────────────

  test("returns null for unknown vendor", () => {
    const result = findBestCorrespondentMatch("Completely Unknown Vendor s.r.o.", REAL_CORRESPONDENTS);
    expect(result).toBeNull();
  });

  test("returns null for empty correspondents list", () => {
    const result = findBestCorrespondentMatch("Bolt", []);
    expect(result).toBeNull();
  });

  // ── Edge cases ────────────────────────────────────────────────────

  test("handles empty vendor string", () => {
    const result = findBestCorrespondentMatch("", REAL_CORRESPONDENTS);
    expect(result).toBeNull();
  });

  test("handles whitespace-only vendor string", () => {
    const result = findBestCorrespondentMatch("   ", REAL_CORRESPONDENTS);
    expect(result).toBeNull();
  });

  test("respects custom threshold", () => {
    // With a very high threshold, only exact/near-exact matches pass
    const result = findBestCorrespondentMatch("24h oil s. r. o.", REAL_CORRESPONDENTS, 0.99);
    // After normalization these should be equal so score 1.0 — still matches
    expect(result).not.toBeNull();
    expect(result!.id).toBe(20);
  });

  test("higher threshold rejects looser matches", () => {
    // "SHELL Slovakia s.r.o." is somewhat similar to "SHELL Slovensko, s.r.o."
    // With default threshold it might not match; with 0.99 definitely not
    const result = findBestCorrespondentMatch("SHELL Slovakia s.r.o.", REAL_CORRESPONDENTS, 0.99);
    expect(result).toBeNull();
  });
});
