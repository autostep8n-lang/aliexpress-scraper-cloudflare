import type { Env } from "../env";

/**
 * Market Intelligence - domain types (P3.1).
 *
 * External market-demand/search-trend signals (Google Trends, Reddit) captured
 * as keyword-scoped observations. This is intentionally SEPARATE from the
 * P1.4 Trend History Engine (`src/trends/`), which tracks INTERNAL product
 * observations over time in `trend_history`. Google Trends is external
 * market intelligence and persists to its own `google_trends` table; Reddit
 * persists to `reddit_signals`.
 *
 * Each source's acquisition mechanism is abstracted behind a provider
 * interface (e.g. `GoogleTrendsProvider`, `RedditProvider`) so the data source
 * can change without touching the domain model, persistence, or the API.
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

/**
 * Contract every market-intelligence source module must implement (P3.x).
 * Each source has its own query and signal types (e.g. Google Trends uses
 * `GoogleTrendsQuery`/`GoogleTrendsSignal`, Reddit uses
 * `RedditQuery`/`RedditSignal`).
 */
export interface MarketIntelligenceModule<Q = GoogleTrendsQuery, S = GoogleTrendsSignal> {
  readonly source: string;
  collect(query: Q, env: Env, ctx: ExecutionContext): Promise<MarketCollectResult<S>>;
}

/**
 * Typed outcome of collecting and persisting one market-intelligence query.
 * `property` is source-specific (e.g. Google Trends "web"/"images"/..., Reddit
 * "posts"), so it is a plain string.
 */
