/**
 * Fuzzy correspondent matching — finds the best-matching Paperless correspondent
 * for a vendor name, handling legal suffix spacing variants (s.r.o. vs s. r. o.)
 * and minor formatting differences from non-deterministic LLM output.
 */

export interface CorrespondentMatch {
  id: number;
  name: string;
  score: number;
}

const LEGAL_SUFFIX_RE =
  /[, ]*(s\.r\.o\.|spol\.\s*s\s*r\.o\.|a\.s\.|k\.s\.|v\.o\.s\.|gmbh|inc\.|ltd\.?|pbc|limited)\s*$/;

/**
 * Normalize a company name for comparison:
 * - lowercase
 * - collapse legal suffix spacing (s. r. o. → s.r.o., a. s. → a.s.)
 * - remove commas before legal suffixes
 * - trim whitespace
 */
export function normalizeName(name: string): string {
  let n = name.toLowerCase().trim();

  // Collapse spaced legal suffixes: "s. r. o." → "s.r.o.", "a. s." → "a.s."
  n = n.replace(/s\.\s*r\.\s*o\./g, "s.r.o.");
  n = n.replace(/a\.\s*s\./g, "a.s.");
  n = n.replace(/k\.\s*s\./g, "k.s.");
  n = n.replace(/v\.\s*o\.\s*s\./g, "v.o.s.");
  // "spol. s r. o." → "spol. s r.o."
  n = n.replace(/spol\.\s*s\s+r\.\s*o\./g, "spol. s r.o.");

  // Remove comma before legal suffix: "SLOVNAFT, a.s." → "SLOVNAFT a.s."
  n = n.replace(/,\s*(s\.r\.o\.|spol\.\s*s\s*r\.o\.|a\.s\.|k\.s\.|v\.o\.s\.|gmbh|inc\.|ltd\.|pbc)/g, " $1");

  // Collapse multiple spaces
  n = n.replace(/\s+/g, " ").trim();

  return n;
}

/**
 * Strip legal suffix to get the core company name for comparison.
 * This prevents suffixes from inflating similarity scores between
 * genuinely different companies (e.g. "SHELL Slovakia" vs "SHELL Slovensko").
 */
export function stripLegalSuffix(normalized: string): string {
  return normalized.replace(LEGAL_SUFFIX_RE, "").trim();
}

/**
 * Jaro-Winkler similarity between two strings.
 * Returns a value between 0 (no similarity) and 1 (identical).
 */
export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  const matchWindow = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);

  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

  // Winkler bonus for common prefix (up to 4 chars)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Find the best matching correspondent for a vendor name.
 *
 * Strategy:
 * 1. Normalize both names (collapse suffix spacing, lowercase, strip commas)
 * 2. If normalized strings match exactly → score 1.0
 * 3. Otherwise strip legal suffixes and compare core names with Jaro-Winkler
 *    (suffixes like s.r.o. inflate scores between genuinely different vendors)
 * 4. Return best match above threshold, or null
 */
export function findBestCorrespondentMatch(
  vendor: string,
  correspondents: Array<{ id: number; name: string }>,
  threshold: number = 0.92,
): CorrespondentMatch | null {
  if (!vendor || !vendor.trim() || correspondents.length === 0) return null;

  const normalizedVendor = normalizeName(vendor);
  if (!normalizedVendor) return null;

  const coreVendor = stripLegalSuffix(normalizedVendor);

  let bestMatch: CorrespondentMatch | null = null;

  for (const c of correspondents) {
    const normalizedC = normalizeName(c.name);

    let score: number;
    if (normalizedVendor === normalizedC) {
      // Exact match after normalization (handles suffix spacing variants)
      score = 1.0;
    } else {
      // Compare core names without legal suffixes
      const coreC = stripLegalSuffix(normalizedC);
      score = jaroWinkler(coreVendor, coreC);
    }

    if (score >= threshold && (bestMatch === null || score > bestMatch.score)) {
      bestMatch = { id: c.id, name: c.name, score };
    }
  }

  return bestMatch;
}
