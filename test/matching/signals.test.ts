import { describe, expect, it } from "vitest";
import { computeGtinCheckDigit } from "../../src/matching/normalize";
import {
  buildSignalsFromProduct,
  buildSignalsFromRow,
  deriveFingerprint,
  extractBrand,
  extractIdentifiers,
  extractVariantTokens,
  parseFingerprintKey,
} from "../../src/matching/signals";

function gtin(body: string): string {
  return body + computeGtinCheckDigit(body);
}

const VALID_GTIN = gtin("123456789012");
const CANONICAL_GTIN = VALID_GTIN.padStart(14, "0");

describe("extractIdentifiers", () => {
  it("extracts a valid GTIN from attributes and canonicalizes it", () => {
    const ids = extractIdentifiers({ gtin: VALID_GTIN }, null);
    expect(ids).toEqual([{ type: "gtin", value: CANONICAL_GTIN }]);
  });

  it("maps upc / ean / barcode keys to the gtin family", () => {
    expect(extractIdentifiers({ upc: VALID_GTIN }, null).map((i) => i.type)).toEqual(["gtin"]);
    expect(extractIdentifiers({ ean: VALID_GTIN }, null).map((i) => i.type)).toEqual(["gtin"]);
  });

  it("rejects identifiers that fail sanity checks", () => {
    expect(extractIdentifiers({ gtin: "not-a-gtin" }, null)).toEqual([]);
    expect(extractIdentifiers({ sku: "AB" }, null)).toEqual([]);
    expect(extractIdentifiers({ model: "X" }, null)).toEqual([]);
  });

  it("extracts mpn, model and sku with cleaned values", () => {
    const ids = extractIdentifiers({ mpn: "MPN-1234", model: "wh-1000xm4", sku: "SKU-99-X" }, null);
    expect(ids).toEqual([
      { type: "mpn", value: "MPN1234" },
      { type: "model", value: "WH1000XM4" },
      { type: "sku", value: "SKU99X" },
    ]);
  });

  it("reads a stored fingerprint from dedup_key when attributes carry no identifier", () => {
    const ids = extractIdentifiers({}, `model:AB100`);
    expect(ids).toEqual([{ type: "model", value: "AB100" }]);
  });

  it("does not duplicate an identifier present in both attributes and dedup_key", () => {
    const ids = extractIdentifiers({ model: "AB100" }, `model:AB100`);
    expect(ids).toHaveLength(1);
  });
});

describe("parseFingerprintKey", () => {
  it("parses a plain fingerprint", () => {
    expect(parseFingerprintKey(`gtin:${CANONICAL_GTIN}`)).toEqual({ type: "gtin", value: CANONICAL_GTIN });
  });

  it("strips the variant signature suffix", () => {
    expect(parseFingerprintKey("model:AB100|black,color:black")).toEqual({ type: "model", value: "AB100" });
  });

  it("returns null for platform-keyed dedup keys", () => {
    expect(parseFingerprintKey("aliexpress:1005001")).toBeNull();
    expect(parseFingerprintKey(null)).toBeNull();
  });
});

describe("deriveFingerprint", () => {
  it("prefers gtin over weaker identifiers", () => {
    const ids = extractIdentifiers({ gtin: VALID_GTIN, model: "AB100" }, null);
    expect(deriveFingerprint(ids, [])).toBe(`gtin:${CANONICAL_GTIN}`);
  });

  it("uses mpn before model and model before sku", () => {
    expect(deriveFingerprint(extractIdentifiers({ mpn: "M1234", model: "AB100" }, null), [])).toBe("mpn:M1234");
    expect(deriveFingerprint(extractIdentifiers({ model: "AB100", sku: "S1234" }, null), [])).toBe("model:AB100");
  });

  it("returns null when there are no identifiers", () => {
    expect(deriveFingerprint([], [])).toBeNull();
  });

  it("does not add a variant signature to gtin fingerprints", () => {
    expect(deriveFingerprint(extractIdentifiers({ gtin: VALID_GTIN }, null), ["color:black"])).toBe(`gtin:${CANONICAL_GTIN}`);
  });

  it("adds a sorted variant signature to model fingerprints", () => {
    expect(deriveFingerprint(extractIdentifiers({ model: "AB100" }, null), ["black", "color:black"])).toBe(
      "model:AB100|black,color:black",
    );
  });

  it("leaves the fingerprint bare when no variant tokens exist", () => {
    expect(deriveFingerprint(extractIdentifiers({ sku: "S1234" }, null), [])).toBe("sku:S1234");
  });
});

