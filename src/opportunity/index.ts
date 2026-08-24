/**
 * Competition / Opportunity Engine - public entry point (P1.10).
 *
 * Pure, source-agnostic, deterministic: a competition score quantifies
 * competitive pressure, and a market opportunity score composes that pressure
 * with demand and profit signals into an attractiveness ranking. Built on the
 * P1.3 scoring engine; no I/O, no wall-clock time, no platform logic.
 */

export {
  assessMarketOpportunity,
  COMPETITION_SIGNALS,
  demandFromProduct,
  OPPORTUNITY_SIGNALS,
  opportunityFromProduct,
  RATING_METRIC,
  scoreCompetition,
} from "./engine";
export { DEFAULT_OPPORTUNITY_THRESHOLDS } from "./types";

export type {
  CompetitionInput,
  CompetitionResult,
  OpportunityDemand,
  OpportunityInput,
  OpportunityResult,
  OpportunityThresholds,
  OpportunityTier,
} from "./types";

import type { OpportunityResult } from "./types";

export interface OpportunityRowRefs {
  productId?: string;
  productSourceId?: string | null;
}

/**
 * Maps a market opportunity result to rows of the existing `scores` table (see
 * supabase/migrations/20260817000007_metrics.sql): one row for the competition
 * score and one for the market opportunity score. Pure and deterministic: it
 * never touches Supabase, it only produces the rows a caller may persist.
 */
export function toOpportunityRows(
  result: OpportunityResult,
  refs: OpportunityRowRefs = {},
): Array<Record<string, unknown>> {
  const base = {
    product_id: refs.productId ?? null,
    product_source_id: refs.productSourceId ?? null,
  };
  return [
    {
      ...base,
      score_type: result.competition.scoreType,
      value: result.competition.value,
      min_value: result.competition.minValue,
      max_value: result.competition.maxValue,
      version: result.competition.version,
      inputs: result.competition.inputs,
    },
    {
      ...base,
      score_type: result.score.scoreType,
      value: result.score.value,
      min_value: result.score.minValue,
      max_value: result.score.maxValue,
      version: result.score.version,
      inputs: result.score.inputs,
    },
  ];
}
