/**
 * Trend History Engine - pure, deterministic computation.
 *
 * No I/O, no platform logic, no wall-clock time: every function is a pure
 * function of its inputs, so identical inputs always produce identical
 * outputs. Missing or malformed data is skipped rather than thrown on.
 */

import type { Product } from "../products/types";
import {
  TREND_METRIC_TYPES,
  type ProductMetrics,
  type TrendDirection,
  type TrendMetricType,
  type TrendObservationRow,
  type TrendPoint,
  type TrendSeries,
  type TrendStats,
  type TrendSummary,
} from "./types";

const MS_PER_DAY = 86_400_000;

export function isTrendMetricType(value: unknown): value is TrendMetricType {
  return typeof value === "string" && (TREND_METRIC_TYPES as readonly string[]).includes(value);
}

/**
 * Returns the value when it is a finite number (or a numeric string),
 * otherwise undefined. Used to drop missing/garbage data safely.
 */
export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

/** Returns the timestamp when parseable, otherwise null. */
export function normalizeTimestamp(value: string): string | null {
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/** Numeric product metrics extracted from a normalized `Product`. */
export function extractProductMetrics(product: Product): ProductMetrics {
  const price = product.price.amount;
  const currency = product.price.currency;
  const ratingAverage = toFiniteNumber(product.rating?.average) ?? null;
  const ratingCount = toFiniteNumber(product.rating?.count) ?? null;
  const availability = product.available === true ? 1 : product.available === false ? 0 : null;
  return { price, currency, ratingAverage, ratingCount, availability };
}

export interface BuildObservationsOptions {
  /** Unified `products.id` the observation rows scope to. */
  productId: string;
  /** Optional observation (`product_sources.id`) scope for this snapshot. */
  productSourceId?: string | null;
  /** Optional source (`sources.id`) scope for this snapshot. */
  sourceId?: string | null;
  /** Snapshot timestamp. Defaults to `product.scrapedAt`. */
  capturedAt?: string;
  /** Extra metadata merged into every row's `metadata` jsonb. */
  metadata?: Record<string, unknown>;
}

/**
 * Builds the append-only `trend_history` rows for one product snapshot:
 * one row per metric type the product actually carries, in a fixed,
 * deterministic order (`TREND_METRIC_TYPES`). Missing metrics (rating,
 * rating count, availability) are omitted; the row count is never inferred
 * from the number of fields present.
 *
 * The default `captured_at` is `product.scrapedAt`, so a snapshot is fully
 * deterministic for a given product and never depends on wall-clock time.
 * Returns an empty array when no valid timestamp can be resolved (malformed
 * input) rather than throwing.
 */
export function buildObservations(product: Product, options: BuildObservationsOptions): TrendObservationRow[] {
  const capturedAt = resolveCapturedAt(product, options.capturedAt ?? null);
  if (capturedAt === null) {
    return [];
  }

  const metrics = extractProductMetrics(product);
  const metadata = { ...(options.metadata ?? {}), platform: product.platform, externalId: product.externalId };
  const base = {
    product_id: options.productId,
    product_source_id: options.productSourceId ?? null,
    source_id: options.sourceId ?? null,
    captured_at: capturedAt,
    metadata,
  };

  const rows: TrendObservationRow[] = [
    { ...base, metric_type: "price", value: metrics.price, unit: metrics.currency },
  ];
  if (metrics.ratingAverage !== null) {
    rows.push({ ...base, metric_type: "rating", value: metrics.ratingAverage, unit: null });
  }
  if (metrics.ratingCount !== null) {
    rows.push({ ...base, metric_type: "rating_count", value: metrics.ratingCount, unit: null });
  }
  if (metrics.availability !== null) {
    rows.push({ ...base, metric_type: "availability", value: metrics.availability, unit: null });
  }
  return rows;
}

/**
 * Sorts points ascending by timestamp, dropping invalid timestamps and
 * non-finite values. Ties are broken deterministically (by value, then by
 * timestamp string) so the result is independent of input order.
 */
export function sortPoints(points: TrendPoint[]): TrendPoint[] {
  const valid: TrendPoint[] = [];
  for (const point of points) {
    const value = toFiniteNumber(point.value);
    const at = normalizeTimestamp(point.at);
    if (value === undefined || at === null) continue;
    valid.push({ at, value });
  }
  return valid.sort(comparePoints);
}

function comparePoints(a: TrendPoint, b: TrendPoint): number {
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  if (ta !== tb) return ta - tb;
  if (a.value !== b.value) return a.value - b.value;
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}

/**
 * Derives statistics for a series: observation count, first/last values,
 * change, direction, min/max, span and velocity per day. Safe on empty or
 * single-point series: derived fields are null and direction is "unknown".
 */
export function computeStats(points: TrendPoint[]): TrendStats {
  const sorted = sortPoints(points);
  const count = sorted.length;

  if (count === 0) {
    return {
      count,
      first: null,
      last: null,
      change: null,
      direction: "unknown",
      min: null,
      max: null,
      spanMs: null,
      velocityPerDay: null,
    };
  }

  const first = sorted[0];
  const last = sorted[count - 1];
  let min = first;
  let max = first;
  for (const point of sorted) {
    if (point.value < min.value) min = point;
    if (point.value > max.value) max = point;
  }

  if (count === 1) {
    return {
      count,
      first,
      last,
      change: null,
      direction: "unknown",
      min,
      max,
      spanMs: null,
      velocityPerDay: null,
    };
  }

  const change = last.value - first.value;
  const spanMs = Date.parse(last.at) - Date.parse(first.at);
  const direction: TrendDirection = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const velocityPerDay = spanMs > 0 ? change / (spanMs / MS_PER_DAY) : null;

  return { count, first, last, change, direction, min, max, spanMs, velocityPerDay };
}

/** Computes the summary for one metric type over the given points. */
export function summarizeMetric(metricType: TrendMetricType, points: TrendPoint[]): TrendSummary {
  const sorted = sortPoints(points);
  return {
    metricType,
    ...computeStats(sorted),
    series: { metricType, points: sorted },
  };
}

export function summarizeSeries(series: TrendSeries): TrendSummary {
  return summarizeMetric(series.metricType, series.points);
}

function resolveCapturedAt(product: Product, candidate: string | null): string | null {
  if (candidate !== null) {
    const normalized = normalizeTimestamp(candidate);
    if (normalized !== null) return normalized;
  }
  return normalizeTimestamp(product.scrapedAt);
}
