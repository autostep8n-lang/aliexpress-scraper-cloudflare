import type { Env } from "../env";
import { findMarketIntelligence } from "../market/registry";
import { MarketError, type InstagramSignal } from "../market/types";
import { jsonError, jsonOk } from "../utils/http";

/**
 * GET /api/market/instagram: collect Instagram market intelligence for a
 * keyword and persist the aggregate signal.
 *
 * Query params:
 * - `q` (required)      keyword to derive the hashtag from and search for
 * - `limit` (optional)  max number of media items to aggregate per edge
 *                       (1..50); default 25
 *
 * Outcomes map to:
 * - 200 `{ status: "ok", source, provider, keyword, hashtag, limit,
 *   capturedAt, requested, persisted, created, updated, failed, signals }`
 * - 400 `MISSING_KEYWORD` or a validation code (`INVALID_KEYWORD`,
 *   `INVALID_LIMIT`)
 * - 501 `NO_MARKET_SOURCE` when no market-intelligence module is registered
 * - 502 with the provider's typed code (`INSTAGRAM_NOT_CONFIGURED`,
 *   `AUTH_ERROR`, `RATE_LIMITED`, `TIMEOUT`, `HTTP_ERROR`, `INVALID_PAYLOAD`,
 *   ...)
 * - 503 `SUPABASE_NOT_CONFIGURED` when Supabase bindings are missing
 */
const VALIDATION_CODES = new Set(["INVALID_KEYWORD", "INVALID_LIMIT"]);

export async function handleInstagram(
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

  const module = findMarketIntelligence("instagram");
  if (!module) {
    return jsonError(501, "No market intelligence module registered for instagram", "NO_MARKET_SOURCE", requestId);
  }

  const query = {
    keyword,
    limit: params.get("limit")?.trim() || undefined,
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

  const firstSignal = (result.signals[0] ?? null) as InstagramSignal | null;

  return jsonOk({
    status: "ok",
    source: result.source,
    provider: result.provider,
    keyword: result.keyword,
    hashtag: firstSignal?.hashtag ?? null,
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
