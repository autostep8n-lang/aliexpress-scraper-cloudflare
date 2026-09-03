import { describe, expect, it } from "vitest";
import {
  analyzeCountryIntelligence,
  COUNTRY_OPPORTUNITY_SCORE_TYPE,
  COUNTRY_OPPORTUNITY_SIGNALS,
  COUNTRY_OPPORTUNITY_VERSION,
  CountryError,
  normalizeCountry,
  normalizeKeyword,
  scoreCountryOpportunity,
  toCountryOpportunityRow,
  V1_COUNTRIES,
} from "../../src/country";
import type { CountryIntelligenceResult, CountryOpportunityInput } from "../../src/country";
import type { GoogleTrendsSignal } from "../../src/market/types";
import type { ProfitResult } from "../../src/profit/types";
import type { ScoreResult } from "../../src/scoring/types";

const CAPTURED_AT = "2026-03-01T00:00:00.000Z";
const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as CountryError).code).toBe(code);
    return;
  }
  throw new Error(`expected a CountryError with code ${code}`);
}

function signal(overrides: Partial<GoogleTrendsSignal> = {}): GoogleTrendsSignal {
  return {
    keyword: "smart watch",
    geo: "US",
    property: "web",
    category: null,
    timeRange: "today 5-y",
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-02-01T00:00:00.000Z",
    value: 50,
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

function intelligence(overrides: Partial<CountryIntelligenceResult> = {}): CountryIntelligenceResult {
  return {
    keyword: "smart watch",
    country: "US",
    observationCount: 0,
    latestValue: null,
    firstValue: null,
    change: null,
    direction: "unknown",
    spanMs: null,
    peakValue: null,
    capturedAt: null,
    ...overrides,
  };
}

function competitionScore(normalized: number, totalWeight = 1): ScoreResult {
  return {
    scoreType: "competition",
    version: 1,
    value: Math.round(normalized * 100),
    minValue: 0,
    maxValue: 100,
    normalized,
    totalWeight,
    signals: [],
    inputs: {},
  };
}

function profitMargin(marginPct: number): ProfitResult {
  return {
    currency: "USD",
    sellingPrice: 100,
    supplierCost: 50,
    shippingCost: 0,
    platformFees: 0,
    advertisingCost: 0,
    refundAllowance: 0,
    totalCost: 50,
    netProfit: 50,
    profitMarginPct: marginPct,
    roi: 100,
    complete: true,
    breakEven: false,
    components: [],
    inputs: {},
  };
}

function scoreInput(overrides: Partial<CountryOpportunityInput> = {}): CountryOpportunityInput {
  return {
    productId: PRODUCT_ID,
    country: "US",
    keyword: "smart watch",
    countryIntelligence: intelligence(),
    ...overrides,
  };
}

function presentKeys(result: ReturnType<typeof scoreCountryOpportunity>): string[] {
  return result.score.signals.filter((entry) => entry.present).map((entry) => entry.key);
}

function signalByKey(result: ReturnType<typeof scoreCountryOpportunity>, key: string) {
  return result.score.signals.find((entry) => entry.key === key);
}

describe("normalizeCountry", () => {
  it("uppercases allowlisted ISO alpha-2 codes", () => {
    expect(V1_COUNTRIES).toEqual(["SA", "US", "GB", "DE", "FR", "ES", "IT"]);
    for (const code of V1_COUNTRIES) {
      expect(normalizeCountry(code.toLowerCase())).toBe(code);
      expect(normalizeCountry(` ${code.toLowerCase()} `)).toBe(code);
    }
  });

  it("rejects UK, EU, WORLD, regional codes, and unsupported countries", () => {
    for (const value of ["UK", "uk", "EU", "WORLD", "GB-SCT", "NL", "", "  "]) {
      expectCode(() => normalizeCountry(value), "INVALID_COUNTRY");
    }
    expectCode(() => normalizeCountry(undefined), "INVALID_COUNTRY");
    expectCode(() => normalizeCountry(12), "INVALID_COUNTRY");
  });
});

describe("normalizeKeyword", () => {
  it("trims and accepts numeric keywords, rejecting empty or overlong values", () => {
    expect(normalizeKeyword("  phone  ")).toBe("phone");
    expect(normalizeKeyword(42)).toBe("42");
    expect(normalizeKeyword("x".repeat(200))).toHaveLength(200);
    expectCode(() => normalizeKeyword(""), "INVALID_KEYWORD");
    expectCode(() => normalizeKeyword("   "), "INVALID_KEYWORD");
    expectCode(() => normalizeKeyword("x".repeat(201)), "INVALID_KEYWORD");
  });
});

describe("analyzeCountryIntelligence", () => {
  it("returns null evidence and unknown direction when Trends are empty", () => {
    const result = analyzeCountryIntelligence({
      query: { keyword: "smart watch", country: "us" },
      trends: [],
    });
    expect(result).toEqual({
      keyword: "smart watch",
      country: "US",
      observationCount: 0,
      latestValue: null,
      firstValue: null,
      change: null,
      direction: "unknown",
      spanMs: null,
      peakValue: null,
      capturedAt: null,
    });
  });

  it("filters strictly by exact keyword and country geo", () => {
    const result = analyzeCountryIntelligence({
      query: { keyword: "smart watch", country: "US" },
      trends: [
        signal({ geo: "DE", value: 99 }),
        signal({ keyword: "phone", value: 88 }),
        signal({ geo: "WORLD", value: 77 }),
        signal({ geo: "GB", value: 66 }),
        signal({ value: Number.NaN }),
        signal({ value: 12, periodStart: "2026-01-01T00:00:00.000Z" }),
        signal({ value: 40, periodStart: "2026-02-01T00:00:00.000Z", capturedAt: "2026-03-02T00:00:00.000Z" }),
      ],
    });
    expect(result.observationCount).toBe(2);
    expect(result.firstValue).toBe(12);
    expect(result.latestValue).toBe(40);
    expect(result.peakValue).toBe(40);
    expect(result.change).toBe(28);
    expect(result.direction).toBe("up");
    expect(result.capturedAt).toBe("2026-03-02T00:00:00.000Z");
    expect(result.spanMs).toBe(31 * 24 * 60 * 60 * 1000);
  });

  it("treats a single point as level-only evidence without inventing momentum", () => {
    const result = analyzeCountryIntelligence({
      query: { keyword: "smart watch", country: "SA" },
      trends: [signal({ geo: "SA", value: 80 })],
    });
    expect(result.observationCount).toBe(1);
    expect(result.latestValue).toBe(80);
    expect(result.firstValue).toBe(80);
    expect(result.peakValue).toBe(80);
    expect(result.change).toBeNull();
    expect(result.direction).toBe("unknown");
    expect(result.spanMs).toBeNull();
    expect(result.capturedAt).toBe(CAPTURED_AT);
  });

  it("reports up, down, and flat momentum independently of input order", () => {
    const later = "2026-02-01T00:00:00.000Z";
    const up = analyzeCountryIntelligence({
      query: { keyword: "smart watch", country: "US" },
      trends: [signal({ value: 90, periodStart: later }), signal({ value: 10 })],
    });
    expect(up.direction).toBe("up");
    expect(up.change).toBe(80);
    expect(up.latestValue).toBe(90);
    expect(up.firstValue).toBe(10);

    const down = analyzeCountryIntelligence({
      query: { keyword: "smart watch", country: "US" },
      trends: [signal({ value: 10, periodStart: later }), signal({ value: 90 })],
    });
    expect(down.direction).toBe("down");
    expect(down.change).toBe(-80);

    const flat = analyzeCountryIntelligence({
      query: { keyword: "smart watch", country: "US" },
      trends: [signal({ value: 50, periodStart: later }), signal({ value: 50 })],
    });
    expect(flat.direction).toBe("flat");
    expect(flat.change).toBe(0);
  });

  it("rejects unsupported countries before reading Trends", () => {
    expectCode(
      () =>
        analyzeCountryIntelligence({
          query: { keyword: "smart watch", country: "UK" },
          trends: [signal({ geo: "GB", value: 50 })],
        }),
      "INVALID_COUNTRY",
    );
  });
});

describe("scoreCountryOpportunity", () => {
  it("uses scoreType country_opportunity and version 1", () => {
    const result = scoreCountryOpportunity(
      scoreInput({
        countryIntelligence: intelligence({ latestValue: 50, observationCount: 1 }),
      }),
    );
    expect(result.score.scoreType).toBe(COUNTRY_OPPORTUNITY_SCORE_TYPE);
    expect(result.score.version).toBe(COUNTRY_OPPORTUNITY_VERSION);
    expect(result.score.minValue).toBe(0);
    expect(result.score.maxValue).toBe(100);
    expect(COUNTRY_OPPORTUNITY_SIGNALS.map((entry) => entry.key)).toEqual([
      "country_search_level",
      "country_search_momentum",
      "competition_headroom",
      "demand_volume",
      "profit_margin",
    ]);
    expect(COUNTRY_OPPORTUNITY_SIGNALS.map((entry) => entry.weight)).toEqual([0.4, 0.2, 0.15, 0.15, 0.1]);
  });

  it("scores a single Trends point as country_search_level only", () => {
    const intel = analyzeCountryIntelligence({
      query: { keyword: "smart watch", country: "US" },
      trends: [signal({ value: 80 })],
    });
    const result = scoreCountryOpportunity(scoreInput({ countryIntelligence: intel }));
    expect(presentKeys(result)).toEqual(["country_search_level"]);
    expect(signalByKey(result, "country_search_level")?.value).toBe(0.8);
    expect(signalByKey(result, "country_search_momentum")?.present).toBe(false);
    expect(result.score.totalWeight).toBe(0.4);
    expect(result.score.normalized).toBe(0.8);
    expect(result.score.value).toBe(80);
    expect(result.tier).toBe("high");
  });

  it("computes up momentum as clamp((change / 100 + 1) / 2, 0, 1)", () => {
    const intel = analyzeCountryIntelligence({
      query: { keyword: "smart watch", country: "US" },
      trends: [signal({ value: 10 }), signal({ value: 90, periodStart: "2026-02-01T00:00:00.000Z" })],
    });
    const result = scoreCountryOpportunity(scoreInput({ countryIntelligence: intel }));
    expect(signalByKey(result, "country_search_level")?.value).toBe(0.9);
    expect(signalByKey(result, "country_search_momentum")?.value).toBe(0.9);
    expect(result.score.totalWeight).toBe(0.6);
    expect(result.score.normalized).toBe(0.9);
    expect(result.score.value).toBe(90);
    expect(result.tier).toBe("high");
  });

  it("computes down and flat momentum without treating missing product signals as zero", () => {
    const later = "2026-02-01T00:00:00.000Z";
    const down = scoreCountryOpportunity(
      scoreInput({
        countryIntelligence: analyzeCountryIntelligence({
          query: { keyword: "smart watch", country: "US" },
          trends: [signal({ value: 90 }), signal({ value: 10, periodStart: later })],
        }),
      }),
    );
    expect(signalByKey(down, "country_search_momentum")?.value).toBeCloseTo(0.1, 10);
    expect(presentKeys(down)).toEqual(["country_search_level", "country_search_momentum"]);

    const flat = scoreCountryOpportunity(
      scoreInput({
        countryIntelligence: analyzeCountryIntelligence({
          query: { keyword: "smart watch", country: "US" },
          trends: [signal({ value: 20 }), signal({ value: 20, periodStart: later })],
        }),
      }),
    );
    expect(signalByKey(flat, "country_search_level")?.value).toBe(0.2);
    expect(signalByKey(flat, "country_search_momentum")?.value).toBe(0.5);
    expect(flat.score.totalWeight).toBe(0.6);
    expect(flat.score.normalized).toBe(0.3);
    expect(flat.score.value).toBe(30);
    expect(flat.tier).toBe("low");
  });

  it("excludes omitted competition, demand, and profit from the denominator", () => {
    const result = scoreCountryOpportunity(
      scoreInput({
        countryIntelligence: intelligence({ latestValue: 50, observationCount: 1 }),
      }),
    );
    expect(presentKeys(result)).toEqual(["country_search_level"]);
    expect(result.score.totalWeight).toBe(0.4);
    expect(signalByKey(result, "competition_headroom")?.present).toBe(false);
    expect(signalByKey(result, "demand_volume")?.present).toBe(false);
    expect(signalByKey(result, "profit_margin")?.present).toBe(false);
  });

  it("forces tier unknown when both country search signals are absent even if product signals are strong", () => {
    const result = scoreCountryOpportunity(
      scoreInput({
        countryIntelligence: intelligence(),
        competition: competitionScore(0),
        demand: { rating: { count: 999_999 } },
        profit: profitMargin(40),
      }),
    );
    expect(signalByKey(result, "country_search_level")?.present).toBe(false);
    expect(signalByKey(result, "country_search_momentum")?.present).toBe(false);
    expect(signalByKey(result, "competition_headroom")?.value).toBe(1);
    expect(signalByKey(result, "demand_volume")?.value).toBe(1);
    expect(signalByKey(result, "profit_margin")?.value).toBe(1);
    expect(result.score.totalWeight).toBe(0.4);
    expect(result.score.value).toBe(100);
    expect(result.tier).toBe("unknown");
  });

  it("maps competition headroom, demand volume, and profit margin with the approved formulas", () => {
    const result = scoreCountryOpportunity(
      scoreInput({
        countryIntelligence: intelligence({ latestValue: 50, observationCount: 1 }),
        competition: competitionScore(0.4),
        demand: { rating: { count: 999 } },
        profit: profitMargin(20),
      }),
    );
    expect(signalByKey(result, "competition_headroom")?.value).toBeCloseTo(0.6, 10);
    expect(signalByKey(result, "demand_volume")?.value).toBeCloseTo(0.5, 10);
    expect(signalByKey(result, "profit_margin")?.value).toBe(0.5);
    expect(result.score.totalWeight).toBe(0.8);
    const weighted = 0.5 * 0.4 + 0.6 * 0.15 + 0.5 * 0.15 + 0.5 * 0.1;
    expect(result.score.normalized).toBeCloseTo(weighted / 0.8, 4);
    expect(result.score.value).toBe(Math.round((weighted / 0.8) * 100));
  });

  it("derives high/medium/low from 65 and 40 when country evidence is present", () => {
    expect(
      scoreCountryOpportunity(scoreInput({ countryIntelligence: intelligence({ latestValue: 65, observationCount: 1 }) }))
        .tier,
    ).toBe("high");
    expect(
      scoreCountryOpportunity(scoreInput({ countryIntelligence: intelligence({ latestValue: 64, observationCount: 1 }) }))
        .tier,
    ).toBe("medium");
    expect(
      scoreCountryOpportunity(scoreInput({ countryIntelligence: intelligence({ latestValue: 40, observationCount: 1 }) }))
        .tier,
    ).toBe("medium");
    expect(
      scoreCountryOpportunity(scoreInput({ countryIntelligence: intelligence({ latestValue: 39, observationCount: 1 }) }))
        .tier,
    ).toBe("low");
  });

  it("is fully deterministic for identical inputs", () => {
    const input = scoreInput({
      countryIntelligence: analyzeCountryIntelligence({
        query: { keyword: "smart watch", country: "gb" },
        trends: [signal({ geo: "GB", value: 30 }), signal({ geo: "GB", value: 70, periodStart: "2026-02-01T00:00:00.000Z" })],
      }),
      country: "gb",
      competition: competitionScore(0.2),
      demand: { rating: { count: 1200 } },
      profit: profitMargin(12),
    });
    expect(scoreCountryOpportunity(input)).toEqual(scoreCountryOpportunity(input));
  });

  it("rejects UK and invalid product or keyword before scoring", () => {
    expectCode(
      () =>
        scoreCountryOpportunity(
          scoreInput({ country: "UK", countryIntelligence: intelligence({ country: "GB", latestValue: 50 }) }),
        ),
      "INVALID_COUNTRY",
    );
    expectCode(() => scoreCountryOpportunity(scoreInput({ productId: "  " })), "INVALID_PRODUCT");
    expectCode(() => scoreCountryOpportunity(scoreInput({ keyword: "" })), "INVALID_KEYWORD");
  });
});

describe("toCountryOpportunityRow", () => {
  it("maps the score and country evidence without writing to public.scores", () => {
    const scored = scoreCountryOpportunity(
      scoreInput({
        countryIntelligence: intelligence({
          latestValue: 80,
          change: 20,
          direction: "up",
          observationCount: 2,
          capturedAt: CAPTURED_AT,
        }),
      }),
    );
    expect(toCountryOpportunityRow(scored)).toMatchObject({
      product_id: PRODUCT_ID,
      country: "US",
      keyword: "smart watch",
      score_type: "country_opportunity",
      value: scored.score.value,
      min_value: 0,
      max_value: 100,
      normalized: scored.score.normalized,
      total_weight: scored.score.totalWeight,
      tier: scored.tier,
      version: 1,
      country_latest_value: 80,
      country_change: 20,
      country_direction: "up",
      computed_at: CAPTURED_AT,
    });
  });
});
