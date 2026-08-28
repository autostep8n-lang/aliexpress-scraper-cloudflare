import type { Env } from "../env";
import { findMarketIntelligence } from "../market/registry";
import { MarketError, type YouTubeSignal } from "../market/types";
import { jsonError, jsonOk } from "../utils/http";

/**
 * GET /api/market/youtube: collect YouTube market intelligence for a keyword
 * and persist the aggregate signal.
 *
 * Query params:
 * - `q` (required)            keyword to search YouTube for
 * - `maxResults` (optional)   max number of videos to aggregate (1..50);
 *                             default 25
 * - `order` (optional)        relevance|date|rating|viewCount; default
 *                             "relevance"
 * - `publishedWithin` (optional) any|hour|day|week|month|year; default "any"
 *
 * Outcomes map to:
 * - 200 `{ status: "ok", source, provider, keyword, order, publishedWithin,
 *   limit, capturedAt, requested, persisted, created, updated, failed,
 *   signals }`
 * - 400 `MISSING_KEYWORD` or a validation code (`INVALID_KEYWORD`,
 *   `INVALID_LIMIT`, `INVALID_ORDER`, `INVALID_PUBLISHED_WITHIN`)
 * - 501 `NO_MARKET_SOURCE` when no market-intelligence module is registered
 * - 502 with the provider's typed code (`YOUTUBE_NOT_CONFIGURED`, `AUTH_ERROR`,
 *   `RATE_LIMITED`, `QUOTA_EXCEEDED`, `TIMEOUT`, `HTTP_ERROR`,
 *   `INVALID_PAYLOAD`, ...)
 * - 503 `SUPABASE_NOT_CONFIGURED` when Supabase bindings are missing
 */
const VALIDATION_CODES = new Set(["INVALID_KEYWORD", "INVALID_LIMIT", "INVALID_ORDER", "INVALID_PUBLISHED_WITHIN"]);

export async function handleYouTube(
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

  const module = findMarketIntelligence("youtube");
  if (!module) {
    return jsonError(501, "No market intelligence module registered for youtube", "NO_MARKET_SOURCE", requestId);
  }

  const query = {
    keyword,
    limit: params.get("maxResults")?.trim() || undefined,
    order: params.get("order")?.trim() || undefined,
    publishedWithin: params.get("publishedWithin")?.trim() || undefined,
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

  const firstSignal = (result.signals[0] ?? null) as YouTubeSignal | null;

  return jsonOk({
    status: "ok",
    source: result.source,
    provider: result.provider,
    keyword: result.keyword,
    order: firstSignal?.order ?? "relevance",
    publishedWithin: result.timeRange,
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
