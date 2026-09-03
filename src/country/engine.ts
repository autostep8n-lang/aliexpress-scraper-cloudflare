/**
 * Country Intelligence Engine (P4.22) and Country Opportunity Scoring (P4.23).
 *
 * Pure, source-agnostic, deterministic: no I/O, no wall-clock time, and
 * identical inputs always produce identical outputs. P4.22 summarizes existing
 * Google Trends observations for one keyword+country. P4.23 composes that
 * evidence with optional P1.10 competition, demand, and P1.6 profit via
 * computeScore. Missing signals are present: false and excluded from the
 * weighted mean; country evidence absence forces tier "unknown".
 */

import { summarizeSignals } from "../market/engine";
import type { GoogleTrendsSignal } from "../market/types";
import { DEFAULT_OPPORTUNITY_THRESHOLDS } from "../opportunity/types";
import type { OpportunityTier } from "../opportunity/types";
import { clamp, computeScore } from "../scoring";
import type { ScoreResult, ScoreSignalDefinition } from "../scoring/types";
import {
  CountryError,
  V1_COUNTRIES,
  type CountryIntelligenceInput,
  type CountryIntelligenceResult,
  type CountryOpportunityInput,
  type CountryOpportunityObservationRow,
  type CountryOpportunityResult,
  type V1Country,
} from "./types";

const KEYWORD_MAX_LENGTH = 200;
const RATING_VOLUME_DECADES = 6;
const MARGIN_SATURATION_PCT = 40;
const COUNTRY_SET = new Set<string>(V1_COUNTRIES);

export const COUNTRY_OPPORTUNITY_SCORE_TYPE = "country_opportunity";
export const COUNTRY_OPPORTUNITY_VERSION = 1;

interface CountryOpportunityContext {
  countryIntelligence: CountryIntelligenceResult;
  competition?: ScoreResult;
  demand?: CountryOpportunityInput["demand"];
  profit?: CountryOpportunityInput["profit"];
}

export const COUNTRY_OPPORTUNITY_SIGNALS: readonly ScoreSignalDefinition<CountryOpportunityContext>[] = [
  countrySearchLevelSignal(),
  countrySearchMomentumSignal(),
  competitionHeadroomSignal(),
  demandVolumeSignal(),
  profitMarginSignal(),
];

export function isV1Country(value: string): value is V1Country {
  return COUNTRY_SET.has(value);
}

export function normalizeKeyword(value: unknown): string {
  const keyword = asString(value);
  if (!keyword) {
    throw new CountryError("INVALID_KEYWORD", "keyword is required and must be a non-empty string");
  }
  if (keyword.length > KEYWORD_MAX_LENGTH) {
    throw new CountryError("INVALID_KEYWORD", `keyword must be at most ${KEYWORD_MAX_LENGTH} characters`);
  }
  return keyword;
}

export function normalizeCountry(value: unknown): V1Country {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new CountryError("INVALID_COUNTRY", "country is required and must be an ISO-3166-1 alpha-2 code");
  }
  const upper = raw.toUpperCase();
  if (!isV1Country(upper)) {
    throw new CountryError("INVALID_COUNTRY", `unsupported country: ${raw}`);
  }
  return upper;
}

export function normalizeProductId(value: unknown): string {
  const productId = typeof value === "string" ? value.trim() : "";
  if (!productId) {
    throw new CountryError("INVALID_PRODUCT", "productId is required and must be a non-empty string");
  }
  return productId;
}

export function analyzeCountryIntelligence(input: CountryIntelligenceInput): CountryIntelligenceResult {
  const keyword = normalizeKeyword(input.query.keyword);
  const country = normalizeCountry(input.query.country);
  const matching = matchingTrends(Array.isArray(input.trends) ? input.trends : [], keyword, country);
  const summary = summarizeSignals(matching);
  return {
    keyword,
    country,
    observationCount: summary.count,
    latestValue: summary.last ? summary.last.value : null,
    firstValue: summary.first ? summary.first.value : null,
    change: summary.change,
    direction: summary.direction,
    spanMs: summary.spanMs,
    peakValue: matching.length === 0 ? null : Math.max(...matching.map((signal) => signal.value)),
    capturedAt: maxCapturedAt(matching),
  };
}

export function scoreCountryOpportunity(input: CountryOpportunityInput): CountryOpportunityResult {
  const productId = normalizeProductId(input.productId);
  const country = normalizeCountry(input.country);
  const keyword = normalizeKeyword(input.keyword);
  const countryIntelligence = input.countryIntelligence;
  const score = computeScore(
    {
      countryIntelligence,
      competition: input.competition,
      demand: input.demand,
      profit: input.profit,
    },
    COUNTRY_OPPORTUNITY_SIGNALS,
    { scoreType: COUNTRY_OPPORTUNITY_SCORE_TYPE, version: COUNTRY_OPPORTUNITY_VERSION },
  );
  return {
    productId,
    country,
    keyword,
    countryIntelligence,
    score,
    tier: deriveCountryTier(score),
  };
}

