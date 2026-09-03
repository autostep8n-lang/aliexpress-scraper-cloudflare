/**
 * Decision Opportunity domain types (P5.24).
 *
 * Product-global aggregation of existing P1.10 market_opportunity and
 * eligible P4.23 country_opportunity scores. Missing data is never invented.
 */

import type { CountryOpportunityResult, V1Country } from "../country/types";
import type { OpportunityResult, OpportunityTier } from "../opportunity/types";
import type { ScoreResult } from "../scoring/types";

export class DecisionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

export interface DecisionOpportunityInput {
  productId: string;
  marketOpportunity?: OpportunityResult;
  countryOpportunities?: CountryOpportunityResult[];
}

export interface DecisionOpportunityResult {
  productId: string;
  score: ScoreResult;
  tier: OpportunityTier;
  selectedCountry: V1Country | null;
  marketOpportunity: OpportunityResult | null;
  selectedCountryOpportunity: CountryOpportunityResult | null;
}
