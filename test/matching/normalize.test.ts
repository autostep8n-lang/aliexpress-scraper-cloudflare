import { describe, expect, it } from "vitest";
import {
  canonicalGtin,
  cleanIdentifier,
  computeGtinCheckDigit,
  isValidGtin,
  isValidIsbn,
  jaccardSimilarity,
  levenshteinDistance,
  levenshteinSimilarity,
  longestCommonPrefix,
  longestToken,
  normalizeText,
  tokenize,
} from "../../src/matching/normalize";

/** Builds a deterministic valid GTIN of any supported length from a body of digits. */
function gtin(body: string): string {
  return body + computeGtinCheckDigit(body);
}

describe("normalizeText", () => {
  it("trims, collapses whitespace and lowercases", () => {
    expect(normalizeText("  SoundCore   Wireless  Earbuds ")).toBe("soundcore wireless earbuds");
  });
});

describe("tokenize", () => {
  it("splits on non-alphanumeric characters and lowercases", () => {
    expect(tokenize("Wireless Earbuds (2026) 2-Pack")).toEqual(["wireless", "earbuds", "2026", "2", "pack"]);
  });

  it("returns an empty array for empty input", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("cleanIdentifier", () => {
  it("uppercases and strips separators", () => {
    expect(cleanIdentifier("wh-1000xm4 ")).toBe("WH1000XM4");
    expect(cleanIdentifier(" 1234-5678 ")).toBe("12345678");
  });
});

describe("GTIN handling", () => {
  it("computes check digits deterministically", () => {
    expect(computeGtinCheckDigit("400638133393")).toBe("1");
    expect(computeGtinCheckDigit("123456789012")).toBe("8");
    expect(gtin("123456789012")).toBe("1234567890128");
  });

  it("accepts valid GTIN-13 values and rejects a corrupted check digit", () => {
    const valid = gtin("123456789012");
    expect(isValidGtin(valid)).toBe(true);
    const corrupted = valid.slice(0, -1) + (Number(valid[valid.length - 1]) === 9 ? "0" : "9");
    expect(isValidGtin(corrupted)).toBe(false);
  });

  it("rejects unsupported lengths and non-digit input", () => {
    expect(isValidGtin("123")).toBe(false);
    expect(isValidGtin("ABCDEFGHIJKLMN")).toBe(false);
    expect(isValidGtin("")).toBe(false);
  });

  it("accepts GTIN-8, GTIN-12 and GTIN-14 forms", () => {
    expect(isValidGtin(gtin("1234567"))).toBe(true);
    expect(isValidGtin(gtin("12345678901"))).toBe(true);
    expect(isValidGtin(gtin("1234567890123"))).toBe(true);
  });

  it("canonicalizes UPC/EAN/GTIN to a 14-digit form", () => {
    expect(canonicalGtin("1234567890128")).toBe("01234567890128");
    expect(canonicalGtin(gtin("123456789012"))).toBe(gtin("123456789012").padStart(14, "0"));
  });
});

describe("isValidIsbn", () => {
  it("accepts a valid ISBN-10 with an X check digit", () => {
    expect(isValidIsbn("0306406152")).toBe(true);
    expect(isValidIsbn("080442957X")).toBe(true);
  });

  it("rejects an invalid ISBN-10 check digit", () => {
    expect(isValidIsbn("0306406153")).toBe(false);
  });

  it("accepts a valid ISBN-13 and rejects a corrupted one", () => {
    const valid = gtin("978030640615");
    expect(isValidIsbn(valid)).toBe(true);
    const corrupted = valid.slice(0, -1) + "0";
    expect(isValidIsbn(corrupted)).toBe(false);
  });

  it("rejects wrong lengths", () => {
    expect(isValidIsbn("12345")).toBe(false);
  });
});

describe("edit distance utilities", () => {
  it("computes Levenshtein distance", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("", "")).toBe(0);
    expect(levenshteinDistance("abc", "abc")).toBe(0);
  });

  it("normalizes Levenshtein similarity to [0,1]", () => {
    expect(levenshteinSimilarity("abc", "abc")).toBe(1);
    expect(levenshteinSimilarity("", "")).toBe(1);
    expect(levenshteinSimilarity("abc", "abcd")).toBeCloseTo(0.75);
  });

  it("computes longest common prefix", () => {
    expect(longestCommonPrefix("B0CXD", "B0C")).toBe(3);
    expect(longestCommonPrefix("WH-1000XM4", "WH-1000XM5")).toBe(9);
    expect(longestCommonPrefix("abc", "xyz")).toBe(0);
  });

  it("computes Jaccard similarity", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
    expect(jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
  });

  it("finds the longest token above a length floor", () => {
    expect(longestToken(["a", "wireless", "earbuds"], 4)).toBe("wireless");
    expect(longestToken(["a", "bc"], 4)).toBeNull();
    expect(longestToken([], 4)).toBeNull();
  });
});