export function toCountryOpportunityRow(result: CountryOpportunityResult): CountryOpportunityObservationRow {
  const row: CountryOpportunityObservationRow = {
    product_id: result.productId,
    country: result.country,
    keyword: result.keyword,
    score_type: result.score.scoreType,
    value: result.score.value,
    min_value: result.score.minValue,
    max_value: result.score.maxValue,
    normalized: result.score.normalized,
    total_weight: result.score.totalWeight,
    tier: result.tier,
    version: result.score.version,
    inputs: result.score.inputs,
    country_latest_value: result.countryIntelligence.latestValue,
    country_change: result.countryIntelligence.change,
    country_direction: result.countryIntelligence.direction,
  };
  if (result.countryIntelligence.capturedAt) {
    row.computed_at = result.countryIntelligence.capturedAt;
  }
  return row;
}

function deriveCountryTier(score: ScoreResult): OpportunityTier {
  const level = score.signals.find((signal) => signal.key === "country_search_level");
  const momentum = score.signals.find((signal) => signal.key === "country_search_momentum");
  if (!level?.present && !momentum?.present) return "unknown";
  if (score.value >= DEFAULT_OPPORTUNITY_THRESHOLDS.high) return "high";
  if (score.value >= DEFAULT_OPPORTUNITY_THRESHOLDS.medium) return "medium";
  return "low";
}

function countrySearchLevelSignal(): ScoreSignalDefinition<CountryOpportunityContext> {
  return {
    key: "country_search_level",
    label: "Country search interest",
    weight: 0.4,
    evaluate: (context) => {
      const latest = context.countryIntelligence?.latestValue;
      if (typeof latest !== "number" || !Number.isFinite(latest)) {
        return { present: false, value: 0 };
      }
      return { present: true, value: latest / 100, detail: `latest interest ${latest}` };
    },
  };
}

function countrySearchMomentumSignal(): ScoreSignalDefinition<CountryOpportunityContext> {
  return {
    key: "country_search_momentum",
    label: "Country search momentum",
    weight: 0.2,
    evaluate: (context) => {
      const intel = context.countryIntelligence;
      const change = intel?.change;
      if (!intel || intel.observationCount < 2 || typeof change !== "number" || !Number.isFinite(change)) {
        return { present: false, value: 0 };
      }
      const value = clamp((change / 100 + 1) / 2, 0, 1);
      return { present: true, value, detail: `change ${change} (${intel.direction})` };
    },
  };
}

function competitionHeadroomSignal(): ScoreSignalDefinition<CountryOpportunityContext> {
  return {
    key: "competition_headroom",
    label: "Competition headroom",
    weight: 0.15,
    evaluate: (context) => {
      const competition = context.competition;
      if (!competition || competition.totalWeight === 0) return { present: false, value: 0 };
      return {
        present: true,
        value: clamp(1 - competition.normalized, 0, 1),
        detail: `competition score ${competition.value}`,
      };
    },
  };
}

function demandVolumeSignal(): ScoreSignalDefinition<CountryOpportunityContext> {
  return {
    key: "demand_volume",
    label: "Demand volume",
    weight: 0.15,
    evaluate: (context) => {
      const count = context.demand?.rating?.count;
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
        return { present: false, value: 0 };
      }
      const value = clamp(Math.log10(count + 1) / RATING_VOLUME_DECADES, 0, 1);
      return { present: true, value, detail: `${count} ratings` };
    },
  };
}

function profitMarginSignal(): ScoreSignalDefinition<CountryOpportunityContext> {
  return {
    key: "profit_margin",
    label: "Profit margin",
    weight: 0.1,
    evaluate: (context) => {
      const margin = context.profit?.profitMarginPct;
      if (typeof margin !== "number" || !Number.isFinite(margin)) return { present: false, value: 0 };
      const value = clamp(margin / MARGIN_SATURATION_PCT, 0, 1);
      return { present: true, value, detail: `${margin.toFixed(2)}% margin` };
    },
  };
}

function matchingTrends(trends: GoogleTrendsSignal[], keyword: string, country: string): GoogleTrendsSignal[] {
  const matched: GoogleTrendsSignal[] = [];
  for (const signal of trends) {
    if (!signal || typeof signal !== "object") continue;
    if (signal.keyword !== keyword) continue;
    if (signal.geo !== country) continue;
    if (typeof signal.value !== "number" || !Number.isFinite(signal.value)) continue;
    matched.push(signal);
  }
  return matched;
}

function maxCapturedAt(signals: GoogleTrendsSignal[]): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const signal of signals) {
    if (typeof signal.capturedAt !== "string" || signal.capturedAt === "") continue;
    const ms = Date.parse(signal.capturedAt);
    if (!Number.isFinite(ms)) continue;
    if (ms > latestMs) {
      latestMs = ms;
      latest = signal.capturedAt;
    }
  }
  return latest;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}
