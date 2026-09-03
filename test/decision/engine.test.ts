import { describe, expect, it } from "vitest";
import type { CountryIntelligenceResult, CountryOpportunityResult, V1Country } from "../../src/country";
import {
  DECISION_OPPORTUNITY_SCORE_TYPE,
  DECISION_OPPORTUNITY_SIGNALS,
  DECISION_OPPORTUNITY_VERSION,
  DecisionError,
  scoreDecisionOpportunity,
} from "../../src/decision";
import type { OpportunityResult } from "../../src/opportunity";
import type { ScoreResult } from "../../src/scoring/types";

const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_PRODUCT_ID = "22222222-2222-2222-2222-222222222222";

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as DecisionError).code).toBe(code);
    return;
  }
  throw new Error(`expected a DecisionError with code ${code}`);
}

function scoreResult(overrides: Partial<ScoreResult> = {}): ScoreResult {
  const normalized = overrides.normalized ?? 0.8;
  const totalWeight = overrides.totalWeight ?? 1;
  return {
    scoreType: "generic",
    version: 1,
    value: Math.round(normalized * 100),
    minValue: 0,
    maxValue: 100,
    normalized,
    totalWeight,
    signals: [],
    inputs: {},
    ...overrides,
  };
}

function marketOpportunity(normalized: number, totalWeight = 1): OpportunityResult {
  const score = scoreResult({
    scoreType: "market_opportunity",
    normalized,
    value: Math.round(normalized * 100),
    totalWeight,
  });
  return {
    competition: scoreResult({ scoreType: "competition", normalized: 0.2, value: 20 }),
    score,
    tier: score.value >= 65 ? "high" : score.value >= 40 ? "medium" : totalWeight === 0 ? "unknown" : "low",
  };
}

function intelligence(country: V1Country): CountryIntelligenceResult {
  return {
    keyword: "smart watch",
    country,
    observationCount: 2,
    latestValue: 80,
    firstValue: 40,
    change: 40,
    direction: "up",
    spanMs: 31 * 24 * 60 * 60 * 1000,
    peakValue: 80,
    capturedAt: "2026-03-01T00:00:00.000Z",
  };
}

function countryOpportunity(
  country: V1Country,
  normalized: number,
  overrides: Partial<CountryOpportunityResult> = {},
): CountryOpportunityResult {
  const score = scoreResult({
    scoreType: "country_opportunity",
    normalized,
    value: Math.round(normalized * 100),
    totalWeight: 0.6,
    ...overrides.score,
  });
  const value = score.value;
  return {
    productId: PRODUCT_ID,
    country,
    keyword: "smart watch",
    countryIntelligence: intelligence(country),
    score,
    tier: value >= 65 ? "high" : value >= 40 ? "medium" : "low",
    ...overrides,
  };
}

function signalByKey(result: ReturnType<typeof scoreDecisionOpportunity>, key: string) {
  return result.score.signals.find((entry) => entry.key === key);
}

function presentKeys(result: ReturnType<typeof scoreDecisionOpportunity>): string[] {
  return result.score.signals.filter((entry) => entry.present).map((entry) => entry.key);
}

