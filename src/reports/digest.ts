import type { AutomatedAlertsSummary } from "../alerts/pipeline";
import type { DailyDiscoveryRunResult, ScheduledAutomationResult } from "../discovery/scheduled";
import type { AutomatedScoringSummary } from "../scoring/pipeline";
import type { DigestStatus, ReportCandidate } from "./types";

const DAY_MS = 86_400_000;

/** The UTC calendar day (`YYYY-MM-DD`) that contains `iso`. */
export function utcDayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Half-open UTC bounds `[start, end)` covering the day that contains `iso`. */
export function utcDayBounds(iso: string): { start: string; end: string } {
  const start = `${utcDayKey(iso)}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + DAY_MS).toISOString();
  return { start, end };
}

/**
 * Overall digest status derived from the completed automation result.
 *
 * A skipped discovery means nothing ran. Otherwise a hard failure anywhere is
 * an `error`, and a missing downstream result (discovery ok but scoring or
 * alerts never produced a summary) downgrades the day to `partial` rather than
 * pretending it was a clean run.
 */
export function digestStatus(automation: ScheduledAutomationResult): DigestStatus {
  const { discovery, scoring, alerts } = automation;
  if (discovery.status === "skipped") return "skipped";
  if (discovery.status === "error") return "error";
  const downstream = [scoring, alerts].filter((summary): summary is NonNullable<typeof summary> => summary !== null);
  if (downstream.some((summary) => summary.status === "error")) return "error";
  if (scoring === null || alerts === null || downstream.some((summary) => summary.status === "skipped")) {
    return "partial";
  }
  return "ok";
}

/** Stable, bounded per-step payload persisted as `reports.payload`. */
export function dailyDigestPayload(automation: ScheduledAutomationResult): Record<string, unknown> {
  return {
    status: digestStatus(automation),
    discovery: {
      status: automation.discovery.status,
      platform: automation.discovery.status === "ok" ? automation.discovery.platform : null,
      query: automation.discovery.query,
      limit: automation.discovery.limit,
      ...(automation.discovery.status === "ok"
        ? {
            discovered: automation.discovery.discovered,
            persisted: automation.discovery.persisted,
            created: automation.discovery.created,
            updated: automation.discovery.updated,
            failed: automation.discovery.failed,
          }
        : { code: automation.discovery.code }),
      durationMs: automation.discovery.durationMs,
    },
    scoring: automation.scoring === null ? null : digestScoring(automation.scoring),
    alerts: automation.alerts === null ? null : digestAlerts(automation.alerts),
  };
}

/**
 * Builds the daily digest candidate from a completed automation result.
 *
 * Pure and deterministic: the UTC day is read from `generatedAt`, so the same
 * day always yields the same `dedupKey` and the same row is upserted on repeat
 * runs.
 */
export function buildDailyDigest(automation: ScheduledAutomationResult, generatedAt: string): ReportCandidate {
  const day = utcDayKey(generatedAt);
  const bounds = utcDayBounds(generatedAt);
  return {
    reportType: "daily_digest",
    dedupKey: day,
    title: `Daily digest for ${day}`,
    summary: dailyDigestSummary(automation),
    periodStart: bounds.start,
    periodEnd: bounds.end,
    payload: dailyDigestPayload(automation),
    generatedAt,
  };
}

/** One-line human-readable summary covering every step, including failures. */
export function dailyDigestSummary(automation: ScheduledAutomationResult): string {
  return [
    describeDiscovery(automation.discovery),
    describeScoring(automation.scoring),
    describeAlerts(automation.alerts),
  ].join("; ");
}

function describeDiscovery(discovery: DailyDiscoveryRunResult): string {
  if (discovery.status === "ok") {
    return `discovery ok: ${discovery.discovered} discovered, ${discovery.persisted} persisted`;
  }
  return `discovery ${discovery.status} (${discovery.code})`;
}

function describeScoring(scoring: AutomatedScoringSummary | null): string {
  if (scoring === null) return "scoring not run";
  if (scoring.status === "ok") {
    return `scoring ok: ${scoring.scored} scored, ${scoring.skipped} skipped`;
  }
  return `scoring ${scoring.status}${scoring.code ? ` (${scoring.code})` : ""}`;
}

function describeAlerts(alerts: AutomatedAlertsSummary | null): string {
  if (alerts === null) return "alerts not run";
  if (alerts.status === "ok") {
    return `alerts ok: ${alerts.created} created, ${alerts.resolved} resolved`;
  }
  return `alerts ${alerts.status}${alerts.code ? ` (${alerts.code})` : ""}`;
}

function digestScoring(scoring: AutomatedScoringSummary): Record<string, unknown> {
  return {
    status: scoring.status,
    total: scoring.total,
    scored: scoring.scored,
    skipped: scoring.skipped,
    failed: scoring.failed,
    persisted: scoring.persisted,
    durationMs: scoring.durationMs,
    ...(scoring.code ? { code: scoring.code } : {}),
  };
}

function digestAlerts(alerts: AutomatedAlertsSummary): Record<string, unknown> {
  return {
    status: alerts.status,
    total: alerts.total,
    evaluated: alerts.evaluated,
    created: alerts.created,
    resolved: alerts.resolved,
    unchanged: alerts.unchanged,
    failed: alerts.failed,
    durationMs: alerts.durationMs,
    ...(alerts.code ? { code: alerts.code } : {}),
  };
}
