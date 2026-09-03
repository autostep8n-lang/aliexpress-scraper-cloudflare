/**
 * Decision Opportunity Engine - public entry point (P5.24).
 *
 * Pure engine only: no HTTP, no persistence, no wall-clock time. Aggregates
 * existing P1.10 and P4.23 scores; collection remains P3 and scoring of those
 * inputs remains P1.10 / P4.23.
 */

export {
  DECISION_OPPORTUNITY_SCORE_TYPE,
  DECISION_OPPORTUNITY_SIGNALS,
  DECISION_OPPORTUNITY_VERSION,
  scoreDecisionOpportunity,
} from "./engine";
export { DecisionError } from "./types";

export type { DecisionOpportunityInput, DecisionOpportunityResult } from "./types";
