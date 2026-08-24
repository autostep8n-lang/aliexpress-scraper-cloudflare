/**
 * Competition / Opportunity Engine - deterministic evaluation (P1.10).
 *
 * Pure, source-agnostic and deterministic: no I/O, no wall-clock time, and
 * identical inputs always produce identical outputs. The competition score is
 * built on the P1.3 scoring engine (weighted, bounded signal aggregation);
 * the market opportunity score composes that competition result with demand
 * and profit signals, also via the P1.3 engine. Signals without data are
 * flagged `present: false` and excluded from the numerator and denominator.
 */

import { clamp, computeScore } from "../scoring";
import type { ComputeScoreOptions, ScoreResult, ScoreSignalDefinition } from "../scoring/types";
import type { Product } from "../products/types";
import type { ProfitResult } from "../profit/types";
import type { TrendMetricType, TrendSummary } from "../trends/types";
import {
  DEFAULT_OPPORTUNITY_THRESHOLDS,
  type CompetitionInput,
  type OpportunityDemand,
  type OpportunityInput,
  type OpportunityResult,
  type OpportunityThresholds,
  type OpportunityTier,
} from "./types";

/** Decade scale at which competitor volume saturates (10, 100, 1000...). */
const COMPETITOR_VOLUME_DECADES = 3;
/** Decade scale at which source breadth saturates. */
const SOURCE_BREADTH_DECADES = 2;
/** Decade scale at which rating volume saturates. */
const RATING_VOLUME_DECADES = 6;
/** Relative price above the median that counts as full price pressure (1.5x). */
const PRICE_PRESSURE_SPAN = 0.5;
/** Profit margin percentage at which the margin signal saturates. */
const MARGIN_SATURATION_PCT = 40;
/** Reuse the P1.4 rating metric key for trend summaries. */
export const RATING_METRIC: TrendMetricType = "rating";

/**
 * Default competition signal definitions. Each evaluates a normalized [0, 1]
 * contribution plus an explainable detail; weights sum to 1.
 */
export const COMPETITION_SIGNALS: readonly ScoreSignalDefinition<CompetitionInput>[] = [
  competitorVolumeSignal(),
  sourceBreadthSignal(),
  pricePositioningSignal(),
  competitorSaturationSignal(),
  marketConcentrationSignal(),
];

/**
 * Default market opportunity signal definitions. They evaluate a context that
 * carries the already-computed competition result plus optional demand and
 * profit data; weights sum to 1.
 */
export const OPPORTUNITY_SIGNALS: readonly ScoreSignalDefinition<OpportunityContext>[] = [
  competitionPressureSignal(),
  demandVolumeSignal(),
  demandMomentumSignal(),
  profitMarginSignal(),
];

interface OpportunityContext {
  competition: ScoreResult;
  demand?: OpportunityDemand;
  profit?: ProfitResult;
}

/** Deterministic competition score for a competitive landscape. */
export function scoreCompetition(
  input: CompetitionInput,
  options: ComputeScoreOptions = {},
): ScoreResult {
  return computeScore(input, COMPETITION_SIGNALS, {
    scoreType: "competition",
    version: 1,
    ...options,
  });
}

/**
 * Full market opportunity assessment: scores the competition, then composes it
 * with demand and profit signals into a market opportunity score and derives a
 * qualitative tier. When no opportunity signal could be evaluated the tier is
 * "unknown" (never mistaken for a low opportunity).
 */
export function assessMarketOpportunity(
  input: OpportunityInput,
  thresholds: OpportunityThresholds = DEFAULT_OPPORTUNITY_THRESHOLDS,
): OpportunityResult {
  const competition = scoreCompetition(input.competition);
  const score = computeScore(
    { competition, demand: input.demand, profit: input.profit },
    OPPORTUNITY_SIGNALS,
    { scoreType: "market_opportunity", version: 1 },
  );
  return { competition, score, tier: deriveTier(score, thresholds) };
}

/** Demand signals extracted from a normalized Product (rating only). */
export function demandFromProduct(product: Product): OpportunityDemand {
  const rating = product.rating;
  if (!rating) return {};
  const demand: OpportunityDemand = {};
  if (typeof rating.count === "number" && Number.isFinite(rating.count)) {
    demand.rating = { count: rating.count };
  }
  if (typeof rating.average === "number" && Number.isFinite(rating.average)) {
    demand.rating = { ...(demand.rating ?? {}), average: rating.average };
  }
  return demand;
}

/**
 * Adapter over a normalized Product plus optional P1.4 trend summaries and a
 * P1.6 profit result. Rating momentum is wired from the "rating" trend series
 * when provided; the competition landscape is always required explicitly.
 */
export function opportunityFromProduct(
  product: Product,
  competition: CompetitionInput,
  options: {
    trends?: Partial<Record<TrendMetricType, TrendSummary>>;
    profit?: ProfitResult;
  } = {},
): OpportunityResult {
  const demand = demandFromProduct(product);
  const ratingTrend = options.trends?.[RATING_METRIC];
  if (ratingTrend) demand.ratingTrend = ratingTrend;
  return assessMarketOpportunity({ competition, demand, profit: options.profit });
}

function deriveTier(score: ScoreResult, thresholds: OpportunityThresholds): OpportunityTier {
  if (score.totalWeight === 0) return "unknown";
  if (score.value >= thresholds.high) return "high";
  if (score.value >= thresholds.medium) return "medium";
  return "low";
}

