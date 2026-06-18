/**
 * Alza sample-invoice detector.
 *
 * Alza serves a watermarked "preview/sample" PDF from the invoice download
 * link before goods are picked up. This file is NOT a tax document — it must
 * never be ingested into Paperless.
 *
 * Two exports: a PURE matcher (isSampleInvoice) tested on strings, and a thin
 * IMPURE extractor (extractPdfText) that shells pdftotext. The extractor is
 * kept separate so the unit suite can run without poppler-utils.
 *
 * Dependency: levenshtein() from fuzzy-match.ts (Task 1, commit 91aa3c2).
 */

import { levenshtein } from "../fuzzy-match";

// ---------------------------------------------------------------------------
// Signatures (watermark phrases that appear only in sample PDFs)
// ---------------------------------------------------------------------------

const THRESHOLD = 0.85;

const SIGNATURES = [
  { id: "not_tax_doc", phrase: "nemožno použiť ako daňový doklad", strong: true },
  { id: "not_issued",  phrase: "nie je vydaný",                    strong: false },
  { id: "preview",     phrase: "ukážka",                           strong: false },
];

// ---------------------------------------------------------------------------
// PURE functions
// ---------------------------------------------------------------------------

/**
 * NFD → strip diacritics → lowercase → drop everything non-alphanumeric.
 * Result: one continuous a-z0-9 run (newlines/spaces/punct removed) so the
 * watermark phrase is contiguous even though pdftotext -raw splits its
 * glyphs across separate lines with no internal spaces.
 */
export function normalizeForMatch(s: string): string {
  return s.normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Best normalized-Levenshtein similarity of `needle` anywhere in `haystack`.
 * Slides a window of needle.length across haystack and returns the best sim.
 */
export function fuzzyContains(haystack: string, needle: string, threshold: number): boolean {
  const n = needle.length;
  if (n === 0 || haystack.length < n) return haystack.includes(needle);
  let best = 0;
  for (let i = 0; i + n <= haystack.length; i++) {
    const sim = 1 - levenshtein(haystack.slice(i, i + n), needle) / n;
    if (sim > best) best = sim;
    if (best === 1) break;
  }
  return best >= threshold;
}

/**
 * Determine whether extracted PDF text belongs to a sample/preview invoice.
 *
 * Returns `isSample: true` when:
 *  - The strong phrase ("nemožno použiť ako daňový doklad") matches, OR
 *  - At least 2 of the 3 signatures match.
 *
 * The single weak signal "ukážka" alone is insufficient — it can appear in
 * ordinary product descriptions.
 */
export function isSampleInvoice(text: string): { isSample: boolean; matched: string[] } {
  const hay = normalizeForMatch(text);
  const matched = SIGNATURES.filter(s => fuzzyContains(hay, normalizeForMatch(s.phrase), THRESHOLD));
  const strong = matched.some(s => s.strong);
  // strong phrase present OR >=2 of 3 signatures. `ukážka` alone never trips it.
  return { isSample: strong || matched.length >= 2, matched: matched.map(s => s.id) };
}

// ---------------------------------------------------------------------------
// IMPURE extractor (NOT in the default unit suite — requires poppler-utils)
// ---------------------------------------------------------------------------

/**
 * Returns the PDF text layer via `pdftotext -raw`. Returns "" on any failure
 * (non-zero exit, missing binary, no text layer) — caller treats "" as
 * "not a sample", so a broken extraction FAILS OPEN to the normal pipeline
 * and never silently drops a real invoice.
 */
export async function extractPdfText(filePath: string): Promise<string> {
  try {
    const proc = Bun.spawn(["pdftotext", "-raw", filePath, "-"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();   // UTF-8
    const code = await proc.exited;
    return code === 0 ? out : "";
  } catch {
    return "";
  }
}
