/**
 * Market Intelligence - Google Trends deterministic engine (P3.1).
 *
 * Pure, source-agnostic, deterministic computation: query normalization,
 * timeline payload parsing, row mapping and light series summarization. No
 * I/O, no wall-clock time, no provider/network logic. Identical inputs always
 * produce identical outputs; malformed external data is skipped or rejected
 * with a stable `MarketError` code rather than throwing unexpectedly.
 */

import {
  GOOGLE_TRENDS_PROPERTIES,
  GOOGLE_TRENDS_TIME_RANGES,
  MarketError,
  type GoogleTrendsObservationRow,
  type GoogleTrendsProperty,
  type GoogleTrendsQuery,
  type GoogleTrendsSignal,
  type NormalizedTrendQuery,
} from "./types";

const DEFAULT_TIME_RANGE = "today 5-y";
const DEFAULT_PROPERTY: GoogleTrendsProperty = "web";
const KEYWORD_MAX_LENGTH = 200;
const GEO_PATTERN = /^[A-Z]{2}(-[A-Z]{2,3})?$/;
const CUSTOM_TIME_RANGE_PATTERN = /^\d{4}-\d{2}-\d{2}\s\d{4}-\d{2}-\d{2}$/;

/** Default `periodEnd` span used when a series has fewer than two points. */
const RESOLUTION_MS: Record<string, number> = {
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
  MONTH: 30 * 24 * 60 * 60 * 1000,
  YEAR: 365 * 24 * 60 * 60 * 1000,
};

/**
 * Validates and normalizes raw, untrusted query input into a
 * `NormalizedTrendQuery`. Throws `MarketError` with a stable code on invalid
 * input: `INVALID_KEYWORD`, `INVALID_GEO`, `INVALID_TIME_RANGE`,
 * `INVALID_PROPERTY`, `INVALID_CATEGORY`.
 */
export function normalizeQuery(query: GoogleTrendsQuery): NormalizedTrendQuery {
  const keyword = asString(query.keyword);
  if (!keyword) {
    throw new MarketError("INVALID_KEYWORD", "keyword is required and must be a non-empty string");
  }
  if (keyword.length > KEYWORD_MAX_LENGTH) {
    throw new MarketError("INVALID_KEYWORD", `keyword must be at most ${KEYWORD_MAX_LENGTH} characters`);
  }

  const geo = normalizeGeo(query.geo);
  const timeRange = normalizeTimeRange(query.timeRange);
  const property = normalizeProperty(query.property);
  const category = normalizeCategory(query.category);

  return { keyword, geo, timeRange, property, category };
}

/**
 * Parses the Google Trends `widgetdata/multiline` timeline payload into
 * normalized signals for the given query.
 *
 * Rules:
 * - `timelineData[].time` (epoch ms) -> ISO period start; unparseable dropped
 * - `timelineData[].value[0]` used; missing / non-finite skipped
 * - values clamped to 0..100
 * - duplicate `periodStart` deduplicated (last wins)
 * - deterministic ascending sort by `periodStart`
 * - `periodEnd` derived from the next bucket; the final bucket uses the last
 *   observed gap, falling back to the payload resolution span
 *
 * Structurally invalid payloads throw `INVALID_PAYLOAD`. A valid payload with
 * an empty timeline returns an empty array (a low-volume keyword is a valid
 * result, not an error).
 */
export function parseTimelinePayload(
  payload: unknown,
  query: NormalizedTrendQuery,
  capturedAt: string,
): GoogleTrendsSignal[] {
  const root = asRecord(payload);
  if (!root) {
    throw new MarketError("INVALID_PAYLOAD", "google trends payload must be an object");
  }
  const def = asRecord(root.default);
  if (!def) {
    throw new MarketError("INVALID_PAYLOAD", "google trends payload is missing 'default'");
  }
  const timelineData = def.timelineData;
  if (!Array.isArray(timelineData)) {
    throw new MarketError("INVALID_PAYLOAD", "google trends payload is missing 'default.timelineData'");
  }

  const points: Array<{ at: string; value: number }> = [];
  for (const entry of timelineData) {
    const record = asRecord(entry);
    if (!record) continue;
    const at = timestampToIso(record.time);
    if (at === null) continue;
    const value = firstFiniteNumber(record.value);
    if (value === undefined) continue;
    points.push({ at, value: clamp(value, 0, 100) });
  }

  const deduped = dedupeByPeriodStart(points);
  deduped.sort(compareByAt);
  const spanMs = resolutionMs(def.resolution);

  return deduped.map((point, index) => ({
    keyword: query.keyword,
    geo: query.geo,
    property: query.property,
    category: query.category,
    timeRange: query.timeRange,
    periodStart: point.at,
    periodEnd: derivePeriodEnd(deduped, index, spanMs),
    value: point.value,
    capturedAt,
  }));
}

