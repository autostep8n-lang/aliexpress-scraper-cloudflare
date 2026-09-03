/**
 * Decision Opportunity Engine (P5.24).
 *
 * Pure, source-agnostic, deterministic: no I/O, no wall-clock time, and
 * identical inputs always produce identical outputs. Composes an existing
 * P1.10 market_opportunity score with the best eligible P4.23
 * country_opportunity score via computeScore. Missing signals are
 * present: false and excluded from the weighted mean.
 */

import type { CountryOpportunityResult, V1Country } from "../country/types";
import { DEFAULT_OPPORTUNITY_THRESHOLDS } from "../opportunity/types";
import type { OpportunityResult, OpportunityTier } from "../opportunity/types";
import { clamp, computeScore } from "../scoring";
import type { ScoreResult, ScoreSignalDefinition } from "../scoring/types";
import {
  DecisionError,
  type DecisionOpportunityInput,
  type DecisionOpportunityResult,
} from "./types";

export const DECISION_OPPORTUNITY_SCORE_TYPE = "decision_opportunity";
export const DECISION_OPPORTUNITY_VERSION = 1;

interface DecisionContext {
  marketOpportunity: OpportunityResult | null;
  selectedCountryOpportunity: CountryOpportunityResult | null;
}

export const DECISION_OPPORTUNITY_SIGNALS: readonly ScoreSignalDefinition<DecisionContext>[] = [
  productMarketOpportunitySignal(),
  countryOpportunitySignal(),
];

export function scoreDecisionOpportunity(input: DecisionOpportunityInput): DecisionOpportunityResult {
  const productId = normalizeProductId(input.productId);
  const marketOpportunity = usableMarketOpportunity(input.marketOpportunity);
  const selectedCountryOpportunity = selectCountryOpportunity(productId, input.countryOpportunities);
  const score = computeScore(
    { marketOpportunity, selectedCountryOpportunity },
    DECISION_OPPORTUNITY_SIGNALS,
    { scoreType: DECISION_OPPORTUNITY_SCORE_TYPE, version: DECISION_OPPORTUNITY_VERSION },
  );
  return {
    productId,
    score,
    tier: deriveDecisionTier(score),
    selectedCountry: selectedCountryOpportunity ? selectedCountryOpportunity.country : null,
    marketOpportunity,
    selectedCountryOpportunity,
  };
}

function productMarketOpportunitySignal(): ScoreSignalDefinition<DecisionContext> {
  return {
    key: "product_market_opportunity",
    label: "Product market opportunity",
    weight: 0.5,
    evaluate: (context) => {
      const score = context.marketOpportunity?.score;
      if (!score || score.totalWeight === 0) return { present: false, value: 0 };
      return {
        present: true,
        value: clamp(score.normalized, 0, 1),
        detail: `market opportunity ${score.value}`,
      };
    },
  };
}

function countryOpportunitySignal(): ScoreSignalDefinition<DecisionContext> {
  return {
    key: "country_opportunity",
    label: "Country opportunity",
    weight: 0.5,
    evaluate: (context) => {
      const selected = context.selectedCountryOpportunity;
      if (!selected) return { present: false, value: 0 };
      return {
        present: true,
        value: clamp(selected.score.normalized, 0, 1),
        detail: `${selected.country} ${selected.score.value}`,
      };
    },
  };
}

function deriveDecisionTier(score: ScoreResult): OpportunityTier {
  if (score.totalWeight === 0) return "unknown";
  if (score.value >= DEFAULT_OPPORTUNITY_THRESHOLDS.high) return "high";
  if (score.value >= DEFAULT_OPPORTUNITY_THRESHOLDS.medium) return "medium";
  return "low";
}

function usableMarketOpportunity(value: OpportunityResult | undefined): OpportunityResult | null {
  if (!value) return null;
  if (value.score.scoreType !== "market_opportunity") return null;
  return value;
}

function selectCountryOpportunity(
  productId: string,
  candidates: CountryOpportunityResult[] | undefined,
): CountryOpportunityResult | null {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const eligible = candidates.filter((candidate) => isEligibleCountryOpportunity(productId, candidate));
  if (eligible.length === 0) return null;
  return [...eligible].sort(compareCountryOpportunity)[0];
}

function isEligibleCountryOpportunity(productId: string, candidate: CountryOpportunityResult): boolean {
  if (!candidate || candidate.productId !== productId) return false;
  if (candidate.tier === "unknown") return false;
  if (!candidate.score || candidate.score.totalWeight === 0) return false;
  return true;
}

function compareCountryOpportunity(a: CountryOpportunityResult, b: CountryOpportunityResult): number {
  if (b.score.normalized !== a.score.normalized) return b.score.normalized - a.score.normalized;
  if (b.score.value !== a.score.value) return b.score.value - a.score.value;
  return compareCountryCode(a.country, b.country);
}

function compareCountryCode(a: V1Country, b: V1Country): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeProductId(value: unknown): string {
  const productId = typeof value === "string" ? value.trim() : "";
  if (!productId) {
    throw new DecisionError("INVALID_PRODUCT", "productId is required and must be a non-empty string");
  }
  return productId;
}
