import { describe, expect, it } from "vitest";
import { computeGtinCheckDigit } from "../../src/matching/normalize";
import { decideMerge, matchSignals } from "../../src/matching/match";
import { buildSignalsFromProduct, type ProductSignals } from "../../src/matching/signals";

function gtin(body: string): string {
  return body + computeGtinCheckDigit(body);
}

const VALID_GTIN = gtin("123456789012");

function make(overrides: Partial<ProductSignals> & { title: string }): ProductSignals {
  return {
    title: overrides.title,
    titleTokens: overrides.titleTokens ?? [],
    brand: overrides.brand ?? null,
    identifiers: overrides.identifiers ?? [],
    variantTokens: overrides.variantTokens ?? [],
    categoryPath: overrides.categoryPath ?? [],
    hasIdentifier: overrides.hasIdentifier ?? (overrides.identifiers?.length ?? 0) > 0,
  };
}

function fromProduct(overrides: { title: string; attributes?: Record<string, string> }): ProductSignals {
  return buildSignalsFromProduct(overrides);
}

function expectMerge(a: ProductSignals, b: ProductSignals): void {
  const match = matchSignals(a, b);
  expect(match.blocked).toBeNull();
  expect(decideMerge(a, match)).toBe(true);
  expect(match.confidence).toBeGreaterThanOrEqual(0);
  expect(match.confidence).toBeLessThanOrEqual(1);
}

function expectNoMerge(a: ProductSignals, b: ProductSignals, reason?: string): void {
  const match = matchSignals(a, b);
  if (reason) expect(match.blocked).toBe(reason);
  expect(decideMerge(a, match)).toBe(false);
}

describe("true positives", () => {
  it("merges the same GTIN across sources regardless of title wording", () => {
    const a = fromProduct({ title: "SoundCore Wireless Earbuds", attributes: { brand: "SoundCore", gtin: VALID_GTIN } });
    const b = fromProduct({ title: "SoundCore Wireless Earbuds Pro", attributes: { brand: "SoundCore", gtin: VALID_GTIN } });
    const match = matchSignals(a, b);
    expect(match.relation).toBe("exact");
    expect(match.confidence).toBeGreaterThanOrEqual(0.95);
    expectMerge(a, b);
  });

  it("merges the same GTIN even when variant capture differs between sources", () => {
    const a = fromProduct({ title: "SoundCore Earbuds", attributes: { brand: "SoundCore", gtin: VALID_GTIN, color: "black" } });
    const b = fromProduct({ title: "SoundCore Earbuds", attributes: { brand: "SoundCore", gtin: VALID_GTIN } });
    expectMerge(a, b);
  });

  it("merges the same MPN across sources", () => {
    const a = fromProduct({ title: "Acme Widget 3000", attributes: { brand: "Acme", mpn: "MPN1234" } });
    const b = fromProduct({ title: "Acme Widget 3000 Deluxe", attributes: { brand: "Acme", mpn: "MPN1234" } });
    const match = matchSignals(a, b);
    expect(match.relation).toBe("exact");
    expectMerge(a, b);
  });

  it("merges a strict parent-prefix SKU when the title agrees", () => {
    const a = fromProduct({ title: "Acme Widget", attributes: { brand: "Acme", sku: "ABC12345" } });
    const b = fromProduct({ title: "Acme Widget", attributes: { brand: "Acme", sku: "ABC123" } });
    const match = matchSignals(a, b);
    expect(match.relation).toBe("parent");
    expectMerge(a, b);
  });

  it("merges the same model + brand with comparable titles", () => {
    const a = fromProduct({ title: "Sony WH-1000XM4 Wireless Headphones", attributes: { brand: "Sony", model: "WH-1000XM4" } });
    const b = fromProduct({ title: "Sony WH-1000XM4 Headphones", attributes: { brand: "Sony", model: "WH-1000XM4" } });
    const match = matchSignals(a, b);
    expect(match.relation).toBe("exact");
    expectMerge(a, b);
  });

  it("merges near-identical titles when neither side has an identifier", () => {
    const a = fromProduct({ title: "USB-C Cable 3ft", attributes: { brand: "Acme" } });
    const b = fromProduct({ title: "USB-C Cable 3ft", attributes: { brand: "Acme" } });
    expectMerge(a, b);
  });
});

