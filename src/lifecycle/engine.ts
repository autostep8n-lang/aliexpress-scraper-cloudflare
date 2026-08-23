/**
 * Product Lifecycle Engine - deterministic evaluation.
 *
 * Builds evidence from a persisted product record + P1.4 trend summaries and
 * applies the ordered transition rules to produce a decision. Purely
 * functional: no I/O, no wall-clock time (`now` is injected), and identical
 * inputs always produce identical decisions.
 */

import { normalizeTimestamp } from "../trends";
import type { TrendMetricType, TrendSummary } from "../trends/types";
import { LIFECYCLE_RULES, type RuleContext } from "./rules";
import {
  DEFAULT_THRESHOLDS,
  LIFECYCLE_TRANSITIONS,
  type LifecycleDecision,
  type LifecycleEvidence,
  type LifecycleStatus,
  type LifecycleSourceRecord,
  type LifecycleThresholds,
  type LifecycleTransition,
  type ProductLifecycleInput,
} from "./types";

const MS_PER_DAY = 86_400_000;

/** Signed day difference between two ISO timestamps, or null when unusable. */
function diffDays(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (b - a) / MS_PER_DAY;
}

/**
 * Derives the deterministic evidence a product exposes at evaluation time.
 * Invalid or missing timestamps yield null day-differences so no rule that
 * depends on recency can fire for them.
 */
export function buildEvidence(
  input: ProductLifecycleInput,
  thresholds: LifecycleThresholds = DEFAULT_THRESHOLDS,
): LifecycleEvidence {
  const firstSeen = normalizeTimestamp(input.firstSeenAt);
  const lastSeen = normalizeTimestamp(input.lastSeenAt);
  const now = normalizeTimestamp(input.now);
  const daysSinceFirstSeen = diffDays(firstSeen, now);
  const daysSinceLastSeen = diffDays(lastSeen, now);

  const price = input.trends.price;
  const availability = input.trends.availability;
  const priceCount = price?.count ?? 0;
  const priceFirst = price?.first?.value ?? null;
  const priceChange = price?.change ?? null;
  const priceChangePct =
    priceFirst !== null && priceFirst !== 0 && priceChange !== null ? priceChange / priceFirst : null;

  return {
    daysSinceFirstSeen,
    daysSinceLastSeen,
    seenRecently: daysSinceLastSeen !== null && daysSinceLastSeen <= thresholds.staleDays,
    inStock: input.availability === "in_stock",
    discontinued: input.availability === "discontinued",
    priceCount,
    priceDirection: price?.direction ?? "unknown",
    priceChange,
    priceChangePct,
    availabilityCount: availability?.count ?? 0,
    availabilityFirst: availability?.first?.value ?? null,
    availabilityLast: availability?.last?.value ?? null,
    hasTrendHistory: priceCount >= thresholds.minTrendCount,
  };
}

/**
 * Evaluates the lifecycle for a product. Returns the recommended next status
 * together with the rule that produced it (or null when staying put) and the
 * evidence used, so decisions are explainable.
 */
export function evaluateLifecycle(
  input: ProductLifecycleInput,
  thresholds: LifecycleThresholds = DEFAULT_THRESHOLDS,
): LifecycleDecision {
  const evidence = buildEvidence(input, thresholds);
  const ctx: RuleContext = {
    input: { status: input.status, availability: input.availability },
    thresholds,
    evidence,
  };
  const rule = LIFECYCLE_RULES.find((candidate) => candidate.condition(ctx)) ?? LIFECYCLE_RULES[LIFECYCLE_RULES.length - 1];
  return buildDecision(input.status, rule, evidence);
}

/** Convenience wrapper returning only the recommended status. */
export function deriveLifecycleStatus(
  input: ProductLifecycleInput,
  thresholds: LifecycleThresholds = DEFAULT_THRESHOLDS,
): LifecycleStatus {
  return evaluateLifecycle(input, thresholds).to;
}

/**
 * Returns whether a transition is allowed by `LIFECYCLE_TRANSITIONS`.
 * Self-transitions are always allowed (a product may stay in its state).
 */
export function canTransition(from: LifecycleStatus, to: LifecycleStatus): boolean {
  if (from === to) return true;
  return LIFECYCLE_TRANSITIONS.some((spec) => spec.from === from && spec.to === to);
}

/**
 * Adapter over a persisted product record (e.g. a `PersistedProductRecord`):
 * maps its lifecycle/availability/timestamps into a `ProductLifecycleInput`
 * alongside P1.4 trend summaries, then evaluates. `firstSeenAt` falls back to
 * `lastSeenAt` when the record does not carry it.
 */
export function fromRecord(
  record: LifecycleSourceRecord,
  trends: Partial<Record<TrendMetricType, TrendSummary>>,
  now: string,
  thresholds: LifecycleThresholds = DEFAULT_THRESHOLDS,
): LifecycleDecision {
  return evaluateLifecycle(
    {
      status: record.lifecycleStatus ?? "discovered",
      availability: record.availabilityStatus,
      firstSeenAt: record.firstSeenAt ?? record.lastSeenAt,
      lastSeenAt: record.lastSeenAt,
      now,
      trends,
    },
    thresholds,
  );
}

function buildDecision(
  from: LifecycleStatus,
  rule: (typeof LIFECYCLE_RULES)[number],
  evidence: LifecycleEvidence,
): LifecycleDecision {
  const to = rule.next;
  const transitioned = to !== from;
  const transition: LifecycleTransition | null = transitioned
    ? { id: rule.id, label: rule.label, from, to, reason: rule.reason(evidence) }
    : null;
  return { from, to, transitioned, transition, evidence };
}
