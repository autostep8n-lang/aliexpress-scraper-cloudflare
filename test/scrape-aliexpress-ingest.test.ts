import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { routeRequest } from "../src/router";
import { isAliExpressHost } from "../src/scrapers/aliexpress";
import { createMockPostgrest, type MockPostgrest } from "./helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

const ITEM_ID = "1005001234567890";
const PRODUCT_URL = `https://www.aliexpress.com/item/${ITEM_ID}.html`;

const ctx = {} as ExecutionContext;

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function runParamsScript(params: unknown): string {
  return `<script type="text/javascript">window.runParams = ${JSON.stringify(params)};</script>`;
}

function productPageHtml(): string {
  const runParams = {
    data: {
      actionModule: { itemId: ITEM_ID },
      titleModule: { subject: "Wireless Earbuds Pro", skuTitle: "Wireless Earbuds Pro" },
      priceModule: {
        discountPrice: "12.99",
        formatedPrice: "US $25.99",
        formatedActivityPrice: "US $12.99",
      },
      headerModule: { currency: "USD" },
      imageModule: { imagePathList: ["//ae01.alicdn.com/kf/Habc.jpg"] },
      storeModule: { storeName: "Cool Store" },
      specsModule: { props: [{ attrName: "Brand", attrValue: "SoundCore" }] },
      feedbackModule: { feedbackRating: { averageStar: "4.7", totalValidNum: "3210" } },
      breadcrumbModule: { list: [{ name: "Consumer Electronics" }, { name: "Headphones" }] },
    },
  };
  return `<!doctype html><html><head>
    <link rel="canonical" href="${PRODUCT_URL}">
  </head><body>${runParamsScript(runParams)}</body></html>`;
}

/**
 * Routes AliExpress host fetches to a canned HTML page and everything else
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
    if (isAliExpressHost(url.hostname)) {
      return Promise.resolve(new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
    }
    return server.fetch(input, init);
  };
}

async function get(path: string, requestEnv: Env = configuredEnv()): Promise<Response> {
  return routeRequest(new Request(`https://worker.example${path}`, { method: "GET" }), requestEnv, ctx);
}

describe("GET /api/scrape (aliexpress ingestion pipeline)", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a product + observation and persists aliexpress fields", async () => {
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
      observation: { external_id: string; price: number; currency: string };
    };
    expect(body.status).toBe("created");
    expect(body.platform).toBe("aliexpress");
    expect(body.url).toBe(PRODUCT_URL);
    expect(body.title).toBe("Wireless Earbuds Pro");
    expect(body.source.slug).toBe("aliexpress");
    expect(body.product.dedup_key).toBe(`aliexpress:${ITEM_ID}`);
    expect(body.observation.external_id).toBe(ITEM_ID);
    expect(body.observation.price).toBe(12.99);
    expect(body.observation.currency).toBe("USD");

    expect(server.store.sources.map((row) => row.slug)).toContain("aliexpress");
    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources).toHaveLength(1);

    const observation = server.store.product_sources[0];
    expect(observation.attributes).toMatchObject({ seller: "Cool Store", brand: "SoundCore" });
    expect(observation.raw).toMatchObject({
      externalId: ITEM_ID,
      title: "Wireless Earbuds Pro",
      price: { amount: 12.99, currency: "USD" },
      attributes: { Brand: "SoundCore", seller: "Cool Store", brand: "SoundCore" },
    });
  });

  it("returns 200 updated when the same item is scraped again", async () => {
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

  it("scrapes regional aliexpress domains with the same item id identity", async () => {
    server = createMockPostgrest();
    const ukUrl = `https://www.aliexpress.co.uk/item/${ITEM_ID}.html`;
    vi.stubGlobal("fetch", compositeFetch(server, productPageHtml().replace(PRODUCT_URL, ukUrl)));

    const res = await get(`/api/scrape?url=${encodeURIComponent(ukUrl)}`);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { product: { dedup_key: string } };
    expect(body.product.dedup_key).toBe(`aliexpress:${ITEM_ID}`);
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

  it("returns 502 BLOCKED for an anti-bot challenge page", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      compositeFetch(server, "<html><body>Please verify you are human to continue</body></html>"),
    );

    const res = await get(`/api/scrape?url=${encodeURIComponent(PRODUCT_URL)}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BLOCKED");
  });

  it("returns 501 NO_SCRAPER for a non-product aliexpress page", async () => {
    server = createMockPostgrest();
    const res = await get("/api/scrape?url=https%3A%2F%2Fwww.aliexpress.com%2Fw%2Fwholesale-earbuds.html");
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
