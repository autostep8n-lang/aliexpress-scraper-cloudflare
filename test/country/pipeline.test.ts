import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MVP_COUNTRY, scoreAndPersistMvpCountryOpportunity } from "../../src/country/pipeline";
import type { Env } from "../../src/env";
import { googleTrendsModule } from "../../src/market/google-trends";
import { MarketError, type GoogleTrendsSignal, type MarketCollectResult } from "../../src/market/types";
import { createMockPostgrest, type MockPostgrest, type RecordedRequest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";
const TITLE = "Wireless Earbuds";

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

  beforeEach(() => {
    server = createMockPostgrest();
    ctx = mockCtx();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hardcodes MVP country SA", () => {
    expect(MVP_COUNTRY).toBe("SA");
  });

  it("writes a SA country_opportunity row when Trends returns finite interest", async () => {
    const collect = vi.spyOn(googleTrendsModule, "collect").mockResolvedValue(collectResult([saSignal()]));

    const result = await scoreAndPersistMvpCountryOpportunity(configuredEnv(), ctx, {
      productId: PRODUCT_ID,
      title: `  ${TITLE}  `,
    });

    expect(result).toEqual({ status: "written", country: "SA", keyword: TITLE });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0][0]).toEqual({ keyword: TITLE, geo: "SA" });
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

  it("always collects geo SA and never US/GB/EU/WORLD", async () => {
    const collect = vi.spyOn(googleTrendsModule, "collect").mockResolvedValue(collectResult([saSignal()]));

    await scoreAndPersistMvpCountryOpportunity(configuredEnv(), ctx, { productId: PRODUCT_ID, title: TITLE });

    for (const call of collect.mock.calls) {
      const query = call[0] as { geo?: unknown };
      expect(query.geo).toBe("SA");
      expect(query.geo).not.toBe("US");
      expect(query.geo).not.toBe("GB");
      expect(query.geo).not.toBe("EU");
      expect(query.geo).not.toBe("WORLD");
      expect(query.geo).not.toBe("UK");
    }
  });

  it("skips INVALID_KEYWORD for empty or overlong titles without calling Trends", async () => {
    const collect = vi.spyOn(googleTrendsModule, "collect");

    const blank = await scoreAndPersistMvpCountryOpportunity(configuredEnv(), ctx, {
      productId: PRODUCT_ID,
      title: "   ",
    });
    const long = await scoreAndPersistMvpCountryOpportunity(configuredEnv(), ctx, {
      productId: PRODUCT_ID,
      title: "x".repeat(201),
    });

    expect(blank).toEqual({ status: "skipped", code: "INVALID_KEYWORD" });
    expect(long).toEqual({ status: "skipped", code: "INVALID_KEYWORD" });
    expect(collect).not.toHaveBeenCalled();
    expect(server.store.country_opportunity_scores).toHaveLength(0);
  });

  it("returns failed TIMEOUT without persisting when Trends throws", async () => {
    vi.spyOn(googleTrendsModule, "collect").mockRejectedValue(new MarketError("TIMEOUT", "google trends timed out"));

    const result = await scoreAndPersistMvpCountryOpportunity(configuredEnv(), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });

    expect(result).toEqual({ status: "failed", code: "TIMEOUT", country: "SA", keyword: TITLE });
    expect(server.store.country_opportunity_scores).toHaveLength(0);
    expect(scoreWrites(server)).toHaveLength(0);
  });

  it("skips UNKNOWN_OR_ZERO_WEIGHT when Trends returns no matching evidence", async () => {
    vi.spyOn(googleTrendsModule, "collect").mockResolvedValue(collectResult([]));

    const result = await scoreAndPersistMvpCountryOpportunity(configuredEnv(), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });

    expect(result).toEqual({ status: "skipped", code: "UNKNOWN_OR_ZERO_WEIGHT", country: "SA", keyword: TITLE });
    expect(server.store.country_opportunity_scores).toHaveLength(0);
  });

  it("skips WORLD-geo signals that do not match SA", async () => {
    vi.spyOn(googleTrendsModule, "collect").mockResolvedValue(
      collectResult([saSignal({ geo: "WORLD" }), saSignal({ geo: "US" })]),
    );

    const result = await scoreAndPersistMvpCountryOpportunity(configuredEnv(), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });

    expect(result.status).toBe("skipped");
    expect(result.code).toBe("UNKNOWN_OR_ZERO_WEIGHT");
    expect(server.store.country_opportunity_scores).toHaveLength(0);
  });

  it("re-scores the same product x SA without duplicating the row", async () => {
    vi.spyOn(googleTrendsModule, "collect")
      .mockResolvedValueOnce(collectResult([saSignal({ value: 80 })]))
      .mockResolvedValueOnce(collectResult([saSignal({ value: 40 })]));

    const first = await scoreAndPersistMvpCountryOpportunity(configuredEnv(), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });
    const second = await scoreAndPersistMvpCountryOpportunity(configuredEnv(), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });

    expect(first.status).toBe("written");
    expect(second.status).toBe("written");
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
    vi.spyOn(googleTrendsModule, "collect").mockResolvedValue(collectResult([saSignal()]));

    const result = await scoreAndPersistMvpCountryOpportunity({} as Env, ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });

    expect(result).toEqual({
      status: "failed",
      code: "SUPABASE_NOT_CONFIGURED",
      country: "SA",
      keyword: TITLE,
    });
  });

  it("returns country_opportunity_upsert_failed when the country table rejects the write", async () => {
    vi.spyOn(googleTrendsModule, "collect").mockResolvedValue(collectResult([saSignal()]));
    server.override("POST", "/rest/v1/country_opportunity_scores", 400, {
      code: "23514",
      message: "new row violates check constraint",
    });

    const result = await scoreAndPersistMvpCountryOpportunity(configuredEnv(), ctx, {
      productId: PRODUCT_ID,
      title: TITLE,
    });

    expect(result.status).toBe("failed");
    expect(result.code).toBe("country_opportunity_upsert_failed");
    expect(scoreWrites(server)).toHaveLength(0);
  });
});
