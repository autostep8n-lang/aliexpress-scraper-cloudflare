/**
 * Product Lifecycle Engine - public entry point.
 *
 * Deterministic, source-agnostic lifecycle classification for products using
 * persisted product state plus P1.4 trend summaries. Lifecycle states mirror
 * the `products.lifecycle_status` schema constraint; every evaluation returns
 * the recommended status, the applied rule (when it changes), and the evidence
 * behind the decision. No I/O, no platform logic, no wall-clock time.
 */

export { buildEvidence, canTransition, deriveLifecycleStatus, evaluateLifecycle, fromRecord } from "./engine";

export { LIFECYCLE_RULES } from "./rules";
export type { LifecycleRule, RuleContext } from "./rules";

export {
  DEFAULT_THRESHOLDS,
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  type AvailabilityStatus,
  type LifecycleDecision,
  type LifecycleEvidence,
  type LifecycleSourceRecord,
  type LifecycleStatus,
  type LifecycleThresholds,
  type LifecycleTransition,
  type LifecycleTransitionSpec,
  type ProductLifecycleInput,
} from "./types";
