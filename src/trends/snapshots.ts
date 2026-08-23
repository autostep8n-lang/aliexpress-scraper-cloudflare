/**
 * Trend History Engine - snapshot adapters.
 *
 * Bridges normalized `Product` objects and persisted `trend_history` rows:
 * `snapshotProduct` turns one product into the append-only observation rows to
 * write, and `trendsFromObservations` turns read-back rows into sorted series
 * plus derived summaries. Both are pure and deterministic.
 */

import type { Product } from "../products/types";
import { buildObservations, isTrendMetricType, normalizeTimestamp, summarizeMetric, toFiniteNumber } from "./engine";
import {
  TREND_METRIC_TYPES,
  type ProductTrendSnapshot,
  type TrendMetricType,
  type TrendObservationRecord,
  type TrendSeries,
  type TrendSummary,
} from "./types";

export interface SnapshotProductOptions {
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
 * Produces the append-only `trend_history` observations for one product
 * snapshot. `capturedAt` mirrors the timestamp used for the rows (empty string
 * when no observation could be built).
 */
export function snapshotProduct(product: Product, options: SnapshotProductOptions): ProductTrendSnapshot {
  const observations = buildObservations(product, options);
  return {
    productId: options.productId,
    capturedAt: observations[0]?.captured_at ?? "",
    observations,
  };
}

export interface TrendsResult {
  /** One sorted series per metric type, in `TREND_METRIC_TYPES` order. */
  series: TrendSeries[];
  /** One summary per metric type, in `TREND_METRIC_TYPES` order. */
  summaries: TrendSummary[];
}

/**
 * Groups persisted `trend_history` rows by metric type and derives sorted
 * series plus summaries. Unknown metric types, unparseable timestamps and
 * non-finite values are skipped safely; every known metric type is present in
 * the result (possibly empty) so callers can rely on a fixed shape.
 */
export function trendsFromObservations(records: TrendObservationRecord[]): TrendsResult {
  const grouped = new Map<TrendMetricType, Array<{ at: string; value: number }>>();

  for (const record of records) {
    if (!isTrendMetricType(record.metric_type)) continue;
    const at = normalizeTimestamp(record.captured_at);
    const value = toFiniteNumber(record.value);
    if (at === null || value === undefined) continue;

    let points = grouped.get(record.metric_type);
    if (!points) {
      points = [];
      grouped.set(record.metric_type, points);
    }
    points.push({ at, value });
  }

  const series: TrendSeries[] = [];
  const summaries: TrendSummary[] = [];
  for (const metricType of TREND_METRIC_TYPES) {
    const summary = summarizeMetric(metricType, grouped.get(metricType) ?? []);
    series.push(summary.series);
    summaries.push(summary);
  }

  return { series, summaries };
}
