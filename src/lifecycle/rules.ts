/**
 * Product Lifecycle Engine - deterministic transition rules.
 *
 * Rules are evaluated in order; the first whose condition matches wins, so a
 * given set of evidence always maps to exactly one outcome. The final
 * `lifecycle.tracking` rule is an unconditional fallback, guaranteeing the
 * rule list never exhausts.
 */

import type { LifecycleEvidence, LifecycleStatus } from "./types";

export interface RuleContext {
  input: {
    status: LifecycleStatus;
    availability: string;
  };
  thresholds: {
    newWindowDays: number;
    staleDays: number;
    expiredDays: number;
    minTrendCount: number;
    decliningPricePct: number;
  };
  evidence: LifecycleEvidence;
}

export interface LifecycleRule {
  id: string;
  label: string;
  condition: (ctx: RuleContext) => boolean;
  next: LifecycleStatus;
  reason: (evidence: LifecycleEvidence) => string;
}

export const LIFECYCLE_RULES: readonly LifecycleRule[] = [
  {
    id: "lifecycle.revive",
    label: "Revived from archive",
    condition: (ctx) => ctx.input.status === "archived" && ctx.evidence.seenRecently && ctx.evidence.inStock,
    next: "active",
    reason: () => "Archived product was observed in stock again; reactivated as active.",
  },
  {
    id: "lifecycle.archived_terminal",
    label: "Archived terminal state",
    condition: (ctx) => ctx.input.status === "archived",
    next: "archived",
    reason: () => "Archived lifecycle is terminal; the product stays archived.",
  },
  {
    id: "lifecycle.expired",
    label: "Expired",
    condition: (ctx) =>
      ctx.evidence.daysSinceLastSeen !== null && ctx.evidence.daysSinceLastSeen > ctx.thresholds.expiredDays,
    next: "archived",
    reason: (evidence) =>
      `Not observed for ${evidence.daysSinceLastSeen!.toFixed(1)} days; archived as expired.`,
  },
  {
    id: "lifecycle.discontinued",
    label: "Discontinued",
    condition: (ctx) => ctx.evidence.discontinued,
    next: "inactive",
    reason: () => "Product is discontinued.",
  },
  {
    id: "lifecycle.stale",
    label: "Stale",
    condition: (ctx) =>
      ctx.evidence.daysSinceLastSeen !== null && ctx.evidence.daysSinceLastSeen > ctx.thresholds.staleDays,
    next: "inactive",
    reason: (evidence) => `Not observed for ${evidence.daysSinceLastSeen!.toFixed(1)} days; marked inactive.`,
  },
  {
    id: "lifecycle.declining_availability",
    label: "Declining availability",
    condition: (ctx) =>
      ctx.evidence.availabilityCount >= ctx.thresholds.minTrendCount &&
      ctx.evidence.availabilityFirst === 1 &&
      ctx.evidence.availabilityLast === 0,
    next: "tracking",
    reason: () => "Product went from available to unavailable in the latest observations; tracking.",
  },
  {
    id: "lifecycle.declining_price",
    label: "Declining price",
    condition: (ctx) =>
      ctx.evidence.priceCount >= ctx.thresholds.minTrendCount &&
      ctx.evidence.priceDirection === "down" &&
      ctx.evidence.priceChangePct !== null &&
      ctx.evidence.priceChangePct <= -ctx.thresholds.decliningPricePct,
    next: "tracking",
    reason: (evidence) =>
      `Price declined ${(Math.abs(evidence.priceChangePct!) * 100).toFixed(1)}%; tracking.`,
  },
  {
    id: "lifecycle.new",
    label: "Newly discovered",
    condition: (ctx) =>
      ctx.input.status === "discovered" &&
      ctx.evidence.daysSinceFirstSeen !== null &&
      ctx.evidence.daysSinceFirstSeen <= ctx.thresholds.newWindowDays &&
      ctx.evidence.priceCount < ctx.thresholds.minTrendCount,
    next: "discovered",
    reason: (evidence) =>
      `Discovered ${evidence.daysSinceFirstSeen!.toFixed(1)} days ago with insufficient history.`,
  },
  {
    id: "lifecycle.active",
    label: "Active",
    condition: (ctx) =>
      ctx.evidence.seenRecently && (ctx.evidence.inStock || ctx.input.availability === "unknown"),
    next: "active",
    reason: () => "Product is available and was recently observed.",
  },
  {
    id: "lifecycle.tracking",
    label: "Under observation",
    condition: () => true,
    next: "tracking",
    reason: () => "Not enough evidence to classify; kept under observation.",
  },
];
