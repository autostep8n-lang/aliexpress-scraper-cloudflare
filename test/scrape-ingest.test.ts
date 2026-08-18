import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { routeRequest } from "../src/router";
import { isTiktokHost } from "../src/scrapers/tiktok";
import { createMockPostgrest, type MockPostgrest } from "./helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

const PRODUCT_URL = "https://www.tiktok.com/@shop/product/123456789";

const ctx = {} as ExecutionContext;

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function productItem(): Record<string, unknown> {
  return {
    productId: "123456789",
    title: "Wireless Earbuds Pro",
    description: "High-fidelity wireless earbuds with active noise cancellation.",
    price: 19.99,
    salePrice: 14.99,
    compareAtPrice: 29.99,
    currency: "USD",
    images: [{ url: "https://p16-sign-sg.tiktokcdn.com/obj/1.jpg" }],
    rating: { ratingScore: 4.7, ratingCount: 321 },
    itemAvailable: true,
    sellerName: "Cool Store",
    sales: 1200,
  };
}

function productPageHtml(item: Record<string, unknown> = productItem()): string {
  const payload = {
    __DEFAULT_SCOPE__: {
      "webapp.product-detail": {
        productInfo: { item },
      },
    },
  };
  return `<!doctype html><html><head>
    <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script>
  </head><body></body></html>`;
}

/**
 * Routes TikTok host fetches to a canned HTML page and everything else
 * (Supabase/PostgREST) to the in-memory mock server.
 */
function compositeFetch(server: MockPostgrest, html: string): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
    if (isTiktokHost(url.hostname)) {
      return Promise.resolve(new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
    }
    return server.fetch(input, init);
  };
}

async function get(path: string, requestEnv: Env = configuredEnv()): Promise<Response> {
  return routeRequest(new Request(`https://worker.example${path}`, { method: "GET" }), requestEnv, ctx);
}

describe("GET /api/scrape (tiktok-shop ingestion pipeline)", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a product + observation and persists tiktok-specific fields", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, productPageHtml()));

    const res = await get(`/api/scrape?url=${encodeURIComponent(PRODUCT_URL)}`);
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      status: string;
      platform: string;
      url: string;
      title: string;
      source: { slug: string };
      product: { dedup_key: string };
      observation: { external_id: string; price: number };
    };
    expect(body.status).toBe("created");
    expect(body.platform).toBe("tiktok-shop");
    expect(body.url).toBe(PRODUCT_URL);
    expect(body.title).toBe("Wireless Earbuds Pro");
    expect(body.source.slug).toBe("tiktok-shop");
    expect(body.product.dedup_key).toBe("tiktok-shop:123456789");
    expect(body.observation.external_id).toBe("123456789");
    expect(body.observation.price).toBe(14.99);

    expect(server.store.sources.map((row) => row.slug)).toContain("tiktok-shop");
    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources).toHaveLength(1);

    const observation = server.store.product_sources[0];
    expect(observation.attributes).toMatchObject({ sellerName: "Cool Store", sales: "1200" });
    expect(observation.raw).toMatchObject({
      productId: "123456789",
      title: "Wireless Earbuds Pro",
      price: { amount: 14.99, currency: "USD", originalAmount: 29.99 },
      attributes: { sales: "1200" },
    });
  });

  it("returns 200 updated when the same product is scraped again", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, productPageHtml()));

    const first = await get(`/api/scrape?url=${encodeURIComponent(PRODUCT_URL)}`);
    expect(first.status).toBe(201);

    const second = await get(`/api/scrape?url=${encodeURIComponent(PRODUCT_URL)}`);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { status: string };
    expect(body.status).toBe("updated");
    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources).toHaveLength(1);
  });

  it("returns 503 SUPABASE_NOT_CONFIGURED when supabase bindings are missing", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, productPageHtml()));

    const res = await get(`/api/scrape?url=${encodeURIComponent(PRODUCT_URL)}`, {} as Env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SUPABASE_NOT_CONFIGURED");
  });

  it("returns 502 NO_PRODUCT_DATA without writing anything", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, "<html><body>nothing here</body></html>"));

    const res = await get(`/api/scrape?url=${encodeURIComponent(PRODUCT_URL)}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NO_PRODUCT_DATA");
    expect(server.store.products).toHaveLength(0);
    expect(server.store.product_sources).toHaveLength(0);
  });

  it("returns 502 BLOCKED for a captcha page", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, "<html><body>Captcha required to continue.</body></html>"));

    const res = await get(`/api/scrape?url=${encodeURIComponent(PRODUCT_URL)}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BLOCKED");
  });

  it("returns 501 NO_SCRAPER for unrelated hosts", async () => {
    server = createMockPostgrest();
    const res = await get("/api/scrape?url=https%3A%2F%2Fwww.aliexpress.com%2Fitem%2F1.html");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NO_SCRAPER");
  });

  it("keeps the missing/invalid url error responses", async () => {
    server = createMockPostgrest();

    const missing = await get("/api/scrape");
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { code: string }).code).toBe("MISSING_URL");

    const invalid = await get("/api/scrape?url=not-a-url");
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { code: string }).code).toBe("INVALID_URL");
  });
});
