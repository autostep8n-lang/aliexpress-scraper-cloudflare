/**
 * Product Lifecycle Engine - domain types.
 *
 * Lifecycle states mirror the `products.lifecycle_status` CHECK constraint in
 * the existing schema (migration 20260817000003), so decisions produced here
 * are directly persistable. Evaluation is deterministic: the same product +
 * trend evidence + evaluation time always yields the same status.
 */

import type { TrendMetricType, TrendSummary } from "../trends/types";

/**
 * Lifecycle states, in the same order/values as the `products.lifecycle_status`
 * schema constraint. Semantics:
 *
 * - `discovered`: recently found, not enough history to classify.
 * - `active`: available, recently observed, healthy (rising/flat trend).
 * - `tracking`: under observation but declining or unclassifiable yet.
 * - `inactive`: stale or discontinued; may still come back.
 * - `archived`: expired / terminal; only a clear revival exits it.
 */
export const LIFECYCLE_STATES = ["discovered", "active", "tracking", "inactive", "archived"] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATES)[number];

/** Availability values as persisted on `products.availability_status`. */
export type AvailabilityStatus = "in_stock" | "out_of_stock" | "preorder" | "discontinued" | "unknown";

/** Tunable thresholds; every evaluation is deterministic given a threshold set. */
export interface LifecycleThresholds {
  /** Days since first seen during which a product is still considered "new". */
  newWindowDays: number;
  /** Days without an observation before a product becomes "inactive". */
  staleDays: number;
  /** Days without an observation before an inactive product is "archived". */
  expiredDays: number;
  /** Minimum observations required before trend evidence is trusted. */
  minTrendCount: number;
  /** Price decline (fraction, e.g. 0.1 = 10%) that classifies a product as declining. */
  decliningPricePct: number;
}

export const DEFAULT_THRESHOLDS: LifecycleThresholds = {
  newWindowDays: 14,
  staleDays: 30,
  expiredDays: 90,
  minTrendCount: 2,
  decliningPricePct: 0.1,
};

/** All inputs the engine needs to make a deterministic decision. */
export interface ProductLifecycleInput {
  /** Current persisted lifecycle status. */
  status: LifecycleStatus;
  /** Availability from the unified `products` row. */
  availability: AvailabilityStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Evaluation time, injected by the caller for determinism (never `Date.now`). */
  now: string;
  /** Reused P1.4 trend summaries, keyed by metric type. */
  trends: Partial<Record<TrendMetricType, TrendSummary>>;
}

/** Derived, deterministic evidence used by the transition rules. */
export interface LifecycleEvidence {
  /** Whole+fraction days since first seen; null when timestamps are unusable. */
  daysSinceFirstSeen: number | null;
  /** Whole+fraction days since last seen; null when timestamps are unusable. */
  daysSinceLastSeen: number | null;
  /** True when observed within the `staleDays` window. */
  seenRecently: boolean;
  inStock: boolean;
  discontinued: boolean;
  priceCount: number;
  priceDirection: TrendSummary["direction"];
  priceChange: number | null;
  /** Relative price change vs the first value; null when it cannot be computed safely. */
  priceChangePct: number | null;
  availabilityCount: number;
  availabilityFirst: number | null;
  availabilityLast: number | null;
  /** True when enough price observations exist to trust trend evidence. */
  hasTrendHistory: boolean;
}

/** The concrete transition applied by a rule, or null when staying put. */
export interface LifecycleTransition {
  id: string;
  label: string;
  from: LifecycleStatus;
  to: LifecycleStatus;
  reason: string;
}

/** The outcome of one evaluation. */
export interface LifecycleDecision {
  from: LifecycleStatus;
  to: LifecycleStatus;
  transitioned: boolean;
  transition: LifecycleTransition | null;
  evidence: LifecycleEvidence;
}

/** A documented, allowed non-self transition between lifecycle states. */
export interface LifecycleTransitionSpec {
  from: LifecycleStatus;
  to: LifecycleStatus;
  label: string;
}

/**
 * Allowed non-self transitions. Self-transitions (staying put) are always
 * permitted; every rule result must be either a self-transition or one of
 * these, otherwise the engine's rules would be inconsistent with this table.
 */
export const LIFECYCLE_TRANSITIONS: readonly LifecycleTransitionSpec[] = [
  { from: "discovered", to: "active", label: "Promoted after sufficient history" },
  { from: "discovered", to: "tracking", label: "Declining before promotion" },
  { from: "discovered", to: "inactive", label: "Went stale or discontinued" },
  { from: "discovered", to: "archived", label: "Expired" },
  { from: "active", to: "tracking", label: "Declining" },
  { from: "active", to: "inactive", label: "Went stale or discontinued" },
  { from: "active", to: "archived", label: "Expired" },
  { from: "tracking", to: "active", label: "Recovered" },
  { from: "tracking", to: "inactive", label: "Went stale or discontinued" },
  { from: "tracking", to: "archived", label: "Expired" },
  { from: "inactive", to: "active", label: "Reactivated" },
  { from: "inactive", to: "tracking", label: "Reactivated but declining" },
  { from: "inactive", to: "archived", label: "Expired" },
  { from: "archived", to: "active", label: "Revived" },
];

/** Persisted-product record shape the adapter accepts (structural subset). */
export interface LifecycleSourceRecord {
  lifecycleStatus?: LifecycleStatus;
  availabilityStatus: AvailabilityStatus;
  firstSeenAt?: string;
  lastSeenAt: string;
}
