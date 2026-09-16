/**
 * Alerts Engine - deterministic evaluation (P7.31).
 *
 * Pure: no I/O, no wall-clock time, no randomness, no side effects. Identical
 * inputs always produce identical outputs. The engine only reads already-
 * persisted evidence (market / country opportunity scores and product
 * lifecycle state); it never recomputes a score and never coerces missing,
 * non-finite or structurally invalid evidence into a value. Such evidence
 * yields no candidate at all.
 */

import { isV1Country } from "../country/engine";
import {
  ALERT_TYPES,
  HIGH_MARKET_OPPORTUNITY_THRESHOLD,
  type AlertCandidate,
  type AlertEngineInput,
  type AlertSeverity,
  type AlertType,
  type CountryOpportunityAlertEvidence,
  type LifecycleAlertEvidence,
  type MarketOpportunityAlertEvidence,
} from "./types";

export const MARKET_OPPORTUNITY_SCORE_TYPE = "market_opportunity";
export const COUNTRY_OPPORTUNITY_SCORE_TYPE = "country_opportunity";

/**
 * Deterministic severity for each evidence family, from least to most
 * attention-worthy. Kept in one place so the mapping is explicit and testable
 * rather than derived from an opaque score band.
 */
const SEVERITY_BY_ALERT_TYPE: Record<AlertType, AlertSeverity> = {
  high_market_opportunity: "critical",
  high_country_opportunity: "warning",
  lifecycle_review: "info",
};

/** The severity assigned to a given alert family. */
export function severityForAlertType(alertType: AlertType): AlertSeverity {
  return SEVERITY_BY_ALERT_TYPE[alertType];
}

/** Stable identity of an alert: one row per product x type x dedup_key. */
export function candidateKey(productId: string, alertType: string, dedupKey: string): string {
  return `${productId}\u0000${alertType}\u0000${dedupKey}`;
}

/** Stable identity of a persisted alert row. */
export function alertRowKey(alert: { product_id: string; alert_type: string; dedup_key: string }): string {
  return candidateKey(alert.product_id, alert.alert_type, alert.dedup_key);
}

/**
 * Evaluates every evidence family and returns a deterministic, deduplicated
 * candidate list ordered by (productId, alertType, dedupKey). When the same
 * identity is produced more than once the strongest evidence wins, so the
 * result is independent of the input ordering.
 */
export function evaluateAlerts(input: AlertEngineInput): AlertCandidate[] {
  const ranked = new Map<string, { candidate: AlertCandidate; strength: number }>();

  const consider = (candidate: AlertCandidate | null, strength: number): void => {
    if (!candidate) return;
    const key = candidateKey(candidate.productId, candidate.alertType, candidate.dedupKey);
    const existing = ranked.get(key);
    if (!existing || strength > existing.strength) {
      ranked.set(key, { candidate, strength });
    }
  };

  for (const evidence of input.marketOpportunities ?? []) {
    consider(evaluateMarketOpportunity(evidence), strengthOf(evidence.value));
  }
  for (const evidence of input.countryOpportunities ?? []) {
    consider(evaluateCountryOpportunity(evidence), strengthOf(evidence.value));
  }
  for (const evidence of input.lifecycles ?? []) {
    for (const candidate of evaluateLifecycle(evidence)) {
      consider(candidate, strengthOf(0));
    }
  }

  return [...ranked.values()]
    .map((entry) => entry.candidate)
    .sort(compareCandidates);
}

/** A persisted market opportunity score is high when value >= 65 with real weight. */
export function evaluateMarketOpportunity(evidence: MarketOpportunityAlertEvidence): AlertCandidate | null {
  if (!isUsableProductId(evidence.productId)) return null;
  if (evidence.scoreType !== MARKET_OPPORTUNITY_SCORE_TYPE) return null;
  if (!isFiniteNumber(evidence.value) || !isFiniteNumber(evidence.totalWeight)) return null;
  if (evidence.totalWeight <= 0) return null;
  if (evidence.value < HIGH_MARKET_OPPORTUNITY_THRESHOLD) return null;

  return {
    productId: evidence.productId,
    alertType: "high_market_opportunity",
    severity: severityForAlertType("high_market_opportunity"),
    dedupKey: "market_opportunity:high",
    title: "High market opportunity",
    summary: `Market opportunity score ${evidence.value} meets the high threshold.`,
    value: evidence.value,
    tier: "high",
    inputs: {
      score_type: evidence.scoreType,
      total_weight: evidence.totalWeight,
      threshold: HIGH_MARKET_OPPORTUNITY_THRESHOLD,
    },
  };
}

/** A persisted country score is high only for an eligible v1 country. */
export function evaluateCountryOpportunity(evidence: CountryOpportunityAlertEvidence): AlertCandidate | null {
  if (!isUsableProductId(evidence.productId)) return null;
  if (evidence.scoreType !== COUNTRY_OPPORTUNITY_SCORE_TYPE) return null;
  if (evidence.tier !== "high") return null;
  if (!isV1Country(evidence.country)) return null;
  if (!isFiniteNumber(evidence.value) || !isFiniteNumber(evidence.totalWeight)) return null;
  if (evidence.totalWeight <= 0) return null;

  const country = evidence.country;
  return {
    productId: evidence.productId,
    alertType: "high_country_opportunity",
    severity: severityForAlertType("high_country_opportunity"),
    dedupKey: `country_opportunity:${country}:high`,
    title: `High opportunity in ${country}`,
    summary: `Country opportunity score ${evidence.value} in ${country} is tiered high.`,
    country,
    value: evidence.value,
    tier: "high",
    inputs: {
      score_type: evidence.scoreType,
      total_weight: evidence.totalWeight,
    },
  };
}

/** Lifecycle review alerts are emitted only for the review-worthy terminal states. */
export function evaluateLifecycle(evidence: LifecycleAlertEvidence): AlertCandidate[] {
  if (!isUsableProductId(evidence.productId)) return [];
  const status = evidence.lifecycleStatus;

  if (status === "inactive") {
    return [
      {
        productId: evidence.productId,
        alertType: "lifecycle_review",
        severity: severityForAlertType("lifecycle_review"),
        dedupKey: "lifecycle:inactive",
        title: "Product inactive",
        summary: "Product is inactive and should be reviewed.",
        inputs: { lifecycle_status: status },
      },
    ];
  }

  if (status === "archived") {
    return [
      {
        productId: evidence.productId,
        alertType: "lifecycle_review",
        severity: severityForAlertType("lifecycle_review"),
        dedupKey: "lifecycle:archived",
        title: "Product archived",
        summary: "Product is archived and should be reviewed.",
        inputs: { lifecycle_status: status },
      },
    ];
  }

  return [];
}

export function isAlertType(value: string): value is AlertType {
  return (ALERT_TYPES as readonly string[]).includes(value);
}

function isUsableProductId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function strengthOf(value: number): number {
  return Number.isFinite(value) ? value : -Infinity;
}

function compareCandidates(left: AlertCandidate, right: AlertCandidate): number {
  if (left.productId !== right.productId) return left.productId < right.productId ? -1 : 1;
  if (left.alertType !== right.alertType) return left.alertType < right.alertType ? -1 : 1;
  if (left.dedupKey !== right.dedupKey) return left.dedupKey < right.dedupKey ? -1 : 1;
  return 0;
}
