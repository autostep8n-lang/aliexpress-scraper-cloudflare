import type { Env } from "../env";
import { findMarketIntelligence } from "../market/registry";
import { MarketError, type RedditSignal } from "../market/types";
import { jsonError, jsonOk } from "../utils/http";

/**
 * GET /api/market/reddit: collect Reddit market intelligence for a keyword and
 * persist the aggregate signal.
 *
 * Query params:
 * - `q` (required)          keyword to search Reddit for
 * - `limit` (optional)      max number of posts to aggregate (1..100);
 *                           default 25
 * - `sort` (optional)       relevance|hot|top|new|comments; default "relevance"
 * - `timeFilter` (optional) hour|day|week|month|year|all; default "all"
 *
 * Outcomes map to:
 * - 200 `{ status: "ok", source, provider, keyword, sort, timeFilter, limit,
 *   capturedAt, requested, persisted, created, updated, failed, signals }`
 * - 400 `MISSING_KEYWORD` or a validation code (`INVALID_KEYWORD`,
 *   `INVALID_LIMIT`, `INVALID_SORT`, `INVALID_TIME_FILTER`)
 * - 501 `NO_MARKET_SOURCE` when no market-intelligence module is registered
 * - 502 with the provider's typed code (`REDDIT_NOT_CONFIGURED`, `AUTH_ERROR`,
 *   `RATE_LIMITED`, `TIMEOUT`, `HTTP_ERROR`, `INVALID_PAYLOAD`, ...)
 * - 503 `SUPABASE_NOT_CONFIGURED` when Supabase bindings are missing
 */
const VALIDATION_CODES = new Set(["INVALID_KEYWORD", "INVALID_LIMIT", "INVALID_SORT", "INVALID_TIME_FILTER"]);

export async function handleReddit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const keyword = params.get("q")?.trim() || undefined;
  if (!keyword) {
    return jsonError(400, "Missing required 'q' parameter", "MISSING_KEYWORD", requestId);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return jsonError(503, "Supabase is not configured", "SUPABASE_NOT_CONFIGURED", requestId);
  }

  const module = findMarketIntelligence("reddit");
  if (!module) {
    return jsonError(501, "No market intelligence module registered for reddit", "NO_MARKET_SOURCE", requestId);
  }

  const query = {
    keyword,
    limit: params.get("limit")?.trim() || undefined,
    sort: params.get("sort")?.trim() || undefined,
    timeFilter: params.get("timeFilter")?.trim() || undefined,
  };

  let result;
  try {
    result = await module.collect(query, env, ctx);
  } catch (err) {
    if (err instanceof MarketError) {
      return jsonError(VALIDATION_CODES.has(err.code) ? 400 : 502, err.message, err.code, requestId);
    }
    throw err;
  }

  const firstSignal = (result.signals[0] ?? null) as RedditSignal | null;

  return jsonOk({
    status: "ok",
    source: result.source,
    provider: result.provider,
    keyword: result.keyword,
    sort: firstSignal?.sort ?? "relevance",
    timeFilter: result.timeRange,
    limit: firstSignal?.limit ?? null,
    capturedAt: result.capturedAt,
    requested: result.requested,
    persisted: result.persisted,
    created: result.created,
    updated: result.updated,
    failed: result.failed,
    signals: result.signals,
  });
}
