import type {
  ComputeScoreOptions,
  ScoreResult,
  ScoreSignal,
  ScoreSignalDefinition,
} from "./types";

export const DEFAULT_MIN_VALUE = 0;
export const DEFAULT_MAX_VALUE = 100;
export const DEFAULT_ROUNDING = 0;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Deterministic, source-agnostic scoring engine.
 *
 * Evaluates every signal definition against the input, normalizes each
 * contribution to [0, 1], and aggregates them as a weighted mean. Signals that
 * report `present: false` are excluded from both the numerator and the
 * denominator, so missing optional data never crashes scoring nor silently
 * inflates a product above/below its peers. The final score is bounded to
 * [minValue, maxValue] (default 0-100) and rounded to `rounding` decimals.
 */
export function computeScore<Input>(
  input: Input,
  definitions: readonly ScoreSignalDefinition<Input>[],
  options: ComputeScoreOptions = {},
): ScoreResult {
  const minValue = options.minValue ?? DEFAULT_MIN_VALUE;
  const maxValue = options.maxValue ?? DEFAULT_MAX_VALUE;
  const rounding = options.rounding ?? DEFAULT_ROUNDING;
  const scoreType = options.scoreType ?? "generic";
  const version = options.version ?? 1;

  const signals: ScoreSignal[] = definitions.map((definition) => {
    const evaluation = definition.evaluate(input);
    const value = clamp(evaluation.value, 0, 1);
    const signal: ScoreSignal = {
      key: definition.key,
      label: definition.label,
      weight: definition.weight,
      value: evaluation.present ? value : 0,
      present: evaluation.present,
      contribution: evaluation.present ? value * definition.weight : 0,
    };
    if (evaluation.detail) signal.detail = evaluation.detail;
    return signal;
  });

  const present = signals.filter((signal) => signal.present);
  const totalWeight = present.reduce((sum, signal) => sum + signal.weight, 0);
  const weightedTotal = present.reduce((sum, signal) => sum + signal.value * signal.weight, 0);
  const normalized = totalWeight > 0 ? weightedTotal / totalWeight : 0;
  const normalizedRounded = round(normalized, Math.max(rounding, 4));
  const value = round(minValue + normalized * (maxValue - minValue), rounding);

  return {
    scoreType,
    version,
    value,
    minValue,
    maxValue,
    normalized: normalizedRounded,
    totalWeight: round(totalWeight, 4),
    signals,
    inputs: buildInputs({ scoreType, version, normalized: normalizedRounded, signals }),
  };
}

function buildInputs(meta: {
  scoreType: string;
  version: number;
  normalized: number;
  signals: ScoreSignal[];
}): Record<string, unknown> {
  return {
    score_type: meta.scoreType,
    version: meta.version,
    normalized: meta.normalized,
    signals: meta.signals.map((signal) => ({
      key: signal.key,
      label: signal.label,
      weight: signal.weight,
      value: signal.value,
      present: signal.present,
      contribution: round(signal.contribution, 4),
      ...(signal.detail ? { detail: signal.detail } : {}),
    })),
  };
}
