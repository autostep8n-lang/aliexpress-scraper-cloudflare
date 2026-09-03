/**
 * AI Product Analyst domain types (P5.25).
 *
 * Deterministic template explanation of a frozen P5.24
 * DecisionOpportunityResult. The analyst never recomputes or mutates the
 * decision score.
 */

import type { V1Country } from "../country/types";
import type { OpportunityTier } from "../opportunity/types";

export type AnalystProvider = "template";

export interface AnalystScoreEcho {
  scoreType: string;
  version: number;
  value: number;
  normalized: number;
  tier: OpportunityTier;
}

export interface AnalystSignalEvidence {
  key: string;
  label: string;
  weight: number;
  value: number;
  present: boolean;
  contribution: number;
  detail?: string;
}

export interface AnalystMarketEvidence {
  present: boolean;
  value: number | null;
  normalized: number | null;
  tier: OpportunityTier | null;
  totalWeight: number | null;
  signals: AnalystSignalEvidence[];
}

export interface AnalystCountryEvidence {
  present: boolean;
  country: V1Country | null;
  value: number | null;
  normalized: number | null;
  tier: OpportunityTier | null;
  latestValue: number | null;
  change: number | null;
  direction: string | null;
}

export interface AnalystEvidence {
  totalWeight: number;
  decisionSignals: AnalystSignalEvidence[];
  market: AnalystMarketEvidence;
  country: AnalystCountryEvidence;
}

export interface AnalystResult {
  productId: string;
  score: AnalystScoreEcho;
  selectedCountry: V1Country | null;
  summary: string;
  evidence: AnalystEvidence;
  caveats: string[];
  provider: AnalystProvider;
}
