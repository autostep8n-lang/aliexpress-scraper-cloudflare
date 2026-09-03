/**
 * Country Intelligence / Country Opportunity domain types (P4.22 / P4.23).
 *
 * P4.22 is country-scoped demand evidence from Google Trends (keyword + ISO
 * alpha-2). P4.23 is a deterministic product x country score composed via the
 * P1.3 scoring engine. Missing data is never invented.
 */

import type { MarketTrendDirection } from "../market/engine";
import type { GoogleTrendsSignal } from "../market/types";
import type { OpportunityDemand, OpportunityTier } from "../opportunity/types";
import type { ProfitResult } from "../profit/types";
import type { ScoreResult } from "../scoring/types";

/** Approved v1 markets. `UK` and `EU` are not valid keys. */
export const V1_COUNTRIES = ["SA", "US", "GB", "DE", "FR", "ES", "IT"] as const;

export type V1Country = (typeof V1_COUNTRIES)[number];

export type CountryTrendDirection = MarketTrendDirection;

export class CountryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CountryError";
  }
}

export interface CountryIntelligenceQuery {
  keyword: string;
  country: string;
}

export interface CountryIntelligenceInput {
  query: CountryIntelligenceQuery;
  trends: GoogleTrendsSignal[];
}

export interface CountryIntelligenceResult {
  keyword: string;
  country: V1Country;
  observationCount: number;
  latestValue: number | null;
  firstValue: number | null;
  change: number | null;
  direction: CountryTrendDirection;
  spanMs: number | null;
  peakValue: number | null;
  capturedAt: string | null;
}

export interface CountryOpportunityInput {
  productId: string;
  country: string;
  keyword: string;
  countryIntelligence: CountryIntelligenceResult;
  competition?: ScoreResult;
  demand?: OpportunityDemand;
  profit?: ProfitResult;
}

export interface CountryOpportunityResult {
  productId: string;
  country: V1Country;
  keyword: string;
  countryIntelligence: CountryIntelligenceResult;
  score: ScoreResult;
  tier: OpportunityTier;
}

export interface CountryOpportunityObservationRow {
  product_id: string;
  country: string;
  keyword: string;
  score_type: string;
  value: number;
  min_value: number;
  max_value: number;
  normalized: number;
  total_weight: number;
  tier: string;
  version: number;
  inputs: Record<string, unknown>;
  country_latest_value: number | null;
  country_change: number | null;
  country_direction: string | null;
  computed_at?: string;
}

export interface CountryOpportunityPersistedRow {
  id: string;
  product_id: string;
  country: string;
  keyword: string;
  score_type: string;
  value: number;
  min_value: number | null;
  max_value: number | null;
  normalized: number;
  total_weight: number;
  tier: string;
  version: number;
  inputs: Record<string, unknown>;
  country_latest_value: number | null;
  country_change: number | null;
  country_direction: string | null;
  computed_at: string;
  created_at: string;
  updated_at: string;
}
