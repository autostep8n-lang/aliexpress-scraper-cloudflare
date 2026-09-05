import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { googleTrendsModule } from "../../src/market/google-trends";
import { MarketError, type GoogleTrendsSignal, type MarketCollectResult } from "../../src/market/types";
import { normalizeProduct } from "../../src/products/normalize";
import type { Product } from "../../src/products/types";
import { routeRequest } from "../../src/router";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const TITLE = "Wireless Earbuds";

const SOURCE_ALIEXPRESS = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "aliexpress",
  name: "AliExpress",
  kind: "platform",
};

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function mockCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      void promise;
    }),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}

function aliexpressProduct(title = TITLE): Product {
  return normalizeProduct({
    raw: {
      externalId: "1005001",
      title,
      description: "High quality wireless earbuds",
      price: { amount: "19.99", currency: "usd", originalAmount: "29.99" },
      images: [{ url: "https://img.example.com/a.jpg", alt: "earbuds" }],
      category: { id: "c1", name: "Electronics" },
      rating: { average: 4.5, count: 123 },
      shipping: { free: true, deliveryMinDays: 7, deliveryMaxDays: 15 },
      attributes: { brand: "SoundCore" },
      available: true,
    },
    platform: "aliexpress",
    url: "https://www.aliexpress.com/item/1005001.html",
    scrapedAt: "2026-08-18T10:00:00.000Z",
  });
}

function saSignal(keyword = TITLE): GoogleTrendsSignal {
  return {
    keyword,
    geo: "SA",
    property: "web",
    category: null,
    timeRange: "today 5-y",
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-02-01T00:00:00.000Z",
    value: 80,
    capturedAt: "2026-03-01T00:00:00.000Z",
  };
}

function collectResult(signals: GoogleTrendsSignal[], keyword = TITLE): MarketCollectResult {
  return {
    source: "google-trends",
    provider: "internal-api",
    keyword,
    geo: "SA",
    timeRange: "today 5-y",
    property: "web",
    category: null,
    capturedAt: "2026-03-01T00:00:00.000Z",
    requested: signals.length,
    persisted: signals.length,
    created: signals.length,
    updated: 0,
    failed: 0,
    signals,
  };
}

describe("POST /api/products country opportunity glue", () => {
  let server: MockPostgrest;
  let ctx: ExecutionContext;

  beforeEach(() => {
    server = createMockPostgrest();
    server.seed("sources", [SOURCE_ALIEXPRESS]);
    ctx = mockCtx();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function post(body: unknown): Promise<Response> {
    return routeRequest(
      new Request("https://worker.example/api/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      configuredEnv(),
      ctx,
    );
  }

  async function get(path: string): Promise<Response> {
    return routeRequest(new Request(`https://worker.example${path}`, { method: "GET" }), configuredEnv(), ctx);
  }

  it("persists a SA country score after successful ingest and ranks it on /api/opportunities", async () => {
    const collect = vi.spyOn(googleTrendsModule, "collect").mockResolvedValue(collectResult([saSignal()]));

    const ingest = await post({ product: aliexpressProduct() });
    expect(ingest.status).toBe(201);
    const ingested = (await ingest.json()) as { product: { id: string; title: string } };

    expect(collect.mock.calls[0][0]).toEqual({ keyword: TITLE, geo: "SA" });
    expect(server.store.country_opportunity_scores).toHaveLength(1);
    expect(server.store.country_opportunity_scores[0].country).toBe("SA");
    expect(server.store.country_opportunity_scores[0].product_id).toBe(ingested.product.id);
    expect(server.store.scores).toHaveLength(0);
    expect(
      server.requests.some(
        (request) =>
          (request.method === "POST" || request.method === "PATCH") && request.url.includes("/rest/v1/scores"),
      ),
    ).toBe(false);

    const ranked = (await (await get("/api/opportunities")).json()) as {
      products: Array<{
        id: string;
        decision: { score: { scoreType: string; tier: string; totalWeight: number } };
      }>;
      page: { total: number };
    };
    expect(ranked.products.map((row) => row.id)).toEqual([ingested.product.id]);
    expect(ranked.products[0].decision.score.scoreType).toBe("decision_opportunity");
    expect(ranked.products[0].decision.score.tier).not.toBe("unknown");
    expect(ranked.page.total).toBe(1);

    const listed = (await (await get("/api/products")).json()) as {
      products: Array<{ id: string }>;
    };
    expect(listed.products.map((row) => row.id)).toEqual([ingested.product.id]);
  });

  it("keeps ingest 201 when Trends throws and does not write country or scores rows", async () => {
    vi.spyOn(googleTrendsModule, "collect").mockRejectedValue(new MarketError("TIMEOUT", "google trends timed out"));

    const ingest = await post({ product: aliexpressProduct() });
    expect(ingest.status).toBe(201);

    expect(server.store.products).toHaveLength(1);
    expect(server.store.country_opportunity_scores).toHaveLength(0);
    expect(server.store.scores).toHaveLength(0);

    const ranked = (await (await get("/api/opportunities")).json()) as { products: unknown[]; page: { total: number } };
    expect(ranked.products).toEqual([]);
    expect(ranked.page.total).toBe(0);
  });

  it("keeps ingest 201 when Trends is empty and does not persist a country row", async () => {
    vi.spyOn(googleTrendsModule, "collect").mockResolvedValue(collectResult([]));

    const ingest = await post({ product: aliexpressProduct() });
    expect(ingest.status).toBe(201);
    expect(server.store.country_opportunity_scores).toHaveLength(0);
  });

  it("does not duplicate the SA row on re-ingest", async () => {
    vi.spyOn(googleTrendsModule, "collect").mockResolvedValue(collectResult([saSignal()]));

    const first = await post({ product: aliexpressProduct() });
    expect(first.status).toBe(201);
    const second = await post({ product: { ...aliexpressProduct(), title: "Wireless Earbuds Pro" } });
    expect(second.status).toBe(200);

    expect(server.store.products).toHaveLength(1);
    expect(server.store.country_opportunity_scores).toHaveLength(1);
    expect(server.store.country_opportunity_scores[0].country).toBe("SA");
  });
});
