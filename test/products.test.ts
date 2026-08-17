import { describe, expect, it } from "vitest";
import { normalizeProduct, ProductNormalizationError } from "../src/products/normalize";
import { isProduct, validateProduct } from "../src/products/validation";
import { isHttpUrl, parseHttpUrl } from "../src/utils/url";
import type { Product } from "../src/products/types";

const baseRaw = {
  externalId: "1005001",
  title: "Wireless Earbuds",
  price: { amount: "19.99", currency: "usd", originalAmount: "29.99" },
  images: [{ url: "https://img.example.com/a.jpg", alt: "earbuds" }],
  category: { id: "c1", name: "Electronics", path: ["Electronics", "Audio"] },
  rating: { average: 4.5, count: 123 },
  shipping: { free: true, deliveryMinDays: 7, deliveryMaxDays: 15, fromCountry: "CN" },
  available: true,
  description: "High quality wireless earbuds",
};

const PRODUCT_URL = "https://www.aliexpress.com/item/1005001.html";

function normalized(): Product {
  return normalizeProduct({ raw: baseRaw, platform: "aliexpress", url: PRODUCT_URL });
}

describe("isHttpUrl / parseHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isHttpUrl("https://www.aliexpress.com/item/1.html")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
  });

  it("rejects other schemes and garbage", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("data:text/html,<h1>hi</h1>")).toBe(false);
    expect(isHttpUrl("not-a-url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });

  it("parseHttpUrl returns null for non-http and a URL otherwise", () => {
    expect(parseHttpUrl("file:///x")).toBeNull();
    expect(parseHttpUrl("javascript:void(0)")).toBeNull();
    expect(parseHttpUrl("https://a.example/c")?.href).toBe("https://a.example/c");
  });
});

describe("normalizeProduct", () => {
  it("normalizes a raw record into a typed Product", () => {
    const product = normalized();
    expect(product.platform).toBe("aliexpress");
    expect(product.externalId).toBe("1005001");
    expect(product.title).toBe("Wireless Earbuds");
    expect(product.price).toEqual({ amount: 19.99, currency: "USD", originalAmount: 29.99 });
    expect(product.images).toEqual([{ url: "https://img.example.com/a.jpg", alt: "earbuds" }]);
    expect(product.category).toEqual({ id: "c1", name: "Electronics", path: ["Electronics", "Audio"] });
    expect(product.rating).toEqual({ average: 4.5, count: 123 });
    expect(product.shipping).toEqual({ free: true, deliveryMinDays: 7, deliveryMaxDays: 15, fromCountry: "CN" });
    expect(product.available).toBe(true);
    expect(product.description).toBe("High quality wireless earbuds");
    expect(Number.isNaN(Date.parse(product.scrapedAt))).toBe(false);
  });

  it("coerces a numeric-string price and uppercases currency", () => {
    const product = normalizeProduct({
      raw: { externalId: 1005001, title: "T", price: "12.34", currency: "usd" },
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.price).toEqual({ amount: 12.34, currency: "USD" });
  });

  it("throws for a non-http url", () => {
    expect(() => normalizeProduct({ raw: baseRaw, platform: "aliexpress", url: "javascript:alert(1)" })).toThrow(
      ProductNormalizationError,
    );
  });

  it("throws when platform is missing or unsupported", () => {
    expect(() => normalizeProduct({ raw: baseRaw, url: PRODUCT_URL })).toThrow(ProductNormalizationError);
    expect(() => normalizeProduct({ raw: { ...baseRaw, platform: "not-a-platform" }, url: PRODUCT_URL })).toThrow(
      ProductNormalizationError,
    );
  });

  it("throws when title is missing", () => {
    expect(() => normalizeProduct({ raw: { ...baseRaw, title: "  " }, platform: "aliexpress", url: PRODUCT_URL })).toThrow(
      ProductNormalizationError,
    );
  });

  it("throws when price is missing or unparseable", () => {
    const { price, ...noPrice } = baseRaw;
    expect(() => normalizeProduct({ raw: noPrice, platform: "aliexpress", url: PRODUCT_URL })).toThrow(
      ProductNormalizationError,
    );
    expect(() =>
      normalizeProduct({ raw: { ...baseRaw, price: "free" }, platform: "aliexpress", url: PRODUCT_URL }),
    ).toThrow(ProductNormalizationError);
  });

  it("derives externalId from the url when absent", () => {
    const { externalId, ...rest } = baseRaw;
    const product = normalizeProduct({ raw: rest, platform: "aliexpress", url: PRODUCT_URL });
    expect(product.externalId).toBe("1005001");
  });

  it("drops non-http images instead of throwing", () => {
    const product = normalizeProduct({
      raw: { ...baseRaw, images: [{ url: "javascript:bad" }, "https://img.example.com/ok.jpg"] },
      platform: "aliexpress",
      url: PRODUCT_URL,
    });
    expect(product.images).toEqual([{ url: "https://img.example.com/ok.jpg" }]);
  });
});

describe("validateProduct", () => {
  it("accepts a normalized product", () => {
    expect(validateProduct(normalized())).toEqual({ valid: true, errors: [] });
  });

  it("rejects non-objects", () => {
    expect(validateProduct(null).valid).toBe(false);
    expect(validateProduct("product").valid).toBe(false);
    expect(validateProduct([]).valid).toBe(false);
  });

  it("rejects missing platform", () => {
    const { platform, ...rest } = normalized();
    expect(validateProduct(rest).valid).toBe(false);
  });

  it("rejects a non-http url", () => {
    expect(validateProduct({ ...normalized(), url: "file:///etc/passwd" }).valid).toBe(false);
  });

  it("rejects an empty title", () => {
    expect(validateProduct({ ...normalized(), title: "" }).valid).toBe(false);
  });

  it("rejects a negative or non-finite price amount", () => {
    expect(validateProduct({ ...normalized(), price: { amount: -5, currency: "USD" } }).valid).toBe(false);
    expect(validateProduct({ ...normalized(), price: { amount: Number.NaN, currency: "USD" } }).valid).toBe(false);
  });

  it("rejects an invalid currency", () => {
    expect(validateProduct({ ...normalized(), price: { amount: 5, currency: "us" } }).valid).toBe(false);
  });

  it("rejects a missing price", () => {
    const { price, ...rest } = normalized();
    expect(validateProduct(rest).valid).toBe(false);
  });

  it("rejects images with a non-http url", () => {
    expect(validateProduct({ ...normalized(), images: [{ url: "javascript:x" }] }).valid).toBe(false);
  });

  it("rejects an invalid scrapedAt", () => {
    expect(validateProduct({ ...normalized(), scrapedAt: "not-a-date" }).valid).toBe(false);
  });

  it("isProduct matches validation", () => {
    expect(isProduct(normalized())).toBe(true);
    expect(isProduct({ ...normalized(), title: "" })).toBe(false);
    expect(isProduct(null)).toBe(false);
  });
});