describe("extractBrand", () => {
  it("normalizes the brand value", () => {
    expect(extractBrand({ brand: "  SoundCore  " })).toBe("soundcore");
  });

  it("falls back to manufacturer then make", () => {
    expect(extractBrand({ manufacturer: "Sony" })).toBe("sony");
    expect(extractBrand({ make: "Toyota" })).toBe("toyota");
  });

  it("returns null when absent", () => {
    expect(extractBrand({})).toBeNull();
    expect(extractBrand(undefined)).toBeNull();
  });
});

describe("extractVariantTokens", () => {
  it("collects color and size from attributes (keyed and bare)", () => {
    const tokens = extractVariantTokens({ color: "Black", size: "M" }, "");
    expect(tokens).toContain("color:black");
    expect(tokens).toContain("black");
    expect(tokens).toContain("size:m");
  });

  it("collects numeric capacity attributes", () => {
    const tokens = extractVariantTokens({ capacity: "32GB" }, "");
    expect(tokens).toContain("32gb");
    expect(tokens).toContain("capacity:32gb");
  });

  it("parses spec and pack tokens from the title", () => {
    const tokens = extractVariantTokens({}, "iPhone 15 128GB (2-Pack)");
    expect(tokens).toContain("128gb");
    expect(tokens).toContain("2pack");
  });

  it("parses a trailing 'pack of N' phrase from the title", () => {
    const tokens = extractVariantTokens({}, "Socks, Pack of 4");
    expect(tokens).toContain("pack4");
  });

  it("recognizes color words in the title", () => {
    const tokens = extractVariantTokens({}, "Sony WH-1000XM4 (Black)");
    expect(tokens).toContain("black");
  });
});

describe("buildSignalsFromProduct", () => {
  it("derives categoryPath from the deepest explicit path else the category name", () => {
    const withPath = buildSignalsFromProduct({ title: "T", category: { name: "Audio", path: ["Electronics", "Audio"] } });
    expect(withPath.categoryPath).toEqual(["Electronics", "Audio"]);
    const withName = buildSignalsFromProduct({ title: "T", category: { name: "Audio" } });
    expect(withName.categoryPath).toEqual(["Audio"]);
  });

  it("flags hasIdentifier based on valid identifiers only", () => {
    const valid = buildSignalsFromProduct({ title: "T", attributes: { gtin: gtin("123456789012") } });
    expect(valid.hasIdentifier).toBe(true);
    const invalid = buildSignalsFromProduct({ title: "T", attributes: { gtin: "garbage" } });
    expect(invalid.hasIdentifier).toBe(false);
  });
});

describe("buildSignalsFromRow", () => {
  it("rebuilds identifiers from attributes and a stored fingerprint", () => {
    const signals = buildSignalsFromRow({
      title: "Widget",
      brand: "Acme",
      attributes: { gtin: VALID_GTIN },
      dedup_key: "model:AB100",
    });
    expect(signals.identifiers).toEqual([{ type: "gtin", value: CANONICAL_GTIN }, { type: "model", value: "AB100" }]);
    expect(signals.brand).toBe("acme");
    expect(signals.hasIdentifier).toBe(true);
  });

  it("tolerates missing or non-object attributes", () => {
    const signals = buildSignalsFromRow({ title: "Widget", brand: null, attributes: null, dedup_key: null });
    expect(signals.identifiers).toEqual([]);
    expect(signals.hasIdentifier).toBe(false);
  });
});
