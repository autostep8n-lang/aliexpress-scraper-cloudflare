import type { Env } from "../env";
import { logError, logInfo } from "../logging";
import { runAutomatedAlerts, type AutomatedAlertsSummary } from "../alerts/pipeline";
import { ScraperError } from "../scrapers/types";
import { runAutomatedScoring, type AutomatedScoringSummary } from "../scoring/pipeline";
import { findDiscovery } from "./registry";
import type { DiscoveryResult } from "./types";

export const DAILY_DISCOVERY_QUERY = "earbuds";
export const DAILY_DISCOVERY_LIMIT = 20;
export const DAILY_DISCOVERY_PLATFORM = "tiktok-shop" as const;

export interface ScheduledDiscoveryContext {
  cron: string;
  scheduledTime: number;
}

export type DailyDiscoveryRunResult =
  | {
      status: "ok";
      platform: string;
      query: string;
      region: null;
      limit: number;
      discovered: number;
      persisted: number;
      created: number;
      updated: number;
      failed: number;
      durationMs: number;
    }
  | {
      status: "skipped" | "error";
      code: string;
      message: string;
      query: string;
      region: null;
      limit: number;
      durationMs: number;
    };

/**
 * Daily TikTok Shop discovery. Uses a fixed query and limit, omits region
 * (same as GET /api/discover), reuses the registered discovery module, and
 * persists only through existing product upsert. Repeat runs refresh by
 * (source, external_id). Does not touch jobs/job_runs.
 */
export async function runDailyDiscovery(
  env: Env,
  ctx: ExecutionContext,
  scheduled: ScheduledDiscoveryContext,
): Promise<DailyDiscoveryRunResult> {
  const startedAt = Date.now();
  const query = DAILY_DISCOVERY_QUERY;
  const limit = DAILY_DISCOVERY_LIMIT;
  const baseFields = {
    cron: scheduled.cron,
    scheduledTime: scheduled.scheduledTime,
    platform: DAILY_DISCOVERY_PLATFORM,
    query,
    limit,
  };

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    const result: DailyDiscoveryRunResult = {
      status: "skipped",
      code: "SUPABASE_NOT_CONFIGURED",
      message: "Supabase is not configured",
      query,
      region: null,
      limit,
      durationMs: Date.now() - startedAt,
    };
    logError("scheduled discovery skipped", { ...baseFields, code: result.code, durationMs: result.durationMs });
    return result;
  }

  const discovery = findDiscovery(DAILY_DISCOVERY_PLATFORM);
  if (!discovery) {
    const result: DailyDiscoveryRunResult = {
      status: "skipped",
      code: "NO_DISCOVERY",
      message: "No discovery module registered for tiktok-shop",
      query,
      region: null,
      limit,
      durationMs: Date.now() - startedAt,
    };
    logError("scheduled discovery skipped", { ...baseFields, code: result.code, durationMs: result.durationMs });
    return result;
  }

  let discovered: DiscoveryResult;
  try {
    discovered = await discovery.discover({ query, limit }, env, ctx);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (err instanceof ScraperError) {
      const result: DailyDiscoveryRunResult = {
        status: "error",
        code: err.code,
        message: err.message,
        query,
        region: null,
        limit,
        durationMs,
      };
      logError("scheduled discovery failed", {
        ...baseFields,
        code: err.code,
        message: err.message,
        durationMs,
      });
      return result;
    }
    const message = err instanceof Error ? err.message : String(err);
    logError("scheduled discovery failed", { ...baseFields, code: "INTERNAL_ERROR", message, durationMs });
    return {
      status: "error",
      code: "INTERNAL_ERROR",
      message,
      query,
      region: null,
      limit,
      durationMs,
    };
  }

  const durationMs = Date.now() - startedAt;
  const result: DailyDiscoveryRunResult = {
    status: "ok",
    platform: discovered.platform,
    query,
    region: null,
    limit,
    discovered: discovered.discovered,
    persisted: discovered.persisted,
    created: discovered.created,
    updated: discovered.updated,
    failed: discovered.failed,
    durationMs,
  };
  logInfo("scheduled.discovery", {
    cron: scheduled.cron,
    scheduledTime: scheduled.scheduledTime,
    platform: result.platform,
    query,
    limit,
    discovered: result.discovered,
    persisted: result.persisted,
    created: result.created,
    updated: result.updated,
    failed: result.failed,
    durationMs,
  });
  return result;
}

/** Combined scheduled outcome: discovery, then scoring, then alerts on success. */
export interface ScheduledAutomationResult {
  discovery: DailyDiscoveryRunResult;
  scoring: AutomatedScoringSummary | null;
  alerts: AutomatedAlertsSummary | null;
}

/**
 * Scheduled automation (P7.29 + P7.30 + P7.31): run daily discovery first,
 * score the persisted products, then evaluate alerts from the persisted scores
 * and lifecycle state.
 *
 * Each step is gated on the previous one succeeding: a failed discovery is
 * never scored or alerted against, a failed scoring run is never alerted
 * against, and an alert failure never invalidates a discovery/scoring run that
 * already succeeded.
 */
export async function runScheduledAutomation(
  env: Env,
  ctx: ExecutionContext,
  scheduled: ScheduledDiscoveryContext,
): Promise<ScheduledAutomationResult> {
  const discovery = await runDailyDiscovery(env, ctx, scheduled);
  if (discovery.status !== "ok") {
    return { discovery, scoring: null, alerts: null };
  }
  const scoring = await runAutomatedScoring(env);
  if (scoring.status !== "ok") {
    return { discovery, scoring, alerts: null };
  }
  const alerts = await runAutomatedAlerts(env);
  return { discovery, scoring, alerts };
}
