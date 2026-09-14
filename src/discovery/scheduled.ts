import type { Env } from "../env";
import { logError, logInfo } from "../logging";
import { ScraperError } from "../scrapers/types";
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
