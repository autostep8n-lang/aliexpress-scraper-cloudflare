/**
 * Pure text / identifier normalization helpers shared by the matching module.
 *
 * Everything here is deterministic and side-effect free so the matcher can be
 * unit-tested without touching the database or the network.
 */

/** Whitespace collapsed, trimmed, lower-cased. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Lower-cased alphanumeric tokens, empty tokens removed. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

/** Uppercased alphanumeric-only identifier, separators removed. */
export function cleanIdentifier(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** GTIN family canonical form: zero-padded to 14 digits (UPC/EAN/GTIN-8 all map here). */
export function canonicalGtin(value: string): string {
  return value.replace(/\D/g, "").padStart(14, "0");
}

/**
 * GTIN / EAN / UPC check digit for a body of 7, 11, 12 or 13 digits.
 * Weights alternate 3,1 from the rightmost body digit.
 */
export function computeGtinCheckDigit(body: string): string {
  const digits = body.replace(/\D/g, "");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = Number(digits[digits.length - 1 - i]);
    const weight = i % 2 === 0 ? 3 : 1;
    sum += digit * weight;
  }
  return String((10 - (sum % 10)) % 10);
}

/** Validates a GTIN/UPC/EAN of length 8, 12, 13 or 14 including its check digit. */
export function isValidGtin(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  if (!/^\d+$/.test(digits)) return false;
  return computeGtinCheckDigit(digits.slice(0, -1)) === digits[digits.length - 1];
}

/** Validates an ISBN-10 (with X check digit) or ISBN-13 (EAN check digit). */
export function isValidIsbn(value: string): boolean {
  const upper = value.toUpperCase();
  if (!/^\d{9}[\dX]$/.test(upper) && !/^\d{13}$/.test(upper)) return false;
  if (upper.length === 10) {
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(upper[i]) * (10 - i);
    const check = upper[9] === "X" ? 10 : Number(upper[9]);
    return (sum + check) % 11 === 0;
  }
  return isValidGtin(upper);
}

/** Length of the shared prefix between two strings. */
export function longestCommonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

/** Classic Levenshtein edit distance (iterative, O(n*m)). */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

/** Levenshtein similarity normalized to [0,1] (1 = identical). */
export function levenshteinSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshteinDistance(a, b) / max;
}

/** Jaccard similarity of two sets; both empty counts as identical. */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/** Longest token of at least `minLength` characters, or null when none qualify. */
export function longestToken(tokens: readonly string[], minLength: number): string | null {
  let best: string | null = null;
  for (const token of tokens) {
    if (token.length < minLength) continue;
    if (!best || token.length > best.length) best = token;
  }
  return best;
}
