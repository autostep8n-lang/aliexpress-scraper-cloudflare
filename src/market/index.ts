/**
 * Market Intelligence - public entry point.
 *
 * External market-demand/search-trend signals (Google Trends), kept separate
 * from the P1.4 internal Trend History Engine (`src/trends/`). Pure
 * deterministic engine + provider-abstraction acquisition + persistence, plus
 * a registry for future market-intelligence sources (P3.x).
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

export { findMarketIntelligence, marketRegistry, registerMarketIntelligence } from "./registry";

export {
  GOOGLE_TRENDS_PROPERTIES,
  GOOGLE_TRENDS_TIME_RANGES,
  MarketError,
  type GoogleTrendsObservationRow,
  type GoogleTrendsPersistedRow,
  type GoogleTrendsProperty,
  type GoogleTrendsProvider,
  type GoogleTrendsQuery,
  type GoogleTrendsSignal,
  type MarketCollectResult,
  type MarketIntelligenceModule,
  type NormalizedTrendQuery,
} from "./types";
