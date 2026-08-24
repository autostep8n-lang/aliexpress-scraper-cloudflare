import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { getObservation, upsertProduct } from "../src/supabase/repository";
import type { Product } from "../src/products/types";
import { normalizeProduct } from "../src/products/normalize";
import { computeGtinCheckDigit } from "../src/matching/normalize";
import { createMockPostgrest, type MockPostgrest, type RecordedRequest } from "./helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

const SOURCE_ALIEXPRESS = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "aliexpress",
  name: "AliExpress",
  kind: "platform",
};
const SOURCE_AMAZON = {
  id: "22222222-2222-2222-2222-222222222222",
  slug: "amazon",
  name: "Amazon",
  kind: "platform",
};

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function aliexpressProduct(overrides: Partial<Product> = {}): Product {
  const product = normalizeProduct({
    raw: {
      externalId: "1005001",
      title: "Wireless Earbuds",
      description: "High quality wireless earbuds",
      price: { amount: "19.99", currency: "usd", originalAmount: "29.99" },
      images: [{ url: "https://img.example.com/a.jpg", alt: "earbuds" }],
      category: { id: "c1", name: "Electronics", path: ["Electronics", "Audio"] },
      rating: { average: 4.5, count: 123 },
      shipping: { free: true, deliveryMinDays: 7, deliveryMaxDays: 15, fromCountry: "CN" },
      attributes: { brand: "SoundCore", color: "black" },
      available: true,
    },
    platform: "aliexpress",
    url: "https://www.aliexpress.com/item/1005001.html",
    scrapedAt: "2026-08-18T10:00:00.000Z",
  });
  return { ...product, ...overrides };
}

function amazonProduct(): Product {
  return normalizeProduct({
    raw: {
      externalId: "B0XXXXX",
      title: "Wireless Earbuds (Amazon)",
      price: { amount: "24.99", currency: "USD" },
    },
    platform: "amazon",
    url: "https://www.amazon.com/dp/B0XXXXX",
    scrapedAt: "2026-08-18T11:00:00.000Z",
  });
}

function requestsTo(server: MockPostgrest, method: string, path: string): RecordedRequest[] {
  return server.requests.filter((request) => request.method === method && request.url.includes(path));
}