/** Maps a normalized signal to its persistence row shape. */
export function toObservationRow(signal: GoogleTrendsSignal, sourceId: string | null): GoogleTrendsObservationRow {
  return {
    source_id: sourceId,
    keyword: signal.keyword,
    geo: signal.geo,
    property: signal.property,
    category: signal.category,
    time_range: signal.timeRange,
    period_start: signal.periodStart,
    period_end: signal.periodEnd,
    value: signal.value,
    captured_at: signal.capturedAt,
    metadata: {},
  };
}

/** Direction of change between the first and last signal of a series. */
export type MarketTrendDirection = "up" | "down" | "flat" | "unknown";

/** Light, deterministic summary of a Google Trends signal series. */
export interface GoogleTrendsSummary {
  count: number;
  first: GoogleTrendsSignal | null;
  last: GoogleTrendsSignal | null;
  change: number | null;
  direction: MarketTrendDirection;
  spanMs: number | null;
}

/**
 * Derives a summary for a series. Safe on empty / single-point series:
 * derived fields are null and direction is "unknown". Input order does not
 * affect the result.
 */
export function summarizeSignals(signals: GoogleTrendsSignal[]): GoogleTrendsSummary {
  const sorted = [...signals].sort(compareSignals);
  if (sorted.length === 0) {
    return { count: 0, first: null, last: null, change: null, direction: "unknown", spanMs: null };
  }
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (sorted.length === 1) {
    return { count: 1, first, last, change: null, direction: "unknown", spanMs: null };
  }
  const change = last.value - first.value;
  const spanMs = Date.parse(last.periodStart) - Date.parse(first.periodStart);
  const direction: MarketTrendDirection = change > 0 ? "up" : change < 0 ? "down" : "flat";
  return {
    count: sorted.length,
    first,
    last,
    change,
    direction,
    spanMs: Number.isFinite(spanMs) && spanMs >= 0 ? spanMs : null,
  };
}

function normalizeGeo(value: unknown): string {
  if (value === undefined || value === null) return "WORLD";
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return "WORLD";
  const upper = raw.toUpperCase();
  if (upper !== "WORLD" && !GEO_PATTERN.test(upper)) {
    throw new MarketError("INVALID_GEO", `invalid geo: ${raw}`);
  }
  return upper;
}

function normalizeTimeRange(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_TIME_RANGE;
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return DEFAULT_TIME_RANGE;
  if (GOOGLE_TRENDS_TIME_RANGES.includes(raw)) return raw;
  if (CUSTOM_TIME_RANGE_PATTERN.test(raw)) return raw;
  throw new MarketError("INVALID_TIME_RANGE", `invalid time range: ${raw}`);
}

function normalizeProperty(value: unknown): GoogleTrendsProperty {
  if (value === undefined || value === null) return DEFAULT_PROPERTY;
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "") return DEFAULT_PROPERTY;
  if ((GOOGLE_TRENDS_PROPERTIES as readonly string[]).includes(raw)) {
    return raw as GoogleTrendsProperty;
  }
  throw new MarketError("INVALID_PROPERTY", `invalid property: ${String(value)}`);
}

function normalizeCategory(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(num) || num < 0) {
    throw new MarketError("INVALID_CATEGORY", `invalid category: ${String(value)}`);
  }
  return num;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function timestampToIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return isoFromMs(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value.trim());
    if (Number.isFinite(num)) return isoFromMs(num);
  }
  return null;
}

function isoFromMs(ms: number): string | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstFiniteNumber(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (typeof entry === "string" && entry.trim() !== "") {
      const num = Number(entry.trim());
      if (Number.isFinite(num)) return num;
    }
  }
  return undefined;
}

function dedupeByPeriodStart(points: Array<{ at: string; value: number }>): Array<{ at: string; value: number }> {
  const byPeriod = new Map<string, { at: string; value: number }>();
  for (const point of points) {
    byPeriod.set(point.at, point);
  }
  return [...byPeriod.values()];
}

function compareByAt(a: { at: string; value: number }, b: { at: string; value: number }): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}

function compareSignals(a: GoogleTrendsSignal, b: GoogleTrendsSignal): number {
  return a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0;
}

function derivePeriodEnd(points: Array<{ at: string; value: number }>, index: number, fallbackSpanMs: number): string {
  if (index + 1 < points.length) {
    return points[index + 1].at;
  }
  const lastGap = lastGapMs(points);
  const span = lastGap ?? fallbackSpanMs;
  return isoFromMs(Date.parse(points[index].at) + span) ?? points[index].at;
}

function lastGapMs(points: Array<{ at: string; value: number }>): number | null {
  if (points.length < 2) return null;
  const a = Date.parse(points[points.length - 2].at);
  const b = Date.parse(points[points.length - 1].at);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  return b - a;
}

function resolutionMs(value: unknown): number {
  if (typeof value === "string") {
    const ms = RESOLUTION_MS[value.toUpperCase()];
    if (ms !== undefined) return ms;
  }
  return RESOLUTION_MS.MONTH;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
