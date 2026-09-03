/**
 * AI Product Analyst - public entry point (P5.25).
 *
 * Deterministic template explainer only. No HTTP, persistence, LLM, or
 * score recomputation. P6 owns UI rendering.
 */

export { buildAnalystEvidence, explainDecision } from "./engine";

export type {
  AnalystCountryEvidence,
  AnalystEvidence,
  AnalystMarketEvidence,
  AnalystProvider,
  AnalystResult,
  AnalystScoreEcho,
  AnalystSignalEvidence,
} from "./types";
