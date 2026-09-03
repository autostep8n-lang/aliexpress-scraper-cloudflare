import { describe, expect, it } from "vitest";
import { DEFAULT_KEYS, enrichProduct } from "../src/products/enrich";
import { normalizeProduct } from "../src/products/normalize";
import { validateProduct } from "../src/products/validation";
import type { Product } from "../src/products/types";

const PRODUCT_URL = "https://www.aliexpress.com/item/1005001.html";

function baseRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalId: "1005001",
    title: "Wireless Earbuds",
    price: { amount: "19.99", currency: "usd" },
    ...overrides,
  };
}

describe("enrichProduct", () => {
  it("enriches description from an alternative key", () => {
    const product = enrichProduct({
      raw: baseRaw({ summary: "  Noise cancelling earbuds with long battery  " }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.description).toBe("Noise cancelling earbuds with long battery");
  });

  it("enriches category from a categoryName string", () => {
    const product = enrichProduct({
      raw: baseRaw({ categoryName: "Electronics" }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.category).toEqual({ name: "Electronics" });
  });

  it("enriches category from a categories array using the first parseable entry", () => {
    const product = enrichProduct({
      raw: baseRaw({ categories: ["", { id: "c2", name: "Audio", path: ["Electronics", "Audio"] }] }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.category).toEqual({ id: "c2", name: "Audio", path: ["Electronics", "Audio"] });
  });

  it("enriches rating from a numeric value", () => {
    const product = enrichProduct({
      raw: baseRaw({ rating: 4.5 }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.rating).toEqual({ average: 4.5 });
  });

  it("enriches rating from a numeric-string value", () => {
    const product = enrichProduct({
      raw: baseRaw({ ratingSummary: "4.7" }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.rating).toEqual({ average: 4.7 });
  });

  it("enriches shipping from a boolean free flag", () => {
    const product = enrichProduct({
      raw: baseRaw({ delivery: true }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.shipping).toEqual({ free: true });
  });

  it("enriches shipping cost using the raw currency", () => {
    const product = enrichProduct({
      raw: baseRaw({ delivery: "5.5", currency: "usd" }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.shipping).toEqual({ cost: { amount: 5.5, currency: "USD" } });
  });

  it("enriches shipping from an object", () => {
    const product = enrichProduct({
      raw: baseRaw({ shipmentInfo: { free: false, deliveryMinDays: 3, deliveryMaxDays: 7, fromCountry: "CN" } }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.shipping).toEqual({ free: false, deliveryMinDays: 3, deliveryMaxDays: 7, fromCountry: "CN" });
  });

  it("enriches attributes from a specs object", () => {
    const product = enrichProduct({
      raw: baseRaw({ specs: { color: "black", battery: "30h" } }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.attributes).toEqual({ color: "black", battery: "30h" });
  });

  it("enriches attributes from a name/value array", () => {
    const product = enrichProduct({
      raw: baseRaw({ variants: [{ name: "Size", value: "M" }, { name: "Color", value: "Blue" }] }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.attributes).toEqual({ Size: "M", Color: "Blue" });
  });

  it("enriches availability from an inStock boolean", () => {
    const product = enrichProduct({
      raw: baseRaw({ inStock: true }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.available).toBe(true);
  });

  it("enriches availability from a stock string", () => {
    const product = enrichProduct({
      raw: baseRaw({ stock: "0" }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.available).toBe(false);
  });

  it("enriches source from a shopName string", () => {
    const product = enrichProduct({
      raw: baseRaw({ shopName: "Acme Store" }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.source).toBe("Acme Store");
  });

  it("does not overwrite fields already normalized from standard keys", () => {
    const raw = baseRaw({
      description: "original description",
      category: { name: "Original" },
      rating: { average: 3.0, count: 5 },
      shipping: { free: false },
      attributes: { size: "L" },
      available: false,
      source: "original-source",
    });
    const enriched = enrichProduct({ raw, platform: "aliexpress", url: PRODUCT_URL });
    const plain = normalizeProduct({ raw, platform: "aliexpress", url: PRODUCT_URL });
    expect(enriched.description).toBe("original description");
    expect(enriched.category).toEqual(plain.category);
    expect(enriched.rating).toEqual({ average: 3.0, count: 5 });
    expect(enriched.shipping).toEqual({ free: false });
    expect(enriched.attributes).toEqual({ size: "L" });
    expect(enriched.available).toBe(false);
    expect(enriched.source).toBe("original-source");
  });

  it("honors a custom key list via enrich options", () => {
    const product = enrichProduct({
      raw: baseRaw({ blurb: "custom blurb", summary: "fallback summary" }),
      platform: "aliexpress",
      url: PRODUCT_URL,
      enrich: { descriptionKeys: ["blurb"] },
    });
    expect(product.description).toBe("custom blurb");
  });

  it("enriches a product whose raw data is sparse but valid", () => {
    const product = enrichProduct({
      raw: { externalId: "abc", title: "T", price: { amount: 5, currency: "usd" }, summary: "short" },
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.description).toBe("short");
    expect(validateProduct(product).valid).toBe(true);
  });

  it("output always passes validateProduct", () => {
    const raws = [
      baseRaw({ summary: "x", categoryName: "C", rating: 4.0, delivery: true, specs: { a: "b" }, inStock: 1 }),
      baseRaw({ desc: "d", categories: ["C2"], ratingSummary: "4.2", shipmentInfo: { free: true }, shopName: "S" }),
      baseRaw({ subtitle: "s", type: "Gadget", reviewSummary: "4.9", details: { k: "v" }, stock: "1", seller: "Q" }),
    ];
    for (const raw of raws) {
      const product = enrichProduct({ raw, platform: "aliexpress", url: PRODUCT_URL });
      expect(validateProduct(product).valid).toBe(true);
      expect(product).toMatchObject({ platform: "aliexpress", externalId: "1005001", url: PRODUCT_URL, title: "Wireless Earbuds" });
    }
  });

  it("exposes a frozen default key configuration", () => {
    expect(DEFAULT_KEYS.descriptionKeys).toContain("description");
    expect(DEFAULT_KEYS.categoryKeys).toContain("category");
    expect(DEFAULT_KEYS.ratingKeys).toContain("rating");
    expect(DEFAULT_KEYS.shippingKeys).toContain("shipping");
    expect(DEFAULT_KEYS.attributeKeys).toContain("attributes");
    expect(DEFAULT_KEYS.availabilityKeys).toContain("available");
    expect(DEFAULT_KEYS.sourceKeys).toContain("source");
    expect(Object.isFrozen(DEFAULT_KEYS)).toBe(true);
  });
});

describe("enrichProduct edge cases", () => {
  it("returns a product identical to normalizeProduct when no alternative keys are present", () => {
    const scrapedAt = "2026-09-03T09:08:55.000Z";
    const raw = baseRaw({ description: "d", category: { name: "C" }, rating: { average: 4 }, source: "s" });
    const enriched = enrichProduct({ raw, platform: "aliexpress", url: PRODUCT_URL, scrapedAt });
    const plain = normalizeProduct({ raw, platform: "aliexpress", url: PRODUCT_URL, scrapedAt });
    expect(enriched).toEqual(plain);
  });

  it("delegates non-object raw rejection to normalizeProduct", () => {
    expect(() =>
      enrichProduct({ raw: null, platform: "aliexpress", url: PRODUCT_URL, enrich: { descriptionKeys: [] } }),
    ).toThrow();
    expect(() => enrichProduct({ raw: ["not", "an", "object"], platform: "aliexpress", url: PRODUCT_URL })).toThrow();
  });

  it("ignores empty string candidates", () => {
    const product = enrichProduct({
      raw: baseRaw({ summary: "   ", subtitle: "real subtitle" }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.description).toBe("real subtitle");
  });

  it("keeps the product valid type", () => {
    const product: Product = enrichProduct({
      raw: baseRaw({ rating: 4, delivery: "9.99", currency: "eur", specs: { color: "red" } }),
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.rating?.average).toBe(4);
    expect(product.shipping?.cost?.currency).toBe("EUR");
    expect(product.attributes).toEqual({ color: "red" });
  });
});