describe("scoreDecisionOpportunity", () => {
  it("uses scoreType decision_opportunity, version 1, and equal 0.50 weights", () => {
    const result = scoreDecisionOpportunity({
      productId: PRODUCT_ID,
      marketOpportunity: marketOpportunity(0.8),
    });
    expect(result.score.scoreType).toBe(DECISION_OPPORTUNITY_SCORE_TYPE);
    expect(result.score.version).toBe(DECISION_OPPORTUNITY_VERSION);
    expect(result.score.minValue).toBe(0);
    expect(result.score.maxValue).toBe(100);
    expect(DECISION_OPPORTUNITY_SIGNALS.map((entry) => entry.key)).toEqual([
      "product_market_opportunity",
      "country_opportunity",
    ]);
    expect(DECISION_OPPORTUNITY_SIGNALS.map((entry) => entry.weight)).toEqual([0.5, 0.5]);
  });

  it("rejects a missing productId", () => {
    expectCode(() => scoreDecisionOpportunity({ productId: "" }), "INVALID_PRODUCT");
    expectCode(() => scoreDecisionOpportunity({ productId: "   " }), "INVALID_PRODUCT");
  });

  it("returns unknown when no product or country signal is present", () => {
    const result = scoreDecisionOpportunity({ productId: ` ${PRODUCT_ID} ` });
    expect(result.productId).toBe(PRODUCT_ID);
    expect(result.score.totalWeight).toBe(0);
    expect(result.score.value).toBe(0);
    expect(result.tier).toBe("unknown");
    expect(result.selectedCountry).toBeNull();
    expect(result.marketOpportunity).toBeNull();
    expect(result.selectedCountryOpportunity).toBeNull();
    expect(presentKeys(result)).toEqual([]);
  });

  it("uses only the P1.10 market opportunity when no eligible country scores exist", () => {
    const market = marketOpportunity(0.8);
    const result = scoreDecisionOpportunity({ productId: PRODUCT_ID, marketOpportunity: market });
    expect(presentKeys(result)).toEqual(["product_market_opportunity"]);
    expect(signalByKey(result, "product_market_opportunity")?.value).toBe(0.8);
    expect(signalByKey(result, "country_opportunity")?.present).toBe(false);
    expect(result.score.totalWeight).toBe(0.5);
    expect(result.score.normalized).toBe(0.8);
    expect(result.score.value).toBe(80);
    expect(result.tier).toBe("high");
    expect(result.marketOpportunity).toBe(market);
    expect(result.selectedCountry).toBeNull();
  });

  it("uses only the selected country opportunity when market opportunity is absent", () => {
    const selected = countryOpportunity("US", 0.72);
    const result = scoreDecisionOpportunity({
      productId: PRODUCT_ID,
      countryOpportunities: [selected],
    });
    expect(presentKeys(result)).toEqual(["country_opportunity"]);
    expect(signalByKey(result, "country_opportunity")?.value).toBe(0.72);
    expect(signalByKey(result, "country_opportunity")?.detail).toBe("US 72");
    expect(result.score.totalWeight).toBe(0.5);
    expect(result.score.normalized).toBe(0.72);
    expect(result.score.value).toBe(72);
    expect(result.tier).toBe("high");
    expect(result.selectedCountry).toBe("US");
    expect(result.selectedCountryOpportunity).toBe(selected);
    expect(result.marketOpportunity).toBeNull();
  });

  it("averages present P1.10 and P4.23 signals at equal weight", () => {
    const result = scoreDecisionOpportunity({
      productId: PRODUCT_ID,
      marketOpportunity: marketOpportunity(0.4),
      countryOpportunities: [countryOpportunity("GB", 0.8)],
    });
    expect(presentKeys(result)).toEqual(["product_market_opportunity", "country_opportunity"]);
    expect(result.score.totalWeight).toBe(1);
    expect(result.score.normalized).toBe(0.6);
    expect(result.score.value).toBe(60);
    expect(result.tier).toBe("medium");
    expect(result.selectedCountry).toBe("GB");
  });

  it("excludes unknown-tier and zero-weight country rows from selection", () => {
    const unknown = countryOpportunity("US", 0.99, { tier: "unknown" });
    const empty = countryOpportunity("SA", 0.95, {
      score: scoreResult({ scoreType: "country_opportunity", normalized: 0.95, value: 95, totalWeight: 0 }),
    });
    const eligible = countryOpportunity("DE", 0.5);
    const result = scoreDecisionOpportunity({
      productId: PRODUCT_ID,
      countryOpportunities: [unknown, empty, eligible],
    });
    expect(result.selectedCountry).toBe("DE");
    expect(signalByKey(result, "country_opportunity")?.value).toBe(0.5);
  });

  it("ignores country scores for a different product", () => {
    const other = countryOpportunity("US", 0.99, { productId: OTHER_PRODUCT_ID });
    const result = scoreDecisionOpportunity({
      productId: PRODUCT_ID,
      marketOpportunity: marketOpportunity(0.4),
      countryOpportunities: [other],
    });
    expect(presentKeys(result)).toEqual(["product_market_opportunity"]);
    expect(result.selectedCountry).toBeNull();
  });

  it("selects the highest normalized country, then value, then lexicographic country", () => {
    const byNormalized = scoreDecisionOpportunity({
      productId: PRODUCT_ID,
      countryOpportunities: [countryOpportunity("US", 0.7), countryOpportunity("GB", 0.9)],
    });
    expect(byNormalized.selectedCountry).toBe("GB");

    const byValue = scoreDecisionOpportunity({
      productId: PRODUCT_ID,
      countryOpportunities: [
        countryOpportunity("US", 0.7, {
          score: scoreResult({ scoreType: "country_opportunity", normalized: 0.7, value: 70, totalWeight: 0.6 }),
        }),
        countryOpportunity("FR", 0.7, {
          score: scoreResult({ scoreType: "country_opportunity", normalized: 0.7, value: 71, totalWeight: 0.6 }),
        }),
      ],
    });
    expect(byValue.selectedCountry).toBe("FR");

    const byCode = scoreDecisionOpportunity({
      productId: PRODUCT_ID,
      countryOpportunities: [countryOpportunity("US", 0.7), countryOpportunity("DE", 0.7)],
    });
    expect(byCode.selectedCountry).toBe("DE");
  });

  it("ignores a market opportunity that is not scoreType market_opportunity or has no weight", () => {
    const wrongType: OpportunityResult = {
      competition: scoreResult({ scoreType: "competition" }),
      score: scoreResult({ scoreType: "decision_opportunity", normalized: 0.9, value: 90, totalWeight: 1 }),
      tier: "high",
    };
    const empty = marketOpportunity(0.9, 0);
    expect(
      scoreDecisionOpportunity({ productId: PRODUCT_ID, marketOpportunity: wrongType }).marketOpportunity,
    ).toBeNull();
    expect(presentKeys(scoreDecisionOpportunity({ productId: PRODUCT_ID, marketOpportunity: empty }))).toEqual([]);
  });

  it("derives high/medium/low/unknown from 65 and 40", () => {
    expect(
      scoreDecisionOpportunity({ productId: PRODUCT_ID, marketOpportunity: marketOpportunity(0.65) }).tier,
    ).toBe("high");
    expect(
      scoreDecisionOpportunity({ productId: PRODUCT_ID, marketOpportunity: marketOpportunity(0.64) }).tier,
    ).toBe("medium");
    expect(
      scoreDecisionOpportunity({ productId: PRODUCT_ID, marketOpportunity: marketOpportunity(0.4) }).tier,
    ).toBe("medium");
    expect(
      scoreDecisionOpportunity({ productId: PRODUCT_ID, marketOpportunity: marketOpportunity(0.39) }).tier,
    ).toBe("low");
    expect(scoreDecisionOpportunity({ productId: PRODUCT_ID }).tier).toBe("unknown");
  });

  it("is fully deterministic for identical inputs", () => {
    const input = {
      productId: PRODUCT_ID,
      marketOpportunity: marketOpportunity(0.55),
      countryOpportunities: [countryOpportunity("IT", 0.4), countryOpportunity("ES", 0.6)],
    };
    expect(scoreDecisionOpportunity(input)).toEqual(scoreDecisionOpportunity(input));
  });
});