/** More competing offers -> more competitive pressure, log-scaled. */
function competitorVolumeSignal(): ScoreSignalDefinition<CompetitionInput> {
  return {
    key: "competitor_volume",
    label: "Competitor volume",
    weight: 0.3,
    evaluate: (input) => {
      const count = input.competitorCount;
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
        return { present: false, value: 0 };
      }
      const value = clamp(Math.log10(count + 1) / COMPETITOR_VOLUME_DECADES, 0, 1);
      return { present: true, value, detail: `${count} competitors` };
    },
  };
}

/** Competition spread across many sources/marketplaces -> more pressure. */
function sourceBreadthSignal(): ScoreSignalDefinition<CompetitionInput> {
  return {
    key: "source_breadth",
    label: "Source breadth",
    weight: 0.2,
    evaluate: (input) => {
      const count = input.sourceCount;
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
        return { present: false, value: 0 };
      }
      const value = clamp(Math.log10(count + 1) / SOURCE_BREADTH_DECADES, 0, 1);
      return { present: true, value, detail: `${count} sources` };
    },
  };
}

/**
 * Priced at or below the competitor median -> price advantage, no pressure.
 * Priced above the median -> pressure grows linearly up to +50% over median.
 */
function pricePositioningSignal(): ScoreSignalDefinition<CompetitionInput> {
  return {
    key: "price_positioning",
    label: "Price positioning",
    weight: 0.25,
    evaluate: (input) => {
      const ownPrice = input.ownPrice;
      const prices = (input.competitorPrices ?? []).filter(
        (price) => typeof price === "number" && Number.isFinite(price) && price > 0,
      );
      if (typeof ownPrice !== "number" || !Number.isFinite(ownPrice) || ownPrice <= 0 || prices.length === 0) {
        return { present: false, value: 0 };
      }
      const median = sortedMedian(prices);
      const ratio = ownPrice / median;
      const value = clamp((ratio - 1) / PRICE_PRESSURE_SPAN, 0, 1);
      return { present: true, value, detail: `${Math.round(ratio * 100)}% of median competitor price` };
    },
  };
}

/**
 * Cumulative competitor rating volume -> entrenched, saturated market, more
 * pressure. Log-scaled so one entrenched leader is not over-weighted.
 */
function competitorSaturationSignal(): ScoreSignalDefinition<CompetitionInput> {
  return {
    key: "competitor_saturation",
    label: "Competitor saturation",
    weight: 0.15,
    evaluate: (input) => {
      const count = input.competitorRatingCount;
      if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
        return { present: false, value: 0 };
      }
      const value = clamp(Math.log10(count + 1) / RATING_VOLUME_DECADES, 0, 1);
      return { present: true, value, detail: `${count} competitor ratings` };
    },
  };
}

/**
 * A dominant leader concentrates the market and raises the barrier to entry.
 * Fragmented markets (low share) show less single-player pressure.
 */
function marketConcentrationSignal(): ScoreSignalDefinition<CompetitionInput> {
  return {
    key: "market_concentration",
    label: "Market concentration",
    weight: 0.1,
    evaluate: (input) => {
      const share = input.dominantCompetitorShare;
      if (typeof share !== "number" || !Number.isFinite(share) || share < 0 || share > 1) {
        return { present: false, value: 0 };
      }
      return { present: true, value: share, detail: `${Math.round(share * 100)}% leader share` };
    },
  };
}

/**
 * Low competition pressure is a positive for opportunity. Only present when at
 * least one competition signal was evaluated, so unobserved competition never
 * inflates the opportunity score.
 */
function competitionPressureSignal(): ScoreSignalDefinition<OpportunityContext> {
  return {
    key: "competition_pressure",
    label: "Competition headroom",
    weight: 0.3,
    evaluate: (context) => {
      if (context.competition.totalWeight === 0) return { present: false, value: 0 };
      return {
        present: true,
        value: clamp(1 - context.competition.normalized, 0, 1),
        detail: `competition score ${context.competition.value}`,
      };
    },
  };
}

/** The product's own rating volume proxies proven demand, log-scaled. */
function demandVolumeSignal(): ScoreSignalDefinition<OpportunityContext> {
  return {
    key: "demand_volume",
    label: "Demand volume",
    weight: 0.25,
    evaluate: (context) => {
      const count = context.demand?.rating?.count;
      if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
        return { present: false, value: 0 };
      }
      const value = clamp(Math.log10(count + 1) / RATING_VOLUME_DECADES, 0, 1);
      return { present: true, value, detail: `${count} ratings` };
    },
  };
}

/** A rising rating trend signals momentum; a falling one warns of decay. */
function demandMomentumSignal(): ScoreSignalDefinition<OpportunityContext> {
  return {
    key: "demand_momentum",
    label: "Demand momentum",
    weight: 0.2,
    evaluate: (context) => {
      const trend = context.demand?.ratingTrend;
      const direction = trend?.direction;
      if (!direction || direction === "unknown") return { present: false, value: 0 };
      if (direction === "up") return { present: true, value: 0.8, detail: "rating trend up" };
      if (direction === "flat") return { present: true, value: 0.5, detail: "rating trend flat" };
      return { present: true, value: 0.2, detail: "rating trend down" };
    },
  };
}

/** Healthier margins leave room to compete on price and absorb demand. */
function profitMarginSignal(): ScoreSignalDefinition<OpportunityContext> {
  return {
    key: "profit_margin",
    label: "Profit margin",
    weight: 0.25,
    evaluate: (context) => {
      const margin = context.profit?.profitMarginPct;
      if (typeof margin !== "number" || !Number.isFinite(margin)) return { present: false, value: 0 };
      const value = clamp(margin / MARGIN_SATURATION_PCT, 0, 1);
      return { present: true, value, detail: `${margin.toFixed(2)}% margin` };
    },
  };
}

/** Deterministic median of a non-empty ascending-sorted numeric array. */
function sortedMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
