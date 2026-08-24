/**
 * Competition / Opportunity domain types (P1.10).
 *
 * Deterministic and source-agnostic. The competition score quantifies how much
 * competitive pressure a product faces (higher = more pressure). The market
 * opportunity score combines that pressure with demand and profit signals to
 * rank how attractive a product is (higher = more attractive). Missing data is
 * never invented: a signal absent from the input is flagged `present: false`
 * and excluded from the weighted aggregation, following the project's existing
 * scoring conventions.
 */

import type { ProfitResult } from "../profit/types";
import type { ScoreResult } from "../scoring/types";
import type { TrendSummary } from "../trends/types";

/**
 * Explicit, typed inputs describing the competitive landscape for one product.
 * Every field is optional: `{}` means no competition data was observed (and
 * yields no competition signal), while an explicit `competitorCount: 0` /
 * `sourceCount: 0` records an observed empty market (true headroom).
 */
export interface CompetitionInput {
  /** Number of competing offers observed (0 when an empty market was observed). */
  competitorCount?: number;
  /** Distinct sources/marketplaces where competing offers were observed. */
  sourceCount?: number;
  /** Observed competitor prices, in the same currency as `ownPrice`. */
  competitorPrices?: number[];
  /** This product's own price, used for price positioning. */
  ownPrice?: number;
  /** Average competitor rating on a 0-5 scale. */
  competitorRatingAverage?: number;
  /** Total rating volume accumulated across all competitors. */
  competitorRatingCount?: number;
  /** Estimated market share (0-1) of the strongest competitor. */
  dominantCompetitorShare?: number;
}

/**
 * Demand-side signals for one product: its own rating data plus the P1.4
 * trend summary of its rating history (used for momentum).
 */
export interface OpportunityDemand {
  /** The product's own rating volume / average. */
  rating?: { count?: number; average?: number };
  /** Summary of the product's "rating" trend series, if any. */
  ratingTrend?: TrendSummary;
}

/**
 * Inputs to a market opportunity assessment: the raw competitive landscape,
 * optional demand signals and an optional P1.6 profit result.
 */
export interface OpportunityInput {
  competition: CompetitionInput;
  demand?: OpportunityDemand;
  profit?: ProfitResult;
}

/** Competition score: a P1.3-style ScoreResult scoped to the competition family. */
export type CompetitionResult = ScoreResult;

/** Qualitative tier derived from the market opportunity score. */
export type OpportunityTier = "high" | "medium" | "low" | "unknown";

export interface OpportunityThresholds {
  /** Score >= this value is a high opportunity. */
  high: number;
  /** Score >= this value (and < high) is a medium opportunity. */
  medium: number;
}

export const DEFAULT_OPPORTUNITY_THRESHOLDS: OpportunityThresholds = {
  high: 65,
  medium: 40,
};

/**
 * Full market opportunity assessment: the competition breakdown plus the
 * opportunity score and its derived tier. `tier` is "unknown" when no
 * opportunity signal could be evaluated (no competition, demand or profit
 * data), so absence of data is never mistaken for a low opportunity.
 */
export interface OpportunityResult {
  competition: CompetitionResult;
  score: ScoreResult;
  tier: OpportunityTier;
}
