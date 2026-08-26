import type { Env } from "../env";

/**
 * Market Intelligence - domain types (P3.1).
 *
 * External market-demand/search-trend signals (Google Trends) captured as
 * keyword/geo-scoped observations. This is intentionally SEPARATE from the
 * P1.4 Trend History Engine (`src/trends/`), which tracks INTERNAL product
 * observations over time in `trend_history`. Google Trends is external
 * market intelligence and persists to its own `google_trends` table.
 *
 * The acquisition mechanism is abstracted behind `GoogleTrendsProvider` so the
 * data source (the Cloudflare-native undocumented internal API today, or an
 * official API / approved provider later) can change without touching the
 * domain model, persistence, or the API.
 */

/** Search property Google Trends can filter on. Empty string means web search. */
export type GoogleTrendsProperty = "web" | "images" | "news" | "youtube" | "froogle";

export const GOOGLE_TRENDS_PROPERTIES: readonly GoogleTrendsProperty[] = [
  "web",
  "images",
  "news",
  "youtube",
  "froogle",
];

/**
 * Canonical relative-time tokens accepted by Google Trends. `all` and custom
 * `YYYY-MM-DD YYYY-MM-DD` ranges are also valid.
 */
export const GOOGLE_TRENDS_TIME_RANGES: readonly string[] = [
  "all",
  "today 5-y",
  "today 12-m",
  "today 3-m",
  "today 1-m",
  "now 7-d",
  "now 1-d",
  "now 4-h",
  "now 1-h",
];

/** Raw, untrusted query input. Every field is `unknown` until normalized. */
export interface GoogleTrendsQuery {
  keyword?: unknown;
  geo?: unknown;
  timeRange?: unknown;
  category?: unknown;
  property?: unknown;
}

/** Validated and normalized query. `geo` is "WORLD" for worldwide. */
export interface NormalizedTrendQuery {
  keyword: string;
  geo: string;
  timeRange: string;
  category: number | null;
  property: GoogleTrendsProperty;
}

/**
 * One Google Trends observation: the relative-interest value of a keyword for
 * one time bucket in one region. `value` is the Google Trends relative
 * interest index, clamped to 0..100 (100 = peak interest in the period).
 */
export interface GoogleTrendsSignal {
  keyword: string;
  geo: string;
  property: GoogleTrendsProperty;
  category: number | null;
  timeRange: string;
  periodStart: string;
  periodEnd: string;
  value: number;
  capturedAt: string;
}

/**
 * Append-only row shape, matching the `google_trends` schema (migration
 * 20260817000011). `source_id` is resolved and filled by the repository.
 */
export interface GoogleTrendsObservationRow {
  source_id: string | null;
  keyword: string;
  geo: string;
  property: GoogleTrendsProperty;
  category: number | null;
  time_range: string;
  period_start: string;
  period_end: string;
  value: number;
  captured_at: string;
  metadata: Record<string, unknown>;
}

/**
 * A persisted `google_trends` row as read back from the database: the
 * observation fields plus storage-generated columns.
 */
export interface GoogleTrendsPersistedRow {
  id: string;
  source_id: string;
  keyword: string;
  geo: string;
  property: GoogleTrendsProperty;
  category: number | null;
  time_range: string;
  period_start: string;
  period_end: string;
  value: number;
  captured_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Provider abstraction for acquiring Google Trends data. Implementations turn
 * a normalized query into normalized signals regardless of the underlying
 * acquisition mechanism (internal API today, official API or approved SaaS
 * later). Selected via the optional `GOOGLE_TRENDS_PROVIDER` env var.
 */
export interface GoogleTrendsProvider {
  readonly name: string;
  fetchSignals(query: NormalizedTrendQuery, env: Env, ctx: ExecutionContext): Promise<GoogleTrendsSignal[]>;
}

/** Contract every market-intelligence source module must implement (P3.x). */
export interface MarketIntelligenceModule {
  readonly source: string;
  collect(query: GoogleTrendsQuery, env: Env, ctx: ExecutionContext): Promise<MarketCollectResult>;
}

/** Typed outcome of collecting and persisting one market-intelligence query. */
export interface MarketCollectResult {
  source: string;
  provider: string;
  keyword: string;
  geo: string;
  timeRange: string;
  property: GoogleTrendsProperty;
  category: number | null;
  capturedAt: string;
  /** Number of signals acquired from the provider. */
  requested: number;
  /** Number of signals persisted. */
  persisted: number;
  created: number;
  updated: number;
  failed: number;
  signals: GoogleTrendsSignal[];
}

/**
 * Typed market-intelligence error. Carries a stable machine-readable `code`
 * so API handlers can branch without parsing message text, mirroring
 * `ScraperError` in `src/scrapers/types.ts`.
 */
export class MarketError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MarketError";
  }
}