describe("upsertProduct", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    server.seed("sources", [SOURCE_ALIEXPRESS, SOURCE_AMAZON]);
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns credentials_missing without touching the network when Supabase is unconfigured", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await upsertProduct({} as Env, aliexpressProduct(), { raw: { scraped: true } });

    expect(result).toEqual({ status: "credentials_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns invalid for a malformed product without touching the network", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const invalid = { ...aliexpressProduct(), title: "" } as Product;
    const result = await upsertProduct(configuredEnv(), invalid);

    expect(result.status).toBe("invalid");
    expect((result as { message: string }).message).toContain("title");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a source, unified product, category and observation for a new product", async () => {
    const empty = createMockPostgrest();
    vi.stubGlobal("fetch", empty.fetch);

    const result = await upsertProduct(configuredEnv(), aliexpressProduct(), { raw: { scraped: true } });

    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    expect(empty.store.sources).toHaveLength(1);
    expect(empty.store.sources[0]).toMatchObject({ slug: "aliexpress", name: "AliExpress", kind: "platform" });
    expect(empty.store.products).toHaveLength(1);
    expect(empty.store.product_sources).toHaveLength(1);

    expect(result.data.source.id).toBe(empty.store.sources[0].id);
    expect(result.data.product.dedup_key).toBe("aliexpress:1005001");
    expect(result.data.product.id).toBe(empty.store.products[0].id);
    expect(result.data.observation.id).toBe(empty.store.product_sources[0].id);
    expect(result.data.observation.product_id).toBe(result.data.product.id);
    expect(result.data.observation.source_id).toBe(result.data.source.id);

    const sourcePost = requestsTo(empty, "POST", "/rest/v1/sources")[0];
    expect(sourcePost.url).toContain("on_conflict=slug");
  });

  it("maps a normalized Product onto the unified products row", async () => {
    const result = await upsertProduct(configuredEnv(), aliexpressProduct());
    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    const product = result.data.product;
    expect(product.canonical_url).toBe("https://www.aliexpress.com/item/1005001.html");
    expect(product.title).toBe("Wireless Earbuds");
    expect(product.description).toBe("High quality wireless earbuds");
    expect(product.brand).toBe("SoundCore");
    expect(product.availability_status).toBe("in_stock");
    expect(product.primary_image_url).toBe("https://img.example.com/a.jpg");
    expect(product.images).toEqual([{ url: "https://img.example.com/a.jpg", alt: "earbuds" }]);
    expect(product.attributes).toEqual({ brand: "SoundCore", color: "black" });
    expect(product.last_seen_at).toBe("2026-08-18T10:00:00.000Z");

    const productPost = requestsTo(server, "POST", "/rest/v1/products")[0];
    expect(productPost.url).toContain("on_conflict=dedup_key");
    const body = productPost.body as Record<string, unknown>;
    expect(body.dedup_key).toBe("aliexpress:1005001");
    expect(body.availability_status).toBe("in_stock");
  });

  it("maps source-specific fields onto the product_sources observation", async () => {
    const result = await upsertProduct(configuredEnv(), aliexpressProduct(), { raw: { scraped: true } });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    const observation = result.data.observation;
    expect(observation.external_id).toBe("1005001");
    expect(observation.url).toBe("https://www.aliexpress.com/item/1005001.html");
    expect(observation.price).toBe(19.99);
    expect(observation.original_price).toBe(29.99);
    expect(observation.currency).toBe("USD");
    expect(observation.shipping).toEqual({ free: true, deliveryMinDays: 7, deliveryMaxDays: 15, fromCountry: "CN" });
    expect(observation.rating_average).toBe(4.5);
    expect(observation.rating_count).toBe(123);
    expect(observation.brand).toBe("SoundCore");
    expect(observation.available).toBe(true);
    expect(observation.raw).toEqual({ scraped: true });
    expect(observation.last_scraped_at).toBe("2026-08-18T10:00:00.000Z");

    const observationPost = requestsTo(server, "POST", "/rest/v1/product_sources")[0];
    expect(new URL(observationPost.url).searchParams.get("on_conflict")).toBe("source_id,external_id");
  });

  it("links the source-scoped category and stores it on both rows", async () => {
    const result = await upsertProduct(configuredEnv(), aliexpressProduct());
    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    const categoryPost = requestsTo(server, "POST", "/rest/v1/product_categories")[0];
    expect(new URL(categoryPost.url).searchParams.get("on_conflict")).toBe("source_id,external_id");
    const categoryBody = categoryPost.body as Record<string, unknown>;
    expect(categoryBody).toMatchObject({
      source_id: SOURCE_ALIEXPRESS.id,
      external_id: "c1",
      name: "Electronics",
      slug: "electronics",
      path: ["Electronics", "Audio"],
    });

    const categoryId = server.store.product_categories[0].id;
    expect(result.data.product.category_id).toBe(categoryId);
    expect(result.data.observation.category_id).toBe(categoryId);
  });

  it("keeps category failures non-fatal and still ingests the product", async () => {
    server.override("POST", "/rest/v1/product_categories", 400, {
      code: "23502",
      message: "null value in column violates not-null constraint",
    });

    const result = await upsertProduct(configuredEnv(), aliexpressProduct());

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.data.product.category_id).toBeNull();
    expect(result.data.observation.category_id).toBeNull();
    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources).toHaveLength(1);
  });

  it("reuses the unified product and observation on re-ingest of the same product", async () => {
    const first = await upsertProduct(configuredEnv(), aliexpressProduct());
    expect(first.status).toBe("created");
    if (first.status !== "created") return;

    const second = await upsertProduct(configuredEnv(), { ...aliexpressProduct(), title: "Wireless Earbuds Pro" });

    expect(second.status).toBe("updated");
    if (second.status !== "updated") return;
    expect(second.data.product.id).toBe(first.data.product.id);
    expect(second.data.observation.id).toBe(first.data.observation.id);
    expect(second.data.product.title).toBe("Wireless Earbuds Pro");
    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources).toHaveLength(1);
  });

  it("creates a separate product row for the same listing on a different platform", async () => {
    const ali = await upsertProduct(configuredEnv(), aliexpressProduct());
    const amazon = await upsertProduct(configuredEnv(), amazonProduct());

    expect(ali.status).toBe("created");
    expect(amazon.status).toBe("created");
    if (ali.status !== "created" || amazon.status !== "created") return;

    expect(amazon.data.product.id).not.toBe(ali.data.product.id);
    expect(amazon.data.product.dedup_key).toBe("amazon:B0XXXXX");
    expect(amazon.data.observation.source_id).toBe(SOURCE_AMAZON.id);
    expect(server.store.products).toHaveLength(2);
    expect(server.store.product_sources).toHaveLength(2);
  });

  it("returns a typed error with a code when the product upsert fails", async () => {
    server.override("POST", "/rest/v1/products", 400, {
      code: "23502",
      message: "null value in column violates not-null constraint",
      details: "Failing row contains null in title",
      hint: null,
    });

    const result = await upsertProduct(configuredEnv(), aliexpressProduct());

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.code).toBe("product_upsert_failed");
    expect(result.message).toContain("null value");
  });

  it("returns a typed error when the source lookup fails", async () => {
    server.override("GET", "/rest/v1/sources", 500, {
      code: "PGRST301",
      message: "Database error",
      details: "connection to database failed",
      hint: null,
    });

    const result = await upsertProduct(configuredEnv(), aliexpressProduct());

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.code).toBe("source_lookup_failed");
    expect(result.message).toContain("Database error");
  });

  it("returns a typed error when the observation upsert fails", async () => {
    server.override("POST", "/rest/v1/product_sources", 409, {
      code: "23505",
      message: "duplicate key value violates unique constraint",
      details: "Key (source_id, external_id) already exists.",
      hint: null,
    });

    const result = await upsertProduct(configuredEnv(), aliexpressProduct());

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.code).toBe("observation_upsert_failed");
    expect(result.message).toContain("duplicate key");
  });

  it("never leaks credentials into results or request URLs", async () => {
    const result = await upsertProduct(configuredEnv(), aliexpressProduct());

    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${SECRET_KEY}`);
      expect(request.headers.get("apikey")).toBe(SECRET_KEY);
    }
  });
});

describe("upsertProduct deduplication", () => {
  let server: MockPostgrest;

  function gtin(body: string): string {
    return body + computeGtinCheckDigit(body);
  }

  const GTIN = gtin("123456789012");
  const GTIN_FINGERPRINT = `gtin:${GTIN.padStart(14, "0")}`;

  beforeEach(() => {
    server = createMockPostgrest();
    server.seed("sources", [SOURCE_ALIEXPRESS, SOURCE_AMAZON]);
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function gtinProduct(platform: "aliexpress" | "amazon", externalId: string, title: string, brand = "SoundCore"): Product {
    return normalizeProduct({
      raw: {
        externalId,
        title,
        price: { amount: "19.99", currency: "usd" },
        attributes: { brand, gtin: GTIN },
      },
      platform,
      url: `https://www.example.com/${platform}/${externalId}`,
      scrapedAt: "2026-08-18T10:00:00.000Z",
    });
  }

  function noIdentifierProduct(platform: "aliexpress" | "amazon", externalId: string, title: string, brand: string): Product {
    return normalizeProduct({
      raw: {
        externalId,
        title,
        price: { amount: "9.99", currency: "usd" },
        attributes: { brand },
      },
      platform,
      url: `https://www.example.com/${platform}/${externalId}`,
      scrapedAt: "2026-08-18T10:00:00.000Z",
    });
  }

  it("merges the same GTIN from two platforms into a single products row", async () => {
    const ali = await upsertProduct(configuredEnv(), gtinProduct("aliexpress", "1005001", "SoundCore Wireless Earbuds"));
    const amazon = await upsertProduct(
      configuredEnv(),
      gtinProduct("amazon", "B0XXXXX", "SoundCore Wireless Earbuds Pro"),
    );

    expect(ali.status).toBe("created");
    expect(amazon.status).toBe("updated");
    if (ali.status !== "created" || amazon.status !== "updated") return;

    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources).toHaveLength(2);
    expect(ali.data.product.dedup_key).toBe(GTIN_FINGERPRINT);
    expect(amazon.data.product.id).toBe(ali.data.product.id);

    const amazonObservation = server.store.product_sources.find((row) => row.external_id === "B0XXXXX");
    expect(amazonObservation?.product_id).toBe(ali.data.product.id);
  });

  it("merges the same MPN from two platforms", async () => {
    const ali = await upsertProduct(
      configuredEnv(),
      normalizeProduct({
        raw: {
          externalId: "1005001",
          title: "Acme Widget 3000",
          price: { amount: "19.99", currency: "usd" },
          attributes: { brand: "Acme", mpn: "MPN-1234" },
        },
        platform: "aliexpress",
        url: "https://www.example.com/aliexpress/1005001",
        scrapedAt: "2026-08-18T10:00:00.000Z",
      }),
    );
    const amazon = await upsertProduct(
      configuredEnv(),
      normalizeProduct({
        raw: {
          externalId: "B0XXXXX",
          title: "Acme Widget 3000 Deluxe",
          price: { amount: "24.99", currency: "usd" },
          attributes: { brand: "Acme", mpn: "MPN-1234" },
        },
        platform: "amazon",
        url: "https://www.example.com/amazon/B0XXXXX",
        scrapedAt: "2026-08-18T10:00:00.000Z",
      }),
    );

    expect(ali.status).toBe("created");
    expect(amazon.status).toBe("updated");
    if (ali.status !== "created" || amazon.status !== "updated") return;
    expect(server.store.products).toHaveLength(1);
    expect(amazon.data.product.id).toBe(ali.data.product.id);
  });

  it("keeps distinct color variants of the same model in separate products rows", async () => {
    const make = (platform: "aliexpress" | "amazon", externalId: string, color: string): Product =>
      normalizeProduct({
        raw: {
          externalId,
          title: "SoundCore Gadget",
          price: { amount: "19.99", currency: "usd" },
          attributes: { brand: "SoundCore", model: "AB-100", color },
        },
        platform,
        url: `https://www.example.com/${platform}/${externalId}`,
        scrapedAt: "2026-08-18T10:00:00.000Z",
      });

    const black = await upsertProduct(configuredEnv(), make("aliexpress", "1005001", "black"));
    const white = await upsertProduct(configuredEnv(), make("amazon", "B0XXXXX", "white"));

    expect(black.status).toBe("created");
    expect(white.status).toBe("created");
    if (black.status !== "created" || white.status !== "created") return;
    expect(server.store.products).toHaveLength(2);
    expect(white.data.product.id).not.toBe(black.data.product.id);
  });

  it("never merges similar titles from different brands", async () => {
    const ali = await upsertProduct(configuredEnv(), noIdentifierProduct("aliexpress", "1005001", "Wireless Earbuds", "SoundCore"));
    const amazon = await upsertProduct(configuredEnv(), noIdentifierProduct("amazon", "B0XXXXX", "Wireless Earbuds", "Sony"));

    expect(ali.status).toBe("created");
    expect(amazon.status).toBe("created");
    if (ali.status !== "created" || amazon.status !== "created") return;
    expect(server.store.products).toHaveLength(2);
  });

  it("merges near-identical titles from different sources when neither side has an identifier", async () => {
    const ali = await upsertProduct(configuredEnv(), noIdentifierProduct("aliexpress", "1005001", "USB-C Cable 3ft", "Acme"));
    const amazon = await upsertProduct(configuredEnv(), noIdentifierProduct("amazon", "B0XXXXX", "USB-C Cable 3ft", "Acme"));

    expect(ali.status).toBe("created");
    expect(amazon.status).toBe("updated");
    if (ali.status !== "created" || amazon.status !== "updated") return;
    expect(server.store.products).toHaveLength(1);
    expect(amazon.data.product.id).toBe(ali.data.product.id);
  });

  it("re-ingests the same source + identifier onto the same product row", async () => {
    const first = await upsertProduct(configuredEnv(), gtinProduct("aliexpress", "1005001", "SoundCore Wireless Earbuds"));
    const second = await upsertProduct(
      configuredEnv(),
      gtinProduct("aliexpress", "1005001", "SoundCore Wireless Earbuds (2026)"),
    );

    expect(first.status).toBe("created");
    expect(second.status).toBe("updated");
    if (first.status !== "created" || second.status !== "updated") return;
    expect(server.store.products).toHaveLength(1);
    expect(second.data.product.id).toBe(first.data.product.id);
  });

  it("refreshes last_seen_at on the matched product row", async () => {
    const ali = await upsertProduct(
      configuredEnv(),
      normalizeProduct({
        raw: {
          externalId: "1005001",
          title: "SoundCore Wireless Earbuds",
          price: { amount: "19.99", currency: "usd" },
          attributes: { brand: "SoundCore", gtin: GTIN },
        },
        platform: "aliexpress",
        url: "https://www.example.com/aliexpress/1005001",
        scrapedAt: "2026-08-18T10:00:00.000Z",
      }),
    );
    expect(ali.status).toBe("created");
    if (ali.status !== "created") return;

    const amazon = await upsertProduct(
      configuredEnv(),
      gtinProduct("amazon", "B0XXXXX", "SoundCore Wireless Earbuds"),
    );
    expect(amazon.status).toBe("updated");
    if (amazon.status !== "updated") return;

    expect(server.store.products[0].last_seen_at).toBe("2026-08-18T10:00:00.000Z");

    const patch = server.requests.find((request) => request.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch?.url).toContain("/rest/v1/products");
  });
});

