import type { Env } from "../env";
import { findMarketIntelligence } from "../market/registry";
import { MarketError } from "../market/types";
import { jsonError, jsonOk } from "../utils/http";

/**
 * GET /api/market/google-trends: collect Google Trends market intelligence for
 * a keyword in a region and persist the observations.
 *
 * Query params:
 * - `q` (required)          keyword to measure relative interest for
 * - `geo` (optional)        region; "WORLD" or ISO-3166 alpha-2 (e.g. "US",
 *                           "GB-SCT"); defaults to "WORLD"
 * - `timeRange` (optional)  one of the canonical Google Trends ranges or a
 *                           custom `YYYY-MM-DD YYYY-MM-DD`; default "today 5-y"
 * - `property` (optional)   web|images|news|youtube|froogle; default "web"
 * - `category` (optional)   non-negative integer Google Trends category id
 *
 * Outcomes map to:
 * - 200 `{ status: "ok", source, provider, keyword, geo, timeRange, property,
 *   category, capturedAt, requested, persisted, created, updated, failed, signals }`
 * - 400 `MISSING_KEYWORD` or a validation code (`INVALID_KEYWORD`, `INVALID_GEO`,
 *   `INVALID_TIME_RANGE`, `INVALID_PROPERTY`, `INVALID_CATEGORY`)
 * - 501 `NO_MARKET_SOURCE` when no market-intelligence module is registered
 * - 502 with the provider's typed code (`RATE_LIMITED`, `BLOCKED`, `TIMEOUT`,
 *   `HTTP_ERROR`, `INVALID_PAYLOAD`, ...)
 * - 503 `SUPABASE_NOT_CONFIGURED` when Supabase bindings are missing
 */
const VALIDATION_CODES = new Set([
  "INVALID_KEYWORD",
  "INVALID_GEO",
  "INVALID_TIME_RANGE",
  "INVALID_PROPERTY",
  "INVALID_CATEGORY",
]);

export async function handleGoogleTrends(
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

  const module = findMarketIntelligence("google-trends");
  if (!module) {
    return jsonError(501, "No market intelligence module registered for google-trends", "NO_MARKET_SOURCE", requestId);
  }

  const query = {
    keyword,
    geo: params.get("geo")?.trim() || undefined,
    timeRange: params.get("timeRange")?.trim() || undefined,
    property: params.get("property")?.trim() || undefined,
    category: params.get("category")?.trim() || undefined,
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

  return jsonOk({
    status: "ok",
    source: result.source,
    provider: result.provider,
    keyword: result.keyword,
    geo: result.geo,
    timeRange: result.timeRange,
    property: result.property,
    category: result.category,
    capturedAt: result.capturedAt,
    requested: result.requested,
    persisted: result.persisted,
    created: result.created,
    updated: result.updated,
    failed: result.failed,
    signals: result.signals,
  });
}
