/**
 * AI Product Analyst (P5.25) — deterministic template explainer.
 *
 * Pure, no I/O, no wall-clock time. Reads a frozen P5.24
 * DecisionOpportunityResult and produces an AnalystResult. The numeric
 * score is copied, never recalculated. Identical inputs always produce
 * identical outputs.
 */

import type { DecisionOpportunityResult } from "../decision/types";
import type { ScoreSignal } from "../scoring/types";
import type {
  AnalystCountryEvidence,
  AnalystEvidence,
  AnalystMarketEvidence,
  AnalystResult,
  AnalystScoreEcho,
  AnalystSignalEvidence,
} from "./types";

export function explainDecision(decision: DecisionOpportunityResult): AnalystResult {
  const score = echoScore(decision);
  const evidence = buildAnalystEvidence(decision);
  const caveats = buildCaveats(evidence);
  return {
    productId: decision.productId,
    score,
    selectedCountry: decision.selectedCountry,
    summary: buildSummary(score, evidence, caveats),
    evidence,
    caveats,
    provider: "template",
  };
}

export function buildAnalystEvidence(decision: DecisionOpportunityResult): AnalystEvidence {
  const market = decision.marketOpportunity;
  const country = decision.selectedCountryOpportunity;
  const countryIntel = country?.countryIntelligence;
  const marketPresent = Boolean(market && market.score.totalWeight > 0);
  const countryPresent = Boolean(country && country.score.totalWeight > 0 && decision.selectedCountry);

  const marketEvidence: AnalystMarketEvidence = marketPresent && market
    ? {
        present: true,
        value: market.score.value,
        normalized: market.score.normalized,
        tier: market.tier,
        totalWeight: market.score.totalWeight,
        signals: market.score.signals.map(copySignal),
      }
    : {
        present: false,
        value: null,
        normalized: null,
        tier: null,
        totalWeight: null,
        signals: [],
      };

  const countryEvidence: AnalystCountryEvidence = countryPresent && country
    ? {
        present: true,
        country: country.country,
        value: country.score.value,
        normalized: country.score.normalized,
        tier: country.tier,
        latestValue: countryIntel ? countryIntel.latestValue : null,
        change: countryIntel ? countryIntel.change : null,
        direction: countryIntel ? countryIntel.direction : null,
      }
    : {
        present: false,
        country: null,
        value: null,
        normalized: null,
        tier: null,
        latestValue: null,
        change: null,
        direction: null,
      };

  return {
    totalWeight: decision.score.totalWeight,
    decisionSignals: decision.score.signals.map(copySignal),
    market: marketEvidence,
    country: countryEvidence,
  };
}

function echoScore(decision: DecisionOpportunityResult): AnalystScoreEcho {
  return {
    scoreType: decision.score.scoreType,
    version: decision.score.version,
    value: decision.score.value,
    normalized: decision.score.normalized,
    tier: decision.tier,
  };
}

function buildCaveats(evidence: AnalystEvidence): string[] {
  const caveats: string[] = [];
  const productSignal = evidence.decisionSignals.find((signal) => signal.key === "product_market_opportunity");
  const countrySignal = evidence.decisionSignals.find((signal) => signal.key === "country_opportunity");
  if (!productSignal?.present) caveats.push("product market opportunity is missing");
  if (!countrySignal?.present || !evidence.country.present) caveats.push("country opportunity is missing");
  return caveats;
}

function buildSummary(score: AnalystScoreEcho, evidence: AnalystEvidence, caveats: string[]): string {
  const parts = [`Decision opportunity score ${score.value} (${score.tier}).`];
  if (evidence.market.present) {
    parts.push(`Product market opportunity ${evidence.market.value} (${evidence.market.tier}).`);
  }
  if (evidence.country.present && evidence.country.country !== null) {
    parts.push(
      `Selected country ${evidence.country.country} scored ${evidence.country.value} (${evidence.country.tier}).`,
    );
  }
  if (caveats.length > 0) {
    parts.push(`Caveats: ${caveats.join("; ")}.`);
  }
  return parts.join(" ");
}

function copySignal(signal: ScoreSignal): AnalystSignalEvidence {
  const copied: AnalystSignalEvidence = {
    key: signal.key,
    label: signal.label,
    weight: signal.weight,
    value: signal.value,
    present: signal.present,
    contribution: signal.contribution,
  };
  if (signal.detail !== undefined) copied.detail = signal.detail;
  return copied;
}
