import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MVP_COUNTRY, scoreAndPersistMvpCountryOpportunity } from "../../src/country/pipeline";
import type { Env } from "../../src/env";
import { googleTrendsModule, readCachedGoogleTrendsSignals } from "../../src/market/google-trends";
import type { GoogleTrendsSignal } from "../../src/market/types";
import { createMockPostgrest, type MockPostgrest, type RecordedRequest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";
const TITLE = "Wireless Earbuds";

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

function configuredEnv(kv?: MemoryKV): Env {
  return {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: SECRET_KEY,
    ...(kv ? { SCRAPE_CACHE: kv as unknown as KVNamespace } : {}),
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

function saSignal(overrides: Partial<GoogleTrendsSignal> = {}): GoogleTrendsSignal {
  return {
    keyword: TITLE,
    geo: "SA",
    property: "web",
    category: null,
    timeRange: "today 5-y",
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-02-01T00:00:00.000Z",
    value: 80,
    capturedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

async function seedCachedSignals(kv: MemoryKV, signals: GoogleTrendsSignal[], keyword = TITLE): Promise<void> {
  await kv.put(trendsCacheKey(keyword), JSON.stringify(signals));
}

function requestsTo(server: MockPostgrest, method: string, path: string): RecordedRequest[] {
  return server.requests.filter((request) => request.method === method && request.url.includes(path));
}

function scoreWrites(server: MockPostgrest): RecordedRequest[] {
  return server.requests.filter(
    (request) =>
      (request.method === "POST" || request.method === "PATCH") && request.url.includes("/rest/v1/scores"),
  );
}

describe("scoreAndPersistMvpCountryOpportunity", () => {
  let server: MockPostgrest;
  let ctx: ExecutionContext;
  let kv: MemoryKV;
  let collect: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = createMockPostgrest();
    ctx = mockCtx();
    kv = new MemoryKV();
    vi.stubGlobal("fetch", server.fetch);
    collect = vi.spyOn(googleTrendsModule, "collect").mockRejectedValue(new Error("collect must not be called"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hardcodes MVP country SA", () => {
    expect(MVP_COUNTRY).toBe("SA");
  });

  it("writes a SA country_opportunity row from cached finite interest without collecting", async () => {
    await seedCachedSignals(kv, [saSignal()]);

    const result = await scoreAndPersistMvpCountryOpportunity(configuredEnv(kv), ctx, {
      productId: PRODUCT_ID,
      title: `  ${TITLE}  `,
    });

    expect(result).toEqual({ status: "written", country: "SA", keyword: TITLE });
    expect(collect).not.toHaveBeenCalled();
    expect(server.store.country_opportunity_scores).toHaveLength(1);

    const row = server.store.country_opportunity_scores[0];
    expect(row.product_id).toBe(PRODUCT_ID);
    expect(row.country).toBe("SA");
    expect(row.keyword).toBe(TITLE);
    expect(row.score_type).toBe("country_opportunity");
    expect(row.tier).not.toBe("unknown");
    expect(Number(row.total_weight)).toBeGreaterThan(0);
    expect(scoreWrites(server)).toHaveLength(0);
    expect((ctx as unknown as { waitUntil: ReturnType<typeof vi.fn> }).waitUntil).not.toHaveBeenCalled();
  });

  it("reads cached geo SA signals and never US/GB/EU/WORLD", async () => {
    await kv.put(trendsCacheKey(TITLE, "US"), JSON.stringify([saSignal({ geo: "US" })]));
    await seedCachedSignals(kv, [saSignal()]);

    const result = await scoreAndPersistMvpCountryOpportunity(configuredEnv(kv), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });

    expect(result).toEqual({ status: "written", country: "SA", keyword: TITLE });
    expect(server.store.country_opportunity_scores[0].country).toBe("SA");
    expect(collect).not.toHaveBeenCalled();
  });

  it("skips INVALID_KEYWORD for empty or overlong titles without calling Trends", async () => {
    const blank = await scoreAndPersistMvpCountryOpportunity(configuredEnv(kv), ctx, {
      productId: PRODUCT_ID,
      title: "   ",
    });
    const long = await scoreAndPersistMvpCountryOpportunity(configuredEnv(kv), ctx, {
      productId: PRODUCT_ID,
      title: "x".repeat(201),
    });

    expect(blank).toEqual({ status: "skipped", code: "INVALID_KEYWORD" });
    expect(long).toEqual({ status: "skipped", code: "INVALID_KEYWORD" });
    expect(collect).not.toHaveBeenCalled();
    expect(server.store.country_opportunity_scores).toHaveLength(0);
  });

  it("skips TRENDS_UNAVAILABLE on cache miss without collecting or persisting", async () => {
    const result = await scoreAndPersistMvpCountryOpportunity(configuredEnv(kv), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });

    expect(result).toEqual({ status: "skipped", code: "TRENDS_UNAVAILABLE", country: "SA", keyword: TITLE });
    expect(collect).not.toHaveBeenCalled();
    expect(server.store.country_opportunity_scores).toHaveLength(0);
    expect(scoreWrites(server)).toHaveLength(0);
  });

  it("skips UNKNOWN_OR_ZERO_WEIGHT when the cache holds no matching evidence", async () => {
    await seedCachedSignals(kv, []);

    const result = await scoreAndPersistMvpCountryOpportunity(configuredEnv(kv), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });

    expect(result).toEqual({ status: "skipped", code: "UNKNOWN_OR_ZERO_WEIGHT", country: "SA", keyword: TITLE });
    expect(collect).not.toHaveBeenCalled();
    expect(server.store.country_opportunity_scores).toHaveLength(0);
  });

  it("skips WORLD-geo cached signals that do not match SA", async () => {
    await seedCachedSignals(kv, [saSignal({ geo: "WORLD" }), saSignal({ geo: "US" })]);

    const result = await scoreAndPersistMvpCountryOpportunity(configuredEnv(kv), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });

    expect(result.status).toBe("skipped");
    expect(result.code).toBe("UNKNOWN_OR_ZERO_WEIGHT");
    expect(collect).not.toHaveBeenCalled();
    expect(server.store.country_opportunity_scores).toHaveLength(0);
  });

  it("re-scores the same product x SA from cache without duplicating the row", async () => {
    await seedCachedSignals(kv, [saSignal({ value: 80 })]);

    const first = await scoreAndPersistMvpCountryOpportunity(configuredEnv(kv), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });
    const second = await scoreAndPersistMvpCountryOpportunity(configuredEnv(kv), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });

    expect(first.status).toBe("written");
    expect(second.status).toBe("written");
    expect(collect).not.toHaveBeenCalled();
    expect(server.store.country_opportunity_scores).toHaveLength(1);
    expect(server.store.country_opportunity_scores[0].country).toBe("SA");
    expect(server.store.country_opportunity_scores[0].product_id).toBe(PRODUCT_ID);
    expect(requestsTo(server, "POST", "/rest/v1/country_opportunity_scores")).toHaveLength(2);
    const conflict = new URL(requestsTo(server, "POST", "/rest/v1/country_opportunity_scores")[0].url).searchParams.get(
      "on_conflict",
    );
    expect(conflict).toBe("product_id,country,score_type");
  });

  it("returns SUPABASE_NOT_CONFIGURED without writing when credentials are missing", async () => {
    await seedCachedSignals(kv, [saSignal()]);

    const result = await scoreAndPersistMvpCountryOpportunity(
      { SCRAPE_CACHE: kv as unknown as KVNamespace } as Env,
      ctx,
      {
        productId: PRODUCT_ID,
        title: TITLE,
      },
    );

    expect(result).toEqual({
      status: "failed",
      code: "SUPABASE_NOT_CONFIGURED",
      country: "SA",
      keyword: TITLE,
    });
    expect(collect).not.toHaveBeenCalled();
  });

  it("returns country_opportunity_upsert_failed when the country table rejects the write", async () => {
    await seedCachedSignals(kv, [saSignal()]);
    server.override("POST", "/rest/v1/country_opportunity_scores", 400, {
      code: "23514",
      message: "new row violates check constraint",
    });

    const result = await scoreAndPersistMvpCountryOpportunity(configuredEnv(kv), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });

    expect(result.status).toBe("failed");
    expect(result.code).toBe("country_opportunity_upsert_failed");
    expect(collect).not.toHaveBeenCalled();
    expect(scoreWrites(server)).toHaveLength(0);
  });

  it("shares the collect cache key so a prior collect write is readable without a second collect", async () => {
    await seedCachedSignals(kv, [saSignal()]);
    const env = configuredEnv(kv);

    const cached = await readCachedGoogleTrendsSignals({ keyword: TITLE, geo: "SA" }, env);
    expect(cached).toEqual([saSignal()]);

    const result = await scoreAndPersistMvpCountryOpportunity(env, ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });
    expect(result.status).toBe("written");
    expect(collect).not.toHaveBeenCalled();
  });
});
