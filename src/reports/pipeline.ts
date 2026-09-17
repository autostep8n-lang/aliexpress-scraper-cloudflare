import type { ScheduledAutomationResult } from "../discovery/scheduled";
import type { Env } from "../env";
import { logError, logInfo } from "../logging";
import {
  getReportById,
  listReports,
  upsertReports,
  type PersistedReportRecord,
  type ReportRow,
} from "../supabase/repository";
import { buildDailyDigest } from "./digest";
import type { ReportCandidate } from "./types";

export type AutomatedReportsStatus = "ok" | "skipped" | "error";

export interface AutomatedReportsSummary {
  status: AutomatedReportsStatus;
  reportType: string;
  dedupKey: string;
  persisted: number;
  durationMs: number;
  code?: string;
  message?: string;
}

export interface AutomatedReportsOptions {
  /** Clock seam for deterministic tests; defaults to the wall clock. */
  now?: () => string;
}

/**
 * Report persistence pipeline (P7.32).
 *
 * Builds the `daily_digest` from an already-completed
 * `ScheduledAutomationResult` and upserts it keyed on
 * `(report_type, dedup_key)`. Every run within the same UTC day refreshes the
 * same row, so the digest is idempotent and never appends duplicates.
 *
 * This runs strictly after discovery, scoring and alerts have finished. It can
 * never change their outcome: the function never throws, returns a typed
 * summary for every failure path, and its result is not fed back into the
 * automation result.
 */
export async function runAutomatedReports(
  env: Env,
  automation: ScheduledAutomationResult,
  options: AutomatedReportsOptions = {},
): Promise<AutomatedReportsSummary> {
  const startedAt = Date.now();
  const now = options.now ?? (() => new Date().toISOString());

  let candidate: ReportCandidate;
  try {
    candidate = buildDailyDigest(automation, now());
  } catch (err) {
    return finish("error", "daily_digest", "", 0, startedAt, {
      code: "DIGEST_BUILD_FAILED",
      message: toString(err),
    });
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return finish("skipped", candidate.reportType, candidate.dedupKey, 0, startedAt, {
      code: "SUPABASE_NOT_CONFIGURED",
      message: "Supabase is not configured",
    });
  }

  const write = await upsertReports(env, [toReportRow(candidate)]);
  if (write.status === "created" || write.status === "updated") {
    return finish("ok", candidate.reportType, candidate.dedupKey, write.data.length, startedAt);
  }
  if (write.status === "credentials_missing") {
    return finish("skipped", candidate.reportType, candidate.dedupKey, 0, startedAt, {
      code: "SUPABASE_NOT_CONFIGURED",
      message: "Supabase is not configured",
    });
  }
  if (write.status === "invalid") {
    return finish("error", candidate.reportType, candidate.dedupKey, 0, startedAt, {
      code: "INVALID_REPORT_ROW",
      message: write.message,
    });
  }
  if (write.status === "error") {
    return finish("error", candidate.reportType, candidate.dedupKey, 0, startedAt, {
      code: write.code ?? "REPORT_PERSIST_FAILED",
      message: write.message,
    });
  }
  return finish("error", candidate.reportType, candidate.dedupKey, 0, startedAt, {
    code: "REPORT_PERSIST_FAILED",
    message: "Unexpected repository outcome",
  });
}

/** Read-only page of reports for `GET /api/reports` (most recent first). */
export async function loadReportsPage(
  env: Env,
  filter: { limit: number; offset: number; reportType?: string },
): Promise<
  | {
      status: "ok";
      data: { reports: PersistedReportRecord[]; page: { limit: number; offset: number; count: number } };
    }
  | { status: "credentials_missing" }
  | { status: "error"; message: string; code?: string }
> {
  const result = await listReports(env, filter);
  if (result.status === "credentials_missing") {
    return { status: "credentials_missing" };
  }
  if (result.status !== "found") {
    if (result.status === "error") {
      return { status: "error", message: result.message, code: result.code };
    }
    return { status: "error", message: "Unexpected repository outcome", code: "report_list_failed" };
  }
  return {
    status: "ok",
    data: { reports: result.data, page: { limit: filter.limit, offset: filter.offset, count: result.data.length } },
  };
}

/** Read-only single report for `GET /api/reports/:id`. Never writes. */
export async function loadReportById(
  env: Env,
  reportId: string,
): Promise<
  | { status: "ok"; data: PersistedReportRecord }
  | { status: "not_found" }
  | { status: "credentials_missing" }
  | { status: "error"; message: string; code?: string }
> {
  const result = await getReportById(env, reportId);
  if (result.status === "found") {
    return { status: "ok", data: result.data };
  }
  if (result.status === "not_found") {
    return { status: "not_found" };
  }
  if (result.status === "credentials_missing") {
    return { status: "credentials_missing" };
  }
  if (result.status === "error") {
    return { status: "error", message: result.message, code: result.code };
  }
  return { status: "error", message: "Unexpected repository outcome", code: "report_lookup_failed" };
}

function toReportRow(candidate: ReportCandidate): ReportRow {
  return {
    report_type: candidate.reportType,
    dedup_key: candidate.dedupKey,
    title: candidate.title,
    summary: candidate.summary,
    period_start: candidate.periodStart,
    period_end: candidate.periodEnd,
    payload: candidate.payload,
    generated_at: candidate.generatedAt,
  };
}

function finish(
  status: AutomatedReportsStatus,
  reportType: string,
  dedupKey: string,
  persisted: number,
  startedAt: number,
  extra: { code?: string; message?: string } = {},
): AutomatedReportsSummary {
  const summary: AutomatedReportsSummary = {
    status,
    reportType,
    dedupKey,
    persisted,
    durationMs: Date.now() - startedAt,
    ...extra,
  };
  const fields: Record<string, unknown> = {
    reportType: summary.reportType,
    dedupKey: summary.dedupKey,
    persisted: summary.persisted,
    durationMs: summary.durationMs,
  };
  if (summary.code) fields.code = summary.code;
  if (summary.message) fields.message = summary.message;
  if (status === "ok") {
    logInfo("scheduled.reports", fields);
  } else {
    logError("scheduled.reports", fields);
  }
  return summary;
}

function toString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
