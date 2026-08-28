/**
 * Market Intelligence - public entry point.
 *
 * External market-demand/search-trend signals (Google Trends, Reddit), kept
 * separate from the P1.4 internal Trend History Engine (`src/trends/`). Pure
 * deterministic engines + provider-abstraction acquisition + persistence, plus
 * a registry for market-intelligence sources (P3.x).
 */

export {
  normalizeQuery,
  parseTimelinePayload,
  summarizeSignals,
  toObservationRow,
} from "./engine";
export type { GoogleTrendsSummary, MarketTrendDirection } from "./engine";

export {
  buildExploreRequest,
  getGoogleTrendsProvider,
  googleTrendsModule,
  internalApiTrendsProvider,
  isTrendsHost,
} from "./google-trends";

export {
  normalizeRedditQuery,
  parseRedditSearchResponse,
  toRedditObservationRow,
} from "./reddit-engine";

export {
  acquireAccessToken,
  buildSearchUrl,
  getRedditProvider,
  isRedditHost,
  officialApiRedditProvider,
  redditModule,
} from "./reddit";

export { findMarketIntelligence, marketRegistry, registerMarketIntelligence } from "./registry";

export {
  GOOGLE_TRENDS_PROPERTIES,
  GOOGLE_TRENDS_TIME_RANGES,
  MarketError,
  REDDIT_SORTS,
  REDDIT_TIME_FILTERS,
  type GoogleTrendsObservationRow,
  type GoogleTrendsPersistedRow,
  type GoogleTrendsProperty,
  type GoogleTrendsProvider,
  type GoogleTrendsQuery,
  type GoogleTrendsSignal,
  type MarketCollectResult,
  type MarketIntelligenceModule,
  type NormalizedRedditQuery,
  type NormalizedTrendQuery,
  type RedditObservationRow,
  type RedditPersistedRow,
  type RedditPost,
  type RedditProvider,
  type RedditQuery,
  type RedditSignal,
  type RedditSort,
  type RedditTimeFilter,
} from "./types";
