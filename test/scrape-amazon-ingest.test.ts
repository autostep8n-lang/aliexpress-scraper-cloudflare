import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { routeRequest } from "../src/router";
import { isAmazonHost } from "../src/scrapers/amazon";
import { createMockPostgrest, type MockPostgrest } from "./helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

const ASIN = "B0B1234567";
const PRODUCT_URL = `https://www.amazon.com/dp/${ASIN}`;

const ctx = {} as ExecutionContext;

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function ldScript(obj: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
}

function productPageHtml(): string {
  const ld = [
    {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Wireless Earbuds Pro",
      description: "High-fidelity wireless earbuds with active noise cancellation.",
      image: ["https://m.media-amazon.com/images/I/71abc.jpg"],
      brand: { "@type": "Brand", name: "SoundCore" },
      aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", reviewCount: "1321" },
      offers: {
        "@type": "Offer",
        price: "49.99",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
        seller: { "@type": "Organization", name: "Cool Store" },
      },
    },
  ];
  return `<!doctype html><html><head>
    <link rel="canonical" href="${PRODUCT_URL}">
    ${ld.map(ldScript).join("\n")}
  </head><body></body></html>`;
}

/**
 * Routes Amazon host fetches to a canned HTML page and everything else
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
    if (isAmazonHost(url.hostname)) {
      return Promise.resolve(new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
    }
    return server.fetch(input, init);
  };
}

async function get(path: string, requestEnv: Env = configuredEnv()): Promise<Response> {
  return routeRequest(new Request(`https://worker.example${path}`, { method: "GET" }), requestEnv, ctx);
}

describe("GET /api/scrape (amazon ingestion pipeline)", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a product + observation and persists amazon fields", async () => {
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
    expect(body.platform).toBe("amazon");
    expect(body.url).toBe(PRODUCT_URL);
    expect(body.title).toBe("Wireless Earbuds Pro");
    expect(body.source.slug).toBe("amazon");
    expect(body.product.dedup_key).toBe(`amazon:${ASIN}`);
    expect(body.observation.external_id).toBe(ASIN);
    expect(body.observation.price).toBe(49.99);
    expect(body.observation.currency).toBe("USD");

    expect(server.store.sources.map((row) => row.slug)).toContain("amazon");
    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources).toHaveLength(1);

    const observation = server.store.product_sources[0];
    expect(observation.attributes).toMatchObject({ seller: "Cool Store", brand: "SoundCore" });
    expect(observation.raw).toMatchObject({
      externalId: ASIN,
      title: "Wireless Earbuds Pro",
      price: { amount: 49.99, currency: "USD" },
      attributes: { seller: "Cool Store", brand: "SoundCore" },
    });
  });

  it("returns 200 updated when the same ASIN is scraped again", async () => {
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

  it("scrapes regional amazon domains with the same ASIN identity", async () => {
    server = createMockPostgrest();
    const ukUrl = `https://www.amazon.co.uk/dp/${ASIN}`;
    vi.stubGlobal(
      "fetch",
      compositeFetch(server, productPageHtml().replace(PRODUCT_URL, ukUrl)),
    );

    const res = await get(`/api/scrape?url=${encodeURIComponent(ukUrl)}`);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { product: { dedup_key: string } };
    expect(body.product.dedup_key).toBe(`amazon:${ASIN}`);
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

  it("returns 502 BLOCKED for a robot check page", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, "<html><body>Robot Check, please verify you are human</body></html>"));

    const res = await get(`/api/scrape?url=${encodeURIComponent(PRODUCT_URL)}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BLOCKED");
  });

  it("returns 501 NO_SCRAPER for a non-product amazon page", async () => {
    server = createMockPostgrest();
    const res = await get("/api/scrape?url=https%3A%2F%2Fwww.amazon.com%2Fb%2F%3Fnode%3D1");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NO_SCRAPER");
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
