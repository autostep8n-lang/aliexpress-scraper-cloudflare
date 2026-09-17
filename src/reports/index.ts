/**
 * Reports - public entry point (P7.32).
 *
 * Pure deterministic digest builder plus the pipeline that persists the daily
 * digest from a completed `ScheduledAutomationResult`.
 */

export {
  buildDailyDigest,
  dailyDigestPayload,
  dailyDigestSummary,
  digestStatus,
  utcDayBounds,
  utcDayKey,
} from "./digest";

export { loadReportById, loadReportsPage, runAutomatedReports } from "./pipeline";

export type { AutomatedReportsOptions, AutomatedReportsStatus, AutomatedReportsSummary } from "./pipeline";

export { DIGEST_STATUSES, REPORT_TYPES, isReportType } from "./types";

export type { DigestStatus, ReportCandidate, ReportType } from "./types";
