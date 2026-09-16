/**
 * Alerts - public entry point (P7.31).
 *
 * Pure deterministic engine plus the bounded pipeline that persists the feed.
 */

export {
  alertRowKey,
  candidateKey,
  COUNTRY_OPPORTUNITY_SCORE_TYPE,
  evaluateAlerts,
  evaluateCountryOpportunity,
  evaluateLifecycle,
  evaluateMarketOpportunity,
  isAlertType,
  MARKET_OPPORTUNITY_SCORE_TYPE,
} from "./engine";

export {
  ALERT_BATCH_SIZE,
  ALERT_MAX_PRODUCTS,
  countryOpportunityEvidence,
  latestMarketOpportunities,
  lifecycleEvidence,
  loadAlertsPage,
  runAutomatedAlerts,
} from "./pipeline";

export type { AutomatedAlertsOptions, AutomatedAlertsStatus, AutomatedAlertsSummary } from "./pipeline";

export {
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  ALERT_TYPES,
  HIGH_MARKET_OPPORTUNITY_THRESHOLD,
} from "./types";

export type {
  AlertCandidate,
  AlertEngineInput,
  AlertSeverity,
  AlertStatus,
  AlertType,
  CountryOpportunityAlertEvidence,
  LifecycleAlertEvidence,
  MarketOpportunityAlertEvidence,
} from "./types";
