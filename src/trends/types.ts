/**
 * Trend History Engine - domain types.
 *
 * The engine is source-agnostic: it operates purely on normalized `Product`
 * snapshots and observation rows, with no platform-specific logic. All outputs
 * are deterministic functions of their inputs.
 */

/** Metric types the engine tracks from product snapshots. */
export const TREND_METRIC_TYPES = ["price", "rating", "rating_count", "availability"] as const;

export type TrendMetricType = (typeof TREND_METRIC_TYPES)[number];

/** Direction of change between the first and last observation of a series. */
export type TrendDirection = "up" | "down" | "flat" | "unknown";

/**
 * Numeric metrics extracted from a normalized `Product`. Optional fields are
 * `null` when the product does not carry the underlying data.
 */
export interface ProductMetrics {
  price: number;
  currency: string;
  ratingAverage: number | null;
  ratingCount: number | null;
  /** 1 when available, 0 when unavailable, null when unknown. */
  availability: number | null;
}

/** A single time-series observation. */
export interface TrendPoint {
  /** ISO-8601 timestamp of the observation. */
  at: string;
  value: number;
}

/** A sorted, deterministic series of points for one metric type. */
export interface TrendSeries {
  metricType: TrendMetricType;
  points: TrendPoint[];
}

/**
 * Derived statistics for a series. All derived fields are `null` when the
 * series does not contain enough (valid) data to compute them safely.
 */
export interface TrendStats {
  /** Number of valid observations in the series. */
  count: number;
  /** Earliest observation, or null when the series is empty. */
  first: TrendPoint | null;
  /** Latest observation, or null when the series is empty. */
  last: TrendPoint | null;
  /** `last.value - first.value`, or null when the series has fewer than 2 points. */
  change: number | null;
  direction: TrendDirection;
  /** Observation with the smallest value (earliest on ties), or null when empty. */
  min: TrendPoint | null;
  /** Observation with the largest value (earliest on ties), or null when empty. */
  max: TrendPoint | null;
  /** Milliseconds between first and last, or null when the series has fewer than 2 points. */
  spanMs: number | null;
  /** `change` per 24h day, or null when it cannot be derived (no span). */
  velocityPerDay: number | null;
}

/** A series plus its derived statistics. */
export interface TrendSummary extends TrendStats {
  metricType: TrendMetricType;
  series: TrendSeries;
}

/**
 * Append-only row shape, matching the existing `trend_history` schema
 * (migration 20260817000007). One row per metric type per snapshot.
 */
export interface TrendObservationRow {
  product_id: string;
  product_source_id: string | null;
  source_id: string | null;
  metric_type: TrendMetricType;
  value: number;
  unit: string | null;
  captured_at: string;
  metadata: Record<string, unknown>;
}

/**
 * A persisted trend_history row as read back from the database: the
 * append-only fields plus the storage-generated `id` / `created_at`.
 */
export interface TrendObservationRecord extends TrendObservationRow {
  id: string;
  created_at: string;
}

/** The set of append-only observation rows produced from one product snapshot. */
export interface ProductTrendSnapshot {
  productId: string;
  capturedAt: string;
  observations: TrendObservationRow[];
}
