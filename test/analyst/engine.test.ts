import { describe, expect, it } from "vitest";
import { buildAnalystEvidence, explainDecision } from "../../src/analyst";
import type { AnalystResult } from "../../src/analyst";
import type { CountryIntelligenceResult, CountryOpportunityResult, V1Country } from "../../src/country";
import { scoreDecisionOpportunity } from "../../src/decision";
import type { DecisionOpportunityInput, DecisionOpportunityResult } from "../../src/decision";
import type { OpportunityResult, OpportunityTier } from "../../src/opportunity";
import type { ScoreResult, ScoreSignal } from "../../src/scoring/types";

const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";

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

function marketOpportunity(normalized: number, totalWeight = 1, signals: ScoreSignal[] = []): OpportunityResult {
  const score = scoreResult({
    scoreType: "market_opportunity",
    normalized,
    value: Math.round(normalized * 100),
    totalWeight,
    signals,
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

function decide(overrides: Omit<DecisionOpportunityInput, "productId"> = {}): DecisionOpportunityResult {
  return scoreDecisionOpportunity({ productId: PRODUCT_ID, ...overrides });
}

function snapshotScore(decision: DecisionOpportunityResult) {
  return structuredClone(decision.score);
}

describe("explainDecision", () => {
  it("uses provider template and copies productId and selectedCountry", () => {
    const decision = decide({
      marketOpportunity: marketOpportunity(0.4),
      countryOpportunities: [countryOpportunity("GB", 0.8)],
    });
    const result = explainDecision(decision);
    expect(result.provider).toBe("template");
    expect(result.productId).toBe(PRODUCT_ID);
    expect(result.selectedCountry).toBe("GB");
  });

  it("echoes the P5.24 score unchanged and never mutates the input", () => {
    const decision = decide({
      marketOpportunity: marketOpportunity(0.4),
      countryOpportunities: [countryOpportunity("GB", 0.8)],
    });
    const frozenScore = snapshotScore(decision);
    const frozenDecision = structuredClone(decision);
    const result = explainDecision(decision);

    expect(result.score).toEqual({
      scoreType: frozenScore.scoreType,
      version: frozenScore.version,
      value: frozenScore.value,
      normalized: frozenScore.normalized,
      tier: decision.tier,
    });
    expect(result.score.value).toBe(60);
    expect(result.score.normalized).toBe(0.6);
    expect(result.score.scoreType).toBe("decision_opportunity");
    expect(result.score.version).toBe(1);
    expect(decision).toEqual(frozenDecision);
    expect(decision.score).toEqual(frozenScore);
  });

  it("does not recompute the numeric score when nested opportunity numbers differ from the frozen decision score", () => {
    const decision = decide({
      marketOpportunity: marketOpportunity(0.4),
      countryOpportunities: [countryOpportunity("GB", 0.8)],
    });
    const frozen = snapshotScore(decision);
    decision.marketOpportunity = marketOpportunity(0.99);
    decision.selectedCountryOpportunity = countryOpportunity("US", 0.01);
    const result = explainDecision(decision);
    expect(result.score.value).toBe(frozen.value);
    expect(result.score.normalized).toBe(frozen.normalized);
    expect(result.score.scoreType).toBe(frozen.scoreType);
    expect(result.score.version).toBe(frozen.version);
  });

  it("constructs evidence from the frozen decision signals, market, and selected country only", () => {
    const marketSignals: ScoreSignal[] = [
      {
        key: "competition",
        label: "Competition",
        weight: 0.4,
        value: 0.3,
        present: true,
        contribution: 0.12,
        detail: "low competition",
      },
    ];
    const decision = decide({
      marketOpportunity: marketOpportunity(0.4, 1, marketSignals),
      countryOpportunities: [countryOpportunity("DE", 0.8)],
    });
    const evidence = buildAnalystEvidence(decision);

    expect(evidence.totalWeight).toBe(decision.score.totalWeight);
    expect(evidence.decisionSignals).toEqual(
      decision.score.signals.map((signal) => ({
        key: signal.key,
        label: signal.label,
        weight: signal.weight,
        value: signal.value,
        present: signal.present,
        contribution: signal.contribution,
        ...(signal.detail !== undefined ? { detail: signal.detail } : {}),
      })),
    );
    expect(evidence.market).toEqual({
      present: true,
      value: 40,
      normalized: 0.4,
      tier: "medium",
      totalWeight: 1,
      signals: marketSignals,
    });
    expect(evidence.country).toEqual({
      present: true,
      country: "DE",
      value: 80,
      normalized: 0.8,
      tier: "high",
      latestValue: 80,
      change: 40,
      direction: "up",
    });
    expect(JSON.stringify(evidence)).not.toMatch(/WORLD|facebook|pinterest|social/i);
  });

  it("marks market evidence missing when the product market signal is absent", () => {
    const decision = decide({
      countryOpportunities: [countryOpportunity("US", 0.72)],
    });
    const result = explainDecision(decision);
    expect(result.evidence.market).toEqual({
      present: false,
      value: null,
      normalized: null,
      tier: null,
      totalWeight: null,
      signals: [],
    });
    expect(result.evidence.decisionSignals.find((signal) => signal.key === "product_market_opportunity")?.present).toBe(
      false,
    );
    expect(result.caveats).toContain("product market opportunity is missing");
    expect(result.caveats).not.toContain("country opportunity is missing");
    expect(result.summary).toContain("Caveats: product market opportunity is missing.");
  });

  it("marks country evidence missing when no eligible country is selected", () => {
    const decision = decide({ marketOpportunity: marketOpportunity(0.8) });
    const result = explainDecision(decision);
    expect(result.selectedCountry).toBeNull();
    expect(result.evidence.country).toEqual({
      present: false,
      country: null,
      value: null,
      normalized: null,
      tier: null,
      latestValue: null,
      change: null,
      direction: null,
    });
    expect(result.evidence.decisionSignals.find((signal) => signal.key === "country_opportunity")?.present).toBe(false);
    expect(result.caveats).toEqual(["country opportunity is missing"]);
    expect(result.summary).toContain("Caveats: country opportunity is missing.");
    expect(result.summary).not.toMatch(/Selected country/);
  });

  it("treats both signals missing as unknown with both caveats and empty evidence", () => {
    const decision = decide();
    const result = explainDecision(decision);
    expect(result.score.tier).toBe("unknown");
    expect(result.score.value).toBe(0);
    expect(result.evidence.totalWeight).toBe(0);
    expect(result.evidence.market.present).toBe(false);
    expect(result.evidence.country.present).toBe(false);
    expect(result.caveats).toEqual([
      "product market opportunity is missing",
      "country opportunity is missing",
    ]);
  });

  it("echoes high, medium, low, and unknown tiers from the frozen decision", () => {
    const cases: Array<{ decision: DecisionOpportunityResult; tier: OpportunityTier; value: number }> = [
      { decision: decide({ marketOpportunity: marketOpportunity(0.65) }), tier: "high", value: 65 },
      { decision: decide({ marketOpportunity: marketOpportunity(0.64) }), tier: "medium", value: 64 },
      { decision: decide({ marketOpportunity: marketOpportunity(0.4) }), tier: "medium", value: 40 },
      { decision: decide({ marketOpportunity: marketOpportunity(0.39) }), tier: "low", value: 39 },
      { decision: decide(), tier: "unknown", value: 0 },
    ];
    for (const entry of cases) {
      const result = explainDecision(entry.decision);
      expect(result.score.tier).toBe(entry.tier);
      expect(result.score.tier).toBe(entry.decision.tier);
      expect(result.score.value).toBe(entry.value);
      expect(result.score.value).toBe(entry.decision.score.value);
      expect(result.summary).toContain(`Decision opportunity score ${entry.value} (${entry.tier}).`);
    }
  });

  it("is fully deterministic for identical frozen inputs", () => {
    const decision = decide({
      marketOpportunity: marketOpportunity(0.55),
      countryOpportunities: [countryOpportunity("IT", 0.4), countryOpportunity("ES", 0.6)],
    });
    const first = explainDecision(decision);
    const second = explainDecision(decision);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("builds a complete summary when both signals are present and omits WORLD social language", () => {
    const decision = decide({
      marketOpportunity: marketOpportunity(0.4),
      countryOpportunities: [countryOpportunity("SA", 0.8)],
    });
    const result: AnalystResult = explainDecision(decision);
    expect(result.summary).toBe(
      "Decision opportunity score 60 (medium). Product market opportunity 40 (medium). Selected country SA scored 80 (high).",
    );
    expect(result.caveats).toEqual([]);
    expect(result.summary).not.toMatch(/WORLD|facebook|pinterest|social/i);
  });
});
