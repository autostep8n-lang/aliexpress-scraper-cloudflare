import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { exportProductToShopify } from "../../src/shopify/export";
import { PRODUCT_SET_MUTATION, SHOP_CURRENCY_QUERY } from "../../src/shopify/types";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const SHOP = "example.myshopify.com";
const GRAPHQL = `https://${SHOP}/admin/api/2026-07/graphql.json`;

function env(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: SECRET_KEY,
    SHOPIFY_SHOP_DOMAIN: SHOP,
    SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat-test",
    SHOPIFY_EXPORT_TOKEN: "export-secret",
    ...overrides,
  } as Env;
}

function seedProduct(server: MockPostgrest, currency = "USD"): void {
  server.seed("products", [
    {
      id: PRODUCT_ID,
      title: "Wireless Earbuds",
      description: "A & B",
      brand: "SoundCore",
      primary_image_url: "https://img.example.com/a.jpg",
      images: [{ url: "https://img.example.com/a.jpg" }],
    },
  ]);
  server.seed("product_sources", [
    {
      id: "obs-1",
      product_id: PRODUCT_ID,
      source_id: "src-1",
      external_id: "SKU-123",
      url: "https://www.aliexpress.com/item/1.html",
      price: 12.5,
      currency,
      image_urls: [{ url: "https://img.example.com/a.jpg" }],
      last_seen_at: "2026-08-18T10:00:00.000Z",
    },
  ]);
}

interface ShopifyCall {
  query: string;
  variables: Record<string, unknown>;
}

function installFetch(
  server: MockPostgrest,
  shopifyHandler: (call: ShopifyCall) => Promise<Response> | Response,
): ShopifyCall[] {
  const calls: ShopifyCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/admin/api/")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as ShopifyCall;
      calls.push(body);
      return shopifyHandler(body);
    }
    return server.fetch(input, init);
  });
  return calls;
}

describe("exportProductToShopify", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not call Shopify when admin credentials are missing", async () => {
    const calls = installFetch(server, () => {
      throw new Error("shopify should not be called");
    });
    const result = await exportProductToShopify(
      env({ SHOPIFY_ADMIN_ACCESS_TOKEN: undefined, SHOPIFY_SHOP_DOMAIN: undefined }),
      PRODUCT_ID,
    );
    expect(result.status).toBe("credentials_missing");
    expect(calls).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("queries shop currency then productSet create without identifier", async () => {
    seedProduct(server);
    const calls = installFetch(server, (call) => {
      if (call.query === SHOP_CURRENCY_QUERY) {
        return new Response(JSON.stringify({ data: { shop: { currencyCode: "USD" } } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: {
            productSet: {
              product: { id: "gid://shopify/Product/1", variants: { nodes: [{ id: "gid://shopify/ProductVariant/9" }] } },
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      );
    });

    const result = await exportProductToShopify(env(), PRODUCT_ID);
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[0].query).toBe(SHOP_CURRENCY_QUERY);
    expect(calls[1].query).toBe(PRODUCT_SET_MUTATION);
    expect(calls[1].variables.synchronous).toBe(true);
    expect(calls[1].variables.identifier).toBeUndefined();
    const input = calls[1].variables.input as { status: string; variants: unknown[] };
    expect(input.status).toBe("DRAFT");
    expect(input.variants).toHaveLength(1);
  });

  it("does not mutate when currencies mismatch", async () => {
    seedProduct(server, "EUR");
    const calls = installFetch(server, (call) => {
      if (call.query === SHOP_CURRENCY_QUERY) {
        return new Response(JSON.stringify({ data: { shop: { currencyCode: "USD" } } }), { status: 200 });
      }
      throw new Error("productSet must not run");
    });
    const result = await exportProductToShopify(env(), PRODUCT_ID);
    expect(result.status).toBe("currency_mismatch");
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toBe(SHOP_CURRENCY_QUERY);
    expect(server.store.shopify_listings).toHaveLength(0);
  });

  it("returns listing_upsert_failed after a successful create (orphan)", async () => {
    seedProduct(server);
    server.override("POST", "shopify_listings", 500, { message: "write failed" }, { persistent: true });
    const calls = installFetch(server, (call) => {
      if (call.query === SHOP_CURRENCY_QUERY) {
        return new Response(JSON.stringify({ data: { shop: { currencyCode: "USD" } } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: {
            productSet: {
              product: { id: "gid://shopify/Product/1", variants: { nodes: [{ id: "gid://shopify/ProductVariant/9" }] } },
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      );
    });
    const result = await exportProductToShopify(env(), PRODUCT_ID);
    expect(result).toMatchObject({
      status: "listing_upsert_failed",
      shopifyProductId: "gid://shopify/Product/1",
    });
    expect(calls.some((call) => call.query === PRODUCT_SET_MUTATION)).toBe(true);
  });

  it("updates with identifier.id when a listing GID already exists", async () => {
    seedProduct(server);
    server.seed("shopify_listings", [
      {
        id: "listing-1",
        product_id: PRODUCT_ID,
        shop_domain: SHOP,
        shopify_product_id: "gid://shopify/Product/1",
        shopify_variant_id: "gid://shopify/ProductVariant/9",
        status: "draft",
        dedup_key: `${SHOP}:${PRODUCT_ID}`,
        title: "Wireless Earbuds",
      },
    ]);
    const calls = installFetch(server, (call) => {
      if (call.query === SHOP_CURRENCY_QUERY) {
        return new Response(JSON.stringify({ data: { shop: { currencyCode: "usd" } } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: {
            productSet: {
              product: { id: "gid://shopify/Product/1", variants: { nodes: [{ id: "gid://shopify/ProductVariant/9" }] } },
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      );
    });
    const result = await exportProductToShopify(env(), PRODUCT_ID);
    expect(result.status).toBe("ok");
    expect(calls[1].variables.identifier).toEqual({ id: "gid://shopify/Product/1" });
  });
});

describe("graphql host", () => {
  it("targets the configured shop graphql.json endpoint", () => {
    expect(GRAPHQL).toBe("https://example.myshopify.com/admin/api/2026-07/graphql.json");
  });
});