describe("false positives", () => {
  it("never merges different brands", () => {
    const a = fromProduct({ title: "Apple AirPods", attributes: { brand: "Apple" } });
    const b = fromProduct({ title: "Samsung Galaxy Buds", attributes: { brand: "Samsung" } });
    expectNoMerge(a, b, "brand_conflict");
  });

  it("never merges the same brand on different models", () => {
    const a = fromProduct({ title: "Sony WH-1000XM4", attributes: { brand: "Sony", model: "WH-1000XM4" } });
    const b = fromProduct({ title: "Sony WH-1000XM5", attributes: { brand: "Sony", model: "WH-1000XM5" } });
    expectNoMerge(a, b, "model_conflict");
  });

  it("never merges the same model in distinct colors", () => {
    const a = fromProduct({ title: "Sony WH-1000XM4", attributes: { brand: "Sony", model: "WH-1000XM4", color: "black" } });
    const b = fromProduct({ title: "Sony WH-1000XM4", attributes: { brand: "Sony", model: "WH-1000XM4", color: "white" } });
    expectNoMerge(a, b, "variant_conflict");
  });

  it("never merges 32GB and 64GB variants", () => {
    const a = fromProduct({ title: "Pad Tablet 32GB", attributes: { brand: "Pad", model: "TAB-X", capacity: "32GB" } });
    const b = fromProduct({ title: "Pad Tablet 64GB", attributes: { brand: "Pad", model: "TAB-X", capacity: "64GB" } });
    expectNoMerge(a, b, "variant_conflict");
  });

  it("never merges identical titles that differ only by color", () => {
    const a = fromProduct({ title: "Wireless Earbuds", attributes: { brand: "SoundCore", color: "black" } });
    const b = fromProduct({ title: "Wireless Earbuds", attributes: { brand: "SoundCore", color: "white" } });
    expectNoMerge(a, b, "variant_conflict");
  });

  it("does not merge near-identical titles without identifiers", () => {
    const a = fromProduct({ title: "Wireless Earbuds", attributes: { brand: "SoundCore" } });
    const b = fromProduct({ title: "Wireless Earbuds Pro", attributes: { brand: "SoundCore" } });
    expectNoMerge(a, b);
  });

  it("never merges 2-pack and 4-pack bundles", () => {
    const a = fromProduct({ title: "Socks (2-Pack)", attributes: { brand: "Hanes" } });
    const b = fromProduct({ title: "Socks (4-Pack)", attributes: { brand: "Hanes" } });
    expectNoMerge(a, b, "variant_conflict");
  });

  it("treats a short shared SKU prefix as no identifier signal", () => {
    const a = fromProduct({ title: "Acme B0CXX1", attributes: { sku: "B0CXX1" } });
    const b = fromProduct({ title: "Acme B0CXY2", attributes: { sku: "B0CXY2" } });
    const match = matchSignals(a, b);
    expect(match.identifierScore).toBe(0);
    expect(match.relation).toBe("none");
    expect(decideMerge(a, match)).toBe(false);
  });
});

describe("variants", () => {
  it("allows a merge when one source captures a superset of variant detail", () => {
    const a = fromProduct({ title: "Sony WH-1000XM4", attributes: { brand: "Sony", model: "WH-1000XM4", color: "black" } });
    const b = fromProduct({
      title: "Sony WH-1000XM4",
      attributes: { brand: "Sony", model: "WH-1000XM4", color: "black", size: "M" },
    });
    const match = matchSignals(a, b);
    expect(match.blocked).toBeNull();
    expectMerge(a, b);
  });

  it("treats 128GB against 128GB+256GB as compatible (subset)", () => {
    const a = fromProduct({ title: "Pad Tablet 128GB", attributes: { brand: "Pad", model: "TAB-X", capacity: "128GB" } });
    const b = fromProduct({
      title: "Pad Tablet 128GB + 256GB",
      attributes: { brand: "Pad", model: "TAB-X", capacity: "128GB", storage: "256GB" },
    });
    expect(matchSignals(a, b).blocked).toBeNull();
  });
});

describe("confidence sanity", () => {
  it("reports finite in-range confidence for divergent products", () => {
    const a = fromProduct({ title: "Toaster 4 Slice", attributes: { brand: "Breville" } });
    const b = fromProduct({ title: "Espresso Machine", attributes: { brand: "DeLonghi" } });
    const match = matchSignals(a, b);
    expect(match.confidence).toBeGreaterThanOrEqual(0);
    expect(match.confidence).toBeLessThanOrEqual(1);
    expect(decideMerge(a, match)).toBe(false);
  });

  it("handles the degenerate empty-title candidate without throwing", () => {
    const a = fromProduct({ title: "Product Name" });
    const b = make({ title: "Product Name", titleTokens: [], hasIdentifier: false });
    const match = matchSignals(a, b);
    expect(Number.isFinite(match.confidence)).toBe(true);
  });
});
