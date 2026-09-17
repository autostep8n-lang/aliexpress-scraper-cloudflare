/**
 * Reports domain types (P7.32).
 *
 * A report is a deterministic, deduplicated snapshot derived from work that has
 * already happened. The daily digest is built from a completed
 * `ScheduledAutomationResult`; the report layer never triggers discovery,
 * scoring or alerts, and never recomputes their results.
 */

/** v1 report families. Deliberately small; only the daily digest ships here. */
export const REPORT_TYPES = ["daily_digest"] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

/**
 * Per-day overall digest status.
 *
 * - `ok`: discovery, scoring and alerts all completed
 * - `partial`: discovery completed but a downstream step did not produce a
 *   result (for example scoring hard-failed, so alerts never ran)
 * - `error`: a step reported a hard failure
 * - `skipped`: the run never started (Supabase unconfigured or blocked)
 */
export const DIGEST_STATUSES = ["ok", "partial", "error", "skipped"] as const;

export type DigestStatus = (typeof DIGEST_STATUSES)[number];

/** `true` when `value` is a known report family. */
export function isReportType(value: string): value is ReportType {
  return (REPORT_TYPES as readonly string[]).includes(value);
}

/** Deterministic report candidate produced by the pure digest builder. */
export interface ReportCandidate {
  reportType: ReportType;
  /** Stable per-period key; the UTC calendar day (`YYYY-MM-DD`) for digests. */
  dedupKey: string;
  title: string;
  /** Human-readable one-line summary persisted as `reports.summary`. */
  summary: string;
  periodStart: string;
  periodEnd: string;
  /** Structured per-step breakdown persisted as `reports.payload`. */
  payload: Record<string, unknown>;
  generatedAt: string;
}