export interface MarketCollectResult<S = GoogleTrendsSignal> {
  source: string;
  provider: string;
  keyword: string;
  geo: string;
  timeRange: string;
  property: string;
  category: number | null;
  capturedAt: string;
  /** Number of signals acquired from the provider. */
  requested: number;
  /** Number of signals persisted. */
  persisted: number;
  created: number;
  updated: number;
  failed: number;
  signals: S[];
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

// ============================================================================
// P3.2 - Reddit market intelligence.
// ============================================================================

/** Reddit search sort options (mirrors the Reddit API `sort` parameter). */
export type RedditSort = "relevance" | "hot" | "top" | "new" | "comments";

export const REDDIT_SORTS: readonly RedditSort[] = ["relevance", "hot", "top", "new", "comments"];

/** Reddit search time window (mirrors the Reddit API `t` parameter). */
export type RedditTimeFilter = "hour" | "day" | "week" | "month" | "year" | "all";

export const REDDIT_TIME_FILTERS: readonly RedditTimeFilter[] = ["hour", "day", "week", "month", "year", "all"];

/** Raw, untrusted query input. Every field is `unknown` until normalized. */
export interface RedditQuery {
  keyword?: unknown;
  limit?: unknown;
  sort?: unknown;
  timeFilter?: unknown;
}

/** Validated and normalized Reddit query. */
export interface NormalizedRedditQuery {
  keyword: string;
  limit: number;
  sort: RedditSort;
  timeFilter: RedditTimeFilter;
}

/** One normalized post from a Reddit search result (evidence for a signal). */
export interface RedditPost {
  id: string;
  title: string;
  subreddit: string;
  score: number;
  numComments: number;
  author: string | null;
  permalink: string;
  createdAt: string;
}

/**
 * One Reddit signal: a keyword-level snapshot aggregated from the top search
 * results for a keyword in a time window. `mentions` is the number of matching
 * posts returned (bounded by `limit`); `totalScore`/`totalComments` sum their
 * engagement, `avgScore` is per-post average, and `topSubreddit` is the
 * subreddit with the most matching posts.
 */
export interface RedditSignal {
  keyword: string;
  limit: number;
  sort: RedditSort;
  timeFilter: RedditTimeFilter;
  mentions: number;
  totalScore: number;
  totalComments: number;
  avgScore: number | null;
  subredditCount: number;
  topSubreddit: string | null;
  topPosts: RedditPost[];
  capturedAt: string;
}

/**
 * Row shape matching the `reddit_signals` schema (migration
 * 20260817000012). `source_id` is resolved and filled by the repository.
 */
export interface RedditObservationRow {
  source_id: string | null;
  keyword: string;
  result_limit: number;
  sort: RedditSort;
  time_filter: RedditTimeFilter;
  mentions: number;
  total_score: number;
  total_comments: number;
  avg_score: number | null;
  subreddit_count: number;
  top_subreddit: string | null;
  captured_at: string;
  metadata: Record<string, unknown>;
}

/**
 * A persisted `reddit_signals` row as read back from the database: the
 * observation fields plus storage-generated columns.
 */
export interface RedditPersistedRow {
  id: string;
  source_id: string;
  keyword: string;
  result_limit: number;
  sort: RedditSort;
  time_filter: RedditTimeFilter;
  mentions: number;
  total_score: number;
  total_comments: number;
  avg_score: number | null;
  subreddit_count: number;
  top_subreddit: string | null;
  captured_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Provider abstraction for acquiring Reddit data. Implementations turn a
 * normalized query into normalized signals regardless of the underlying
 * acquisition mechanism (today the official OAuth2 app-only API).
 */
export interface RedditProvider {
  readonly name: string;
  fetchSignals(query: NormalizedRedditQuery, env: Env, ctx: ExecutionContext): Promise<RedditSignal[]>;
}

// ============================================================================
// P3.3 - YouTube market intelligence.
// ============================================================================

/**
 * YouTube search ordering (mirrors the YouTube Data API `order` parameter).
 * Only the orderings meaningful for a video search are exposed.
 */
export type YouTubeOrder = "relevance" | "date" | "rating" | "viewCount";

export const YOUTUBE_ORDERS: readonly YouTubeOrder[] = ["relevance", "date", "rating", "viewCount"];

/**
 * Relative recency window applied via the YouTube Data API `publishedAfter`
 * filter. `any` leaves the search window unrestricted.
 */
export type YouTubePublishedWithin = "any" | "hour" | "day" | "week" | "month" | "year";

export const YOUTUBE_PUBLISHED_WITHIN: readonly YouTubePublishedWithin[] = [
  "any",
  "hour",
  "day",
  "week",
  "month",
  "year",
];

/** Raw, untrusted query input. Every field is `unknown` until normalized. */
export interface YouTubeQuery {
  keyword?: unknown;
  limit?: unknown;
  order?: unknown;
  publishedWithin?: unknown;
}

/** Validated and normalized YouTube query. */
export interface NormalizedYouTubeQuery {
  keyword: string;
  limit: number;
  order: YouTubeOrder;
  publishedWithin: YouTubePublishedWithin;
}

/**
 * One video as reported by the YouTube search `snippet` part (no engagement
 * statistics yet; those come from a separate `videos.list` call).
 */
export interface YouTubeVideoMeta {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
}

/** Engagement counters for a video from the `videos.list` `statistics` part. */
export interface YouTubeVideoStatistics {
  viewCount: number;
  likeCount: number | null;
  commentCount: number | null;
}

/** A parsed YouTube search response: total matches plus the video metadata. */
export interface YouTubeSearchResult {
  videoCount: number;
  items: YouTubeVideoMeta[];
}

/** One normalized video from a YouTube search result (evidence for a signal). */
export interface YouTubeVideo {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  viewCount: number;
  likeCount: number | null;
  commentCount: number | null;
  url: string;
}

/**
 * One YouTube signal: a keyword-level snapshot aggregated from the top search
 * results for a keyword. `videoCount` is the API-reported total matching
 * videos (an approximation), `totalViews`/`totalLikes`/`totalComments` sum the
 * engagement of the fetched videos, and `topChannel` is the channel with the
 * most fetched videos.
 */
export interface YouTubeSignal {
  keyword: string;
  limit: number;
  order: YouTubeOrder;
  publishedWithin: YouTubePublishedWithin;
  videoCount: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  avgViews: number | null;
  channelCount: number;
  topChannel: string | null;
  videos: YouTubeVideo[];
  capturedAt: string;
}

/**
 * Row shape matching the `youtube_signals` schema (migration
 * 20260817000013). `source_id` is resolved and filled by the repository.
 */
export interface YouTubeObservationRow {
  source_id: string | null;
  keyword: string;
  result_limit: number;
  order_by: YouTubeOrder;
  published_within: YouTubePublishedWithin;
  video_count: number;
  total_views: number;
  total_likes: number;
  total_comments: number;
  avg_views: number | null;
  channel_count: number;
  top_video_id: string | null;
  top_video_title: string | null;
  top_channel: string | null;
  captured_at: string;
  metadata: Record<string, unknown>;
}

/**
 * A persisted `youtube_signals` row as read back from the database: the
 * observation fields plus storage-generated columns.
 */
export interface YouTubePersistedRow {
  id: string;
  source_id: string;
  keyword: string;
  result_limit: number;
  order_by: YouTubeOrder;
  published_within: YouTubePublishedWithin;
  video_count: number;
  total_views: number;
  total_likes: number;
  total_comments: number;
  avg_views: number | null;
  channel_count: number;
  top_video_id: string | null;
  top_video_title: string | null;
  top_channel: string | null;
  captured_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Provider abstraction for acquiring YouTube data. Implementations turn a
 * normalized query into normalized signals regardless of the underlying
 * acquisition mechanism (today the official YouTube Data API v3).
 */
export interface YouTubeProvider {
  readonly name: string;
  fetchSignals(query: NormalizedYouTubeQuery, env: Env, ctx: ExecutionContext): Promise<YouTubeSignal[]>;
}
