/**
 * Country Intelligence / Country Opportunity - public entry point (P4.22 / P4.23).
 *
 * Pure engines plus the SA ingest glue in `pipeline.ts`. Persistence lives in
 * the Supabase repository; Google Trends collection remains P3.1.
 */

export {
  analyzeCountryIntelligence,
  COUNTRY_OPPORTUNITY_SCORE_TYPE,
  COUNTRY_OPPORTUNITY_SIGNALS,
  COUNTRY_OPPORTUNITY_VERSION,
  isV1Country,
  normalizeCountry,
  normalizeKeyword,
  normalizeProductId,
  scoreCountryOpportunity,
  toCountryOpportunityRow,
} from "./engine";
export { MVP_COUNTRY, scoreAndPersistMvpCountryOpportunity } from "./pipeline";
export { CountryError, V1_COUNTRIES } from "./types";

export type { CountryOpportunityPipelineResult, CountryOpportunityPipelineStatus } from "./pipeline";

export type {
  CountryIntelligenceInput,
  CountryIntelligenceQuery,
  CountryIntelligenceResult,
  CountryOpportunityInput,
  CountryOpportunityObservationRow,
  CountryOpportunityPersistedRow,
  CountryOpportunityResult,
  CountryTrendDirection,
  V1Country,
} from "./types";
