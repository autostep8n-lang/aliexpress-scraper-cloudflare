/**
 * Scoring domain types. The engine is source-agnostic and deterministic: a
 * score is a weighted, bounded aggregation of independently evaluated signals,
 * and a signal that has no data is excluded rather than crashing or dragging
 * the score down.
 */
export interface ScoreSignalEvaluation {
  /** Whether the input contained enough data to evaluate this signal. */
  present: boolean;
  /** Raw signal contribution, normalized to [0, 1] by the engine. */
  value: number;
  /** Optional human-readable explanation of the observed value. */
  detail?: string;
}

export interface ScoreSignalDefinition<Input> {
  /** Stable identifier used in breakdowns and persisted inputs. */
  key: string;
  /** Human-readable name for explanations. */
  label: string;
  /** Relative importance. The engine renormalizes over present signals. */
  weight: number;
  evaluate(input: Input): ScoreSignalEvaluation;
}

/** One evaluated signal, as returned in the score breakdown. */
export interface ScoreSignal {
  key: string;
  label: string;
  weight: number;
  /** Normalized [0, 1] contribution (0 when the signal is not present). */
  value: number;
  present: boolean;
  /** Raw pre-normalization weighted contribution: `value * weight`. */
  contribution: number;
  detail?: string;
}

export interface ScoreResult {
  /** Discriminates score families, e.g. "product_quality". */
  scoreType: string;
  /** Scoring algorithm version, bumped when weights/definitions change. */
  version: number;
  /** Final bounded score in [minValue, maxValue] (default 0-100). */
  value: number;
  minValue: number;
  maxValue: number;
  /** Continuous normalized score in [0, 1]. */
  normalized: number;
  /** Sum of weights of the signals that were present. */
  totalWeight: number;
  /** Per-signal breakdown explaining how the score was derived. */
  signals: ScoreSignal[];
  /** Serializable breakdown suitable for the `scores.inputs` column. */
  inputs: Record<string, unknown>;
}

export interface ComputeScoreOptions {
  scoreType?: string;
  version?: number;
  minValue?: number;
  maxValue?: number;
  /** Decimal places for the final score; defaults to 0 (integer). */
  rounding?: number;
}
