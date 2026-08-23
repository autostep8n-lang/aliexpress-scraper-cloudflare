/**
 * Trend History Engine - public entry point.
 *
 * Pure, source-agnostic, deterministic computation over product trend
 * observations: build append-only `trend_history` rows from `Product`
 * snapshots, sort and summarize time series, and derive velocity/direction.
 * No I/O, no platform logic, no wall-clock time.
 */

export {
  buildObservations,
  computeStats,
  extractProductMetrics,
  isTrendMetricType,
  normalizeTimestamp,
  sortPoints,
  summarizeMetric,
  summarizeSeries,
  toFiniteNumber,
} from "./engine";
export type { BuildObservationsOptions } from "./engine";

export { snapshotProduct, trendsFromObservations } from "./snapshots";
export type { SnapshotProductOptions, TrendsResult } from "./snapshots";

export {
  TREND_METRIC_TYPES,
  type ProductMetrics,
  type ProductTrendSnapshot,
  type TrendDirection,
  type TrendMetricType,
  type TrendObservationRecord,
  type TrendObservationRow,
  type TrendPoint,
  type TrendSeries,
  type TrendStats,
  type TrendSummary,
} from "./types";
