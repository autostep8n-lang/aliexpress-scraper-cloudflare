export { computeScore, clamp, DEFAULT_MIN_VALUE, DEFAULT_MAX_VALUE, DEFAULT_ROUNDING } from "./engine";
export { scoreProductQuality, PRODUCT_QUALITY_SIGNALS } from "./quality";
export type {
  ComputeScoreOptions,
  ScoreResult,
  ScoreSignal,
  ScoreSignalDefinition,
  ScoreSignalEvaluation,
} from "./types";

import type { ScoreResult } from "./types";

/**
 * Maps a computed score to the shape of the `scores` table (see
 * supabase/migrations/20260817000007_metrics.sql). Pure and deterministic: it
 * never touches Supabase, it only produces the row that a caller may persist.
 */
export function toScoreRow(score: ScoreResult, refs: { productId?: string; productSourceId?: string | null } = {}): Record<string, unknown> {
  return {
    product_id: refs.productId ?? null,
    product_source_id: refs.productSourceId ?? null,
    score_type: score.scoreType,
    value: score.value,
    min_value: score.minValue,
    max_value: score.maxValue,
    version: score.version,
    inputs: score.inputs,
  };
}
