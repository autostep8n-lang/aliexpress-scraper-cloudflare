import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { googleTrendsModule } from "../../src/market/google-trends";
import type { GoogleTrendsSignal } from "../../src/market/types";
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

class MemoryKV {
  private readonly store = new Map<string, { value: string; ttl?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    return entry ? entry.value : null;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, ttl: opts?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function trendsCacheKey(keyword: string, geo = "SA"): string {
  return `market:google-trends:${geo}:web:today 5-y::${keyword.toLowerCase()}`;
}

function configuredEnv(kv: MemoryKV): Env {
  return {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: SECRET_KEY,
    SCRAPE_CACHE: kv as unknown as KVNamespace,
  } as Env;
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

describe("POST /api/products country opportunity glue", () => {
  let server: MockPostgrest;
  let ctx: ExecutionContext;
  let kv: MemoryKV;
  let collect: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = createMockPostgrest();
    server.seed("sources", [SOURCE_ALIEXPRESS]);
    ctx = mockCtx();
    kv = new MemoryKV();
    vi.stubGlobal("fetch", server.fetch);
    collect = vi.spyOn(googleTrendsModule, "collect").mockRejectedValue(new Error("collect must not be called"));
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
      configuredEnv(kv),
      ctx,
    );
  }

  async function get(path: string): Promise<Response> {
    return routeRequest(new Request(`https://worker.example${path}`, { method: "GET" }), configuredEnv(kv), ctx);
  }

  it("persists a SA country score from cache after ingest without calling collect", async () => {
    await kv.put(trendsCacheKey(TITLE), JSON.stringify([saSignal()]));

    const ingest = await post({ product: aliexpressProduct() });
    expect(ingest.status).toBe(201);
    const ingested = (await ingest.json()) as { product: { id: string; title: string } };

    expect(collect).not.toHaveBeenCalled();
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
    expect(server.requests.some((request) => request.url.includes("trends.google.com"))).toBe(false);

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

  it("keeps ingest 201 on cache miss without live Trends or country rows", async () => {
    const ingest = await post({ product: aliexpressProduct() });
    expect(ingest.status).toBe(201);

    expect(collect).not.toHaveBeenCalled();
    expect(server.store.products).toHaveLength(1);
    expect(server.store.country_opportunity_scores).toHaveLength(0);
    expect(server.store.scores).toHaveLength(0);
    expect(server.requests.some((request) => request.url.includes("trends.google.com"))).toBe(false);

    const ranked = (await (await get("/api/opportunities")).json()) as { products: unknown[]; page: { total: number } };
    expect(ranked.products).toEqual([]);
    expect(ranked.page.total).toBe(0);
  });

  it("keeps ingest 201 when cached Trends are empty and does not persist a country row", async () => {
    await kv.put(trendsCacheKey(TITLE), JSON.stringify([]));

    const ingest = await post({ product: aliexpressProduct() });
    expect(ingest.status).toBe(201);
    expect(collect).not.toHaveBeenCalled();
    expect(server.store.country_opportunity_scores).toHaveLength(0);
  });

  it("does not duplicate the SA row on re-ingest", async () => {
    await kv.put(trendsCacheKey(TITLE), JSON.stringify([saSignal()]));
    await kv.put(trendsCacheKey("Wireless Earbuds Pro"), JSON.stringify([saSignal("Wireless Earbuds Pro")]));

    const first = await post({ product: aliexpressProduct() });
    expect(first.status).toBe(201);
    const second = await post({ product: { ...aliexpressProduct(), title: "Wireless Earbuds Pro" } });
    expect(second.status).toBe(200);

    expect(collect).not.toHaveBeenCalled();
    expect(server.store.products).toHaveLength(1);
    expect(server.store.country_opportunity_scores).toHaveLength(1);
    expect(server.store.country_opportunity_scores[0].country).toBe("SA");
  });
});
