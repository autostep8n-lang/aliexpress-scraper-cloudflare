import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { routeRequest } from "../../src/router";
import { PRODUCT_SET_MUTATION, SHOP_CURRENCY_QUERY } from "../../src/shopify/types";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const SHOP = "example.myshopify.com";
const EXPORT_TOKEN = "export-secret";
const ctx = {} as ExecutionContext;

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: SECRET_KEY,
    SHOPIFY_SHOP_DOMAIN: SHOP,
    SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat-test",
    SHOPIFY_EXPORT_TOKEN: EXPORT_TOKEN,
    ...overrides,
  } as Env;
}

async function post(
  path: string,
  options: { env?: Env; token?: string | null; body?: string; contentType?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.token !== null) {
    headers.set("Authorization", `Bearer ${options.token ?? EXPORT_TOKEN}`);
  }
  if (options.contentType) headers.set("content-type", options.contentType);
  return routeRequest(
    new Request(`https://worker.example${path}`, {
      method: "POST",
      headers,
      body: options.body,
    }),
    options.env ?? configuredEnv(),
    ctx,
  );
}

function seedExportable(server: MockPostgrest, currency = "USD"): void {
  server.seed("products", [
    {
      id: PRODUCT_ID,
      title: "Wireless Earbuds",
      description: `A & B <x> "q" 's'`,
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

function shopOkThenSet(): (call: ShopifyCall) => Response {
  return (call) => {
    if (call.query === SHOP_CURRENCY_QUERY) {
      return new Response(JSON.stringify({ data: { shop: { currencyCode: "USD" } } }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        data: {
          productSet: {
            product: {
              id: "gid://shopify/Product/1",
              variants: { nodes: [{ id: "gid://shopify/ProductVariant/9" }] },
            },
            userErrors: [],
          },
        },
      }),
      { status: 200 },
    );
  };
}

describe("POST /api/shopify/products/:id", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns 405 Allow POST for GET", async () => {
    const response = await routeRequest(
      new Request(`https://worker.example/api/shopify/products/${PRODUCT_ID}`, { method: "GET" }),
      configuredEnv(),
      ctx,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(((await response.json()) as { code: string }).code).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 401 UNAUTHORIZED for a missing or wrong bearer token", async () => {
    const missing = await post(`/api/shopify/products/${PRODUCT_ID}`, { token: null });
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { code: string }).code).toBe("UNAUTHORIZED");

    const wrong = await post(`/api/shopify/products/${PRODUCT_ID}`, { token: "nope" });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("returns 503 SHOPIFY_NOT_CONFIGURED when the export token is unset", async () => {
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`, {
      env: configuredEnv({ SHOPIFY_EXPORT_TOKEN: undefined }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("SHOPIFY_NOT_CONFIGURED");
  });

  it("returns 404 for a malformed UUID without DB or Shopify network", async () => {
    const calls = installFetch(server, () => {
      throw new Error("network");
    });
    const response = await post("/api/shopify/products/not-a-uuid");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("NOT_FOUND");
    expect(calls).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("returns 400 INVALID_JSON for a malformed body", async () => {
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`, {
      body: "{",
      contentType: "application/json",
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_JSON");
  });

  it("returns 503 SHOPIFY_NOT_CONFIGURED without Shopify network when admin bindings are missing", async () => {
    const calls = installFetch(server, () => {
      throw new Error("shopify");
    });
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`, {
      env: configuredEnv({ SHOPIFY_ADMIN_ACCESS_TOKEN: undefined, SHOPIFY_SHOP_DOMAIN: undefined }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("SHOPIFY_NOT_CONFIGURED");
    expect(calls).toEqual([]);
  });

  it("returns 503 SUPABASE_NOT_CONFIGURED when supabase bindings are missing", async () => {
    const calls = installFetch(server, () => {
      throw new Error("shopify");
    });
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`, {
      env: configuredEnv({ SUPABASE_URL: undefined, SUPABASE_SECRET_KEY: undefined }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("SUPABASE_NOT_CONFIGURED");
    expect(calls).toEqual([]);
  });

  it("returns 404 NOT_FOUND for an unknown product", async () => {
    installFetch(server, shopOkThenSet());
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("NOT_FOUND");
  });

  it("returns 422 NO_OBSERVATION when the product has no source row", async () => {
    server.seed("products", [{ id: PRODUCT_ID, title: "Wireless Earbuds" }]);
    installFetch(server, shopOkThenSet());
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("NO_OBSERVATION");
  });

  it("returns 422 INVALID_CURRENCY for a bad observation currency and does not call Shopify", async () => {
    seedExportable(server, "US");
    const calls = installFetch(server, () => {
      throw new Error("shopify");
    });
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("INVALID_CURRENCY");
    expect(calls).toEqual([]);
  });

  it("returns 409 CURRENCY_MISMATCH and does not call productSet", async () => {
    seedExportable(server, "EUR");
    const calls = installFetch(server, (call) => {
      if (call.query === SHOP_CURRENCY_QUERY) {
        return new Response(JSON.stringify({ data: { shop: { currencyCode: "USD" } } }), { status: 200 });
      }
      throw new Error("productSet must not run");
    });
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("CURRENCY_MISMATCH");
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toBe(SHOP_CURRENCY_QUERY);
  });

  it("returns 502 SHOPIFY_AUTH_ERROR on HTTP 401 from Shopify", async () => {
    seedExportable(server);
    installFetch(server, () => new Response("nope", { status: 401 }));
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe("SHOPIFY_AUTH_ERROR");
  });

  it("returns 502 SHOPIFY_RATE_LIMITED on HTTP 429", async () => {
    seedExportable(server);
    installFetch(server, () => new Response("slow", { status: 429 }));
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe("SHOPIFY_RATE_LIMITED");
  });

  it("returns 502 SHOPIFY_TIMEOUT when fetch aborts", async () => {
    seedExportable(server);
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    installFetch(server, () => {
      throw timeout;
    });
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe("SHOPIFY_TIMEOUT");
  });

  it("returns 502 SHOPIFY_SHOP_FAILED when shop currency is missing", async () => {
    seedExportable(server);
    installFetch(server, () => new Response(JSON.stringify({ data: { shop: {} } }), { status: 200 }));
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe("SHOPIFY_SHOP_FAILED");
  });

  it("returns 502 SHOPIFY_EXPORT_FAILED on productSet userErrors", async () => {
    seedExportable(server);
    installFetch(server, (call) => {
      if (call.query === SHOP_CURRENCY_QUERY) {
        return new Response(JSON.stringify({ data: { shop: { currencyCode: "USD" } } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: { productSet: { product: null, userErrors: [{ message: "invalid", code: "INVALID" }] } },
        }),
        { status: 200 },
      );
    });
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe("SHOPIFY_EXPORT_FAILED");
  });

  it("returns 502 shopify_listings_upsert_failed after Shopify create succeeds", async () => {
    seedExportable(server);
    server.override("POST", "shopify_listings", 500, { message: "write failed" }, { persistent: true });
    installFetch(server, shopOkThenSet());
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe("shopify_listings_upsert_failed");
  });

  it("exports a draft product and persists the listing", async () => {
    seedExportable(server);
    const calls = installFetch(server, shopOkThenSet());
    const response = await post(`/api/shopify/products/${PRODUCT_ID}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      listing: { shopifyProductId: string; listingStatus: string; created: boolean };
    };
    expect(body.status).toBe("ok");
    expect(body.listing.shopifyProductId).toBe("gid://shopify/Product/1");
    expect(body.listing.listingStatus).toBe("draft");
    expect(body.listing.created).toBe(true);
    expect(calls[1].query).toBe(PRODUCT_SET_MUTATION);
    const input = calls[1].variables.input as {
      title: string;
      descriptionHtml: string;
      vendor: string;
      status: string;
      variants: Array<{ sku: string; price: string }>;
      files: Array<{ originalSource: string; contentType: string }>;
    };
    expect(input.title).toBe("Wireless Earbuds");
    expect(input.descriptionHtml).toBe("A &amp; B &lt;x&gt; &quot;q&quot; &#39;s&#39;");
    expect(input.vendor).toBe("SoundCore");
    expect(input.status).toBe("DRAFT");
    expect(input.variants).toEqual([
      { optionValues: [{ optionName: "Title", name: "Default Title" }], price: "12.5", sku: "SKU-123" },
    ]);
    expect(input.files).toEqual([{ originalSource: "https://img.example.com/a.jpg", contentType: "IMAGE" }]);
    expect(calls[1].variables.identifier).toBeUndefined();
  });
});
