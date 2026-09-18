import { describe, expect, it } from "vitest";
import { currenciesMatch, isHttpOrHttpsUrl, isValidCurrencyCode, mapImageFiles, mapProductSetInput } from "../../src/shopify/map";
import type { PersistedObservationRecord, PersistedProductRecord } from "../../src/supabase/repository";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";

function product(overrides: Partial<PersistedProductRecord> = {}): PersistedProductRecord {
  return {
    id: PRODUCT_ID,
    dedup_key: "aliexpress:sku-1",
    canonical_url: "https://www.aliexpress.com/item/1.html",
    title: "Wireless Earbuds",
    description: `A & B <script>alert(1)</script> "q" 's'`,
    brand: "SoundCore",
    category_id: null,
    primary_image_url: "https://img.example.com/primary.jpg",
    images: [{ url: "https://img.example.com/product.jpg", alt: "product" }],
    attributes: {},
    availability_status: "in_stock",
    lifecycle_status: "active",
    last_seen_at: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

function observation(overrides: Partial<PersistedObservationRecord> = {}): PersistedObservationRecord {
  return {
    id: "obs-1",
    product_id: PRODUCT_ID,
    source_id: "src-1",
    external_id: "SKU-123",
    url: "https://www.aliexpress.com/item/1.html",
    title: "Wireless Earbuds",
    description: null,
    brand: "SoundCore",
    category_id: null,
    image_urls: [
      { url: "https://img.example.com/a.jpg", alt: "a" },
      { url: "https://img.example.com/b.jpg" },
    ],
    price: 12.5,
    original_price: 20,
    currency: "USD",
    shipping: {},
    rating_average: null,
    rating_count: null,
    available: true,
    attributes: {},
    raw: null,
    last_seen_at: "2026-08-18T10:00:00.000Z",
    last_scraped_at: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("mapProductSetInput", () => {
  it("maps title, escaped descriptionHtml, vendor, DRAFT, one variant, SKU, and price", () => {
    const mapped = mapProductSetInput(product(), observation());
    expect(mapped.input.title).toBe("Wireless Earbuds");
    expect(mapped.input.descriptionHtml).toBe(
      "A &amp; B &lt;script&gt;alert(1)&lt;/script&gt; &quot;q&quot; &#39;s&#39;",
    );
    expect(mapped.input.vendor).toBe("SoundCore");
    expect(mapped.input.status).toBe("DRAFT");
    expect(mapped.input.productOptions).toEqual([{ name: "Title", values: [{ name: "Default Title" }] }]);
    expect(mapped.input.variants).toHaveLength(1);
    expect(mapped.input.variants[0]).toEqual({
      optionValues: [{ optionName: "Title", name: "Default Title" }],
      price: "12.5",
      sku: "SKU-123",
    });
    expect(mapped.input.variants[0]).not.toHaveProperty("compareAtPrice");
    expect(mapped.sourceCurrency).toBe("USD");
  });

  it("omits SKU when external_id is blank and omits vendor when brand is empty", () => {
    const mapped = mapProductSetInput(
      product({ brand: "" }),
      observation({ external_id: "   " }),
    );
    expect(mapped.input.variants[0].sku).toBeUndefined();
    expect(mapped.input.vendor).toBeUndefined();
  });

  it("omits files on create when none remain, and sends the current snapshot on update", () => {
    const emptyObs = observation({ image_urls: [] });
    const emptyProduct = product({ images: [], primary_image_url: null });
    const created = mapProductSetInput(emptyProduct, emptyObs, { includeEmptyFiles: false });
    expect(created.input.files).toBeUndefined();
    const updated = mapProductSetInput(emptyProduct, emptyObs, {
      includeEmptyFiles: true,
      variantId: "gid://shopify/ProductVariant/1",
    });
    expect(updated.input.files).toEqual([]);
    expect(updated.input.variants[0].id).toBe("gid://shopify/ProductVariant/1");
  });
});

describe("mapImageFiles", () => {
  it("preserves order, trims, exact-dedupes, keeps http(s) only, and caps at 10", () => {
    const files = mapImageFiles(
      observation({
        image_urls: [
          { url: " https://img.example.com/a.jpg ", alt: "a" },
          { url: "https://img.example.com/a.jpg" },
          { url: "ftp://img.example.com/x.jpg" },
          { url: "javascript:alert(1)" },
          { url: "not-a-url" },
          { url: "http://img.example.com/b.jpg" },
          { url: "https://img.example.com/c.jpg" },
          { url: "https://img.example.com/d.jpg" },
          { url: "https://img.example.com/e.jpg" },
          { url: "https://img.example.com/f.jpg" },
          { url: "https://img.example.com/g.jpg" },
          { url: "https://img.example.com/h.jpg" },
          { url: "https://img.example.com/i.jpg" },
          { url: "https://img.example.com/j.jpg" },
          { url: "https://img.example.com/k.jpg" },
        ],
      }),
      product({
        images: [{ url: "https://img.example.com/product.jpg" }],
        primary_image_url: "https://img.example.com/primary.jpg",
      }),
    );
    expect(files.map((file) => file.originalSource)).toEqual([
      "https://img.example.com/a.jpg",
      "http://img.example.com/b.jpg",
      "https://img.example.com/c.jpg",
      "https://img.example.com/d.jpg",
      "https://img.example.com/e.jpg",
      "https://img.example.com/f.jpg",
      "https://img.example.com/g.jpg",
      "https://img.example.com/h.jpg",
      "https://img.example.com/i.jpg",
      "https://img.example.com/j.jpg",
    ]);
    expect(files).toHaveLength(10);
    expect(files[0]).toEqual({ originalSource: "https://img.example.com/a.jpg", contentType: "IMAGE", alt: "a" });
  });

  it("falls back to product images then primary_image_url", () => {
    const files = mapImageFiles(observation({ image_urls: [] }), product());
    expect(files.map((file) => file.originalSource)).toEqual([
      "https://img.example.com/product.jpg",
      "https://img.example.com/primary.jpg",
    ]);
  });
});

describe("url and currency helpers", () => {
  it("accepts only http and https via URL parsing", () => {
    expect(isHttpOrHttpsUrl("https://img.example.com/a.jpg")).toBe(true);
    expect(isHttpOrHttpsUrl("http://img.example.com/a.jpg")).toBe(true);
    expect(isHttpOrHttpsUrl("ftp://img.example.com/a.jpg")).toBe(false);
    expect(isHttpOrHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpOrHttpsUrl("not a url")).toBe(false);
  });

  it("validates ISO-like 3-letter currency codes and compares case-insensitively", () => {
    expect(isValidCurrencyCode("USD")).toBe(true);
    expect(isValidCurrencyCode("usd")).toBe(true);
    expect(isValidCurrencyCode("US")).toBe(false);
    expect(isValidCurrencyCode("")).toBe(false);
    expect(isValidCurrencyCode(null)).toBe(false);
    expect(currenciesMatch("usd", "USD")).toBe(true);
    expect(currenciesMatch("EUR", "USD")).toBe(false);
  });
});