describe("getObservation", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    server.seed("sources", [SOURCE_ALIEXPRESS]);
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns credentials_missing without touching the network", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await getObservation({} as Env, "aliexpress", "1005001");

    expect(result).toEqual({ status: "credentials_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns found for an existing observation", async () => {
    server.seed("product_sources", [
      {
        id: "33333333-3333-3333-3333-333333333333",
        product_id: "44444444-4444-4444-4444-444444444444",
        source_id: SOURCE_ALIEXPRESS.id,
        external_id: "1005001",
        url: "https://www.aliexpress.com/item/1005001.html",
        title: "Wireless Earbuds",
        price: 19.99,
        currency: "USD",
      },
    ]);

    const result = await getObservation(configuredEnv(), "aliexpress", "1005001");

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.data.external_id).toBe("1005001");
    expect(result.data.currency).toBe("USD");
    expect(result.data.price).toBe(19.99);
  });

  it("returns not_found when no observation matches", async () => {
    const result = await getObservation(configuredEnv(), "aliexpress", "does-not-exist");

    expect(result.status).toBe("not_found");
  });

  it("returns a typed error when the source lookup fails", async () => {
    server.override("GET", "/rest/v1/sources", 500, { code: "PGRST301", message: "Database error" });

    const result = await getObservation(configuredEnv(), "aliexpress", "1005001");

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.code).toBe("source_lookup_failed");
  });
});
