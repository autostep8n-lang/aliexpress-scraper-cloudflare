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

export {
  buildYouTubeSignal,
  normalizeYouTubeQuery,
  parseYouTubeSearchResponse,
  parseYouTubeVideosResponse,
  publishedAfterFor,
  toYouTubeObservationRow,
} from "./youtube-engine";

export {
  buildSearchUrl as buildYouTubeSearchUrl,
  buildVideosUrl,
  getYouTubeProvider,
  isYouTubeHost,
  officialApiYouTubeProvider,
  youtubeModule,
} from "./youtube";

export {
  buildInstagramSignal,
  normalizeInstagramQuery,
  parseInstagramHashtagSearchResponse,
  parseInstagramMediaResponse,
  toInstagramHashtag,
  toInstagramObservationRow,
} from "./instagram-engine";

export {
  buildHashtagSearchUrl,
  buildRecentMediaUrl,
  buildTopMediaUrl,
  getInstagramProvider,
  instagramModule,
  isInstagramHost,
  officialApiInstagramProvider,
} from "./instagram";

export { findMarketIntelligence, marketRegistry, registerMarketIntelligence } from "./registry";

export {
  GOOGLE_TRENDS_PROPERTIES,
  GOOGLE_TRENDS_TIME_RANGES,
  INSTAGRAM_MEDIA_TYPES,
  MarketError,
  REDDIT_SORTS,
  REDDIT_TIME_FILTERS,
  YOUTUBE_ORDERS,
  YOUTUBE_PUBLISHED_WITHIN,
  type GoogleTrendsObservationRow,
  type GoogleTrendsPersistedRow,
  type GoogleTrendsProperty,
  type GoogleTrendsProvider,
  type GoogleTrendsQuery,
  type GoogleTrendsSignal,
  type InstagramHashtag,
  type InstagramMedia,
  type InstagramMediaCollection,
  type InstagramMediaType,
  type InstagramObservationRow,
  type InstagramPersistedRow,
  type InstagramProvider,
  type InstagramQuery,
  type InstagramSignal,
  type MarketCollectResult,
  type MarketIntelligenceModule,
  type NormalizedInstagramQuery,
  type NormalizedRedditQuery,
  type NormalizedTrendQuery,
  type NormalizedYouTubeQuery,
  type RedditObservationRow,
  type RedditPersistedRow,
  type RedditPost,
  type RedditProvider,
  type RedditQuery,
  type RedditSignal,
  type RedditSort,
  type RedditTimeFilter,
  type YouTubeObservationRow,
  type YouTubeOrder,
  type YouTubePersistedRow,
  type YouTubePublishedWithin,
  type YouTubeProvider,
  type YouTubeQuery,
  type YouTubeSearchResult,
  type YouTubeSignal,
  type YouTubeVideo,
  type YouTubeVideoMeta,
  type YouTubeVideoStatistics,
} from "./types";
