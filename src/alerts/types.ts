/**
 * Alerts domain types (P7.31).
 *
 * An alert is a deterministic, deduplicated observation over data that is
 * already persisted (market opportunity scores, country opportunity scores and
 * product lifecycle state). The engine never recomputes or invents a score:
 * missing or unusable evidence yields no alert rather than a zero-valued one.
 */

/** v1 alert families. Deliberately small; `high_decision_opportunity` is out of scope. */
export const ALERT_TYPES = ["high_market_opportunity", "high_country_opportunity", "lifecycle_review"] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_STATUSES = ["active", "resolved"] as const;

export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_SEVERITIES = ["high", "medium", "low"] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Market opportunity tier threshold mirrored from `DEFAULT_OPPORTUNITY_THRESHOLDS.high`. */
export const HIGH_MARKET_OPPORTUNITY_THRESHOLD = 65;

/** Deterministic alert candidate produced by the pure engine. */
export interface AlertCandidate {
  productId: string;
  alertType: AlertType;
  severity: AlertSeverity;
  dedupKey: string;
  title: string;
  message: string;
  evidence: Record<string, unknown>;
}

/** Already-persisted market opportunity evidence (from the `scores` table). */
export interface MarketOpportunityAlertEvidence {
  productId: string;
  scoreType: string;
  value: number;
  totalWeight: number;
}

/** Already-persisted country opportunity evidence (from `country_opportunity_scores`). */
export interface CountryOpportunityAlertEvidence {
  productId: string;
  country: string;
  scoreType: string;
  value: number;
  totalWeight: number;
  tier: string;
}

/** Product lifecycle state carried on the persisted `products` row. */
export interface LifecycleAlertEvidence {
  productId: string;
  lifecycleStatus: string;
}

export interface AlertEngineInput {
  marketOpportunities?: readonly MarketOpportunityAlertEvidence[];
  countryOpportunities?: readonly CountryOpportunityAlertEvidence[];
  lifecycles?: readonly LifecycleAlertEvidence[];
}
