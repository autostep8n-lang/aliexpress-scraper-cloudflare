import type { Env } from "../env";
import { findMarketIntelligence } from "../market/registry";
import {
  INSTAGRAM_OAUTH_CALLBACK_PATH,
  INSTAGRAM_OAUTH_START_PATH,
  buildInstagramAuthorizeUrl,
  buildOAuthCallbackUrl,
  clearOAuthStateCookie,
  createOAuthState,
  exchangeInstagramAuthorizationCode,
  hasInstagramOAuthCredentials,
  instagramOAuthCredentials,
  oauthStateCookie,
  parseInstagramOAuthCallbackParams,
  readOAuthStateCookie,
  timingSafeEqual,
} from "../market/instagram-oauth";
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

const OAUTH_CLIENT_CODES = new Set([
  "MISSING_CODE",
  "INVALID_CODE",
  "INVALID_STATE",
  "OAUTH_DENIED",
]);

/**
 * GET /api/market/instagram/oauth: start Instagram Business Login.
 * Redirects the browser to Instagram's authorize URL and sets an HttpOnly
 * state cookie. Requires INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET.
 */
export function handleInstagramOAuthStart(request: Request, env: Env, requestId: string): Response {
  const credentials = instagramOAuthCredentials(env);
  if (!credentials) {
    return jsonError(
      503,
      "instagram business login is not configured; set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET",
      "INSTAGRAM_OAUTH_NOT_CONFIGURED",
      requestId,
    );
  }

  const state = createOAuthState();
  const redirectUri = buildOAuthCallbackUrl(request.url);
  const authorizeUrl = buildInstagramAuthorizeUrl({
    appId: credentials.appId,
    redirectUri,
    state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl.href,
      "set-cookie": oauthStateCookie(state),
      "x-request-id": requestId,
    },
  });
}

/**
 * GET /api/market/instagram/oauth/callback: Meta Redirect URL.
 *
 * Production URL:
 * `https://aliexpress-scraper-cloudflare.auto-step8n.workers.dev/api/market/instagram/oauth/callback`
 *
 * Exchanges `code` for a long-lived Instagram user token. The JSON body
 * includes `userId` / `expiresIn` so an operator can set Worker secrets; it
 * never logs the token, app secret, or authorization code.
 */
export async function handleInstagramOAuthCallback(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const params = parseInstagramOAuthCallbackParams(url);

  if (params.error) {
    const denied = params.error === "access_denied";
    return withClearedOAuthCookie(
      jsonError(
        denied ? 403 : 502,
        denied ? "instagram oauth was denied" : "instagram oauth provider returned an error",
        denied ? "OAUTH_DENIED" : "AUTH_ERROR",
        requestId,
      ),
    );
  }

  if (!params.code) {
    return withClearedOAuthCookie(
      jsonError(400, "instagram oauth callback is missing the authorization code", "MISSING_CODE", requestId),
    );
  }

  if (!hasInstagramOAuthCredentials(env)) {
    return withClearedOAuthCookie(
      jsonError(
        503,
        "instagram business login is not configured; set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET",
        "INSTAGRAM_OAUTH_NOT_CONFIGURED",
        requestId,
      ),
    );
  }

  const expectedState = readOAuthStateCookie(request);
  if (!params.state || !expectedState || !timingSafeEqual(params.state, expectedState)) {
    return withClearedOAuthCookie(jsonError(400, "instagram oauth state mismatch", "INVALID_STATE", requestId));
  }

  try {
    const token = await exchangeInstagramAuthorizationCode(env, params.code, buildOAuthCallbackUrl(url));
    return withClearedOAuthCookie(
      jsonOk({
        status: "ok",
        provider: "instagram-business-login",
        path: INSTAGRAM_OAUTH_CALLBACK_PATH,
        userId: token.userId,
        tokenType: token.tokenType,
        expiresIn: token.expiresIn,
        accessToken: token.accessToken,
      }),
    );
  } catch (err) {
    if (err instanceof MarketError) {
      const status = oauthStatusFor(err.code);
      return withClearedOAuthCookie(jsonError(status, err.message, err.code, requestId));
    }
    throw err;
  }
}

function withClearedOAuthCookie(response: Response): Response {
  response.headers.set("set-cookie", clearOAuthStateCookie());
  return response;
}

function oauthStatusFor(code: string): number {
  if (code === "INSTAGRAM_OAUTH_NOT_CONFIGURED") return 503;
  if (OAUTH_CLIENT_CODES.has(code) || code === "INVALID_PAYLOAD") return 400;
  return 502;
}

export { INSTAGRAM_OAUTH_CALLBACK_PATH, INSTAGRAM_OAUTH_START_PATH };
