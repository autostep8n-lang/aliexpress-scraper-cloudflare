import type { Env } from "../env";
import { hasOpenApiCredentials, openApiCredentials } from "../scrapers/aliexpress-openapi-credentials";
import {
  ALIEXPRESS_OAUTH_CALLBACK_PATH,
  ALIEXPRESS_OAUTH_START_PATH,
  buildAliExpressAuthorizeUrl,
  buildAliExpressOAuthCallbackUrl,
  exchangeAliExpressAuthorizationCode,
  parseAliExpressOAuthCallbackParams,
  persistAliExpressToken,
} from "../scrapers/aliexpress-oauth";
import { ScraperError } from "../scrapers/types";
import { jsonError, jsonOk } from "../utils/http";

const OAUTH_CLIENT_CODES = new Set(["MISSING_CODE", "INVALID_CODE"]);

/**
 * GET /api/aliexpress/oauth: start official AliExpress Dropshipping OAuth.
 * Redirects to Open Platform authorize. Requires ALIEXPRESS_OPENAPI_KEY /
 * ALIEXPRESS_OPENAPI_SECRET. Does not invent `scope` or `state`.
 */
export async function handleAliExpressOAuthStart(request: Request, env: Env, requestId: string): Promise<Response> {
  const credentials = openApiCredentials(env);
  if (!credentials) {
    return jsonError(
      503,
      "AliExpress Open Platform is not configured; set ALIEXPRESS_OPENAPI_KEY and ALIEXPRESS_OPENAPI_SECRET",
      "ALIEXPRESS_OAUTH_NOT_CONFIGURED",
      requestId,
    );
  }

  const redirectUri = buildAliExpressOAuthCallbackUrl(request.url);
  const authorizeUrl = buildAliExpressAuthorizeUrl({
    appKey: credentials.appKey,
    redirectUri,
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl.href,
      "x-request-id": requestId,
    },
  });
}

/**
 * GET /api/aliexpress/oauth/callback: Open Platform redirect_uri.
 *
 * Exchanges `code` for access/refresh tokens and persists them in SCRAPE_CACHE.
 * Never returns or logs tokens, secrets, or authorization codes.
 */
export async function handleAliExpressOAuthCallback(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const params = parseAliExpressOAuthCallbackParams(url);

  if (params.error) {
    const denied = params.error === "access_denied";
    return jsonError(
      denied ? 403 : 502,
      denied ? "aliexpress oauth was denied" : "aliexpress oauth provider returned an error",
      denied ? "OAUTH_DENIED" : "AUTH_ERROR",
      requestId,
    );
  }

  if (!params.code) {
    return jsonError(400, "aliexpress oauth callback is missing the authorization code", "MISSING_CODE", requestId);
  }

  if (!hasOpenApiCredentials(env)) {
    return jsonError(
      503,
      "AliExpress Open Platform is not configured; set ALIEXPRESS_OPENAPI_KEY and ALIEXPRESS_OPENAPI_SECRET",
      "ALIEXPRESS_OAUTH_NOT_CONFIGURED",
      requestId,
    );
  }

  if (!env.SCRAPE_CACHE) {
    return jsonError(
      503,
      "AliExpress Dropshipping token store is unavailable; bind SCRAPE_CACHE to persist OAuth tokens",
      "TOKEN_STORE_UNAVAILABLE",
      requestId,
    );
  }

  try {
    const token = await exchangeAliExpressAuthorizationCode(env, params.code);
    await persistAliExpressToken(env, token);
    return jsonOk({
      status: "ok",
      provider: "aliexpress-dropshipping",
      path: ALIEXPRESS_OAUTH_CALLBACK_PATH,
      userId: token.userId ?? null,
      sellerId: token.sellerId ?? null,
      expiresIn: Math.max(0, Math.floor((token.expiresAt - Date.now()) / 1000)),
      refreshExpiresIn:
        token.refreshExpiresAt === null ? null : Math.max(0, Math.floor((token.refreshExpiresAt - Date.now()) / 1000)),
    });
  } catch (err) {
    if (err instanceof ScraperError) {
      return jsonError(oauthStatusFor(err.code), err.message, err.code, requestId);
    }
    throw err;
  }
}

function oauthStatusFor(code: string): number {
  if (code === "ALIEXPRESS_OAUTH_NOT_CONFIGURED" || code === "TOKEN_STORE_UNAVAILABLE") return 503;
  if (OAUTH_CLIENT_CODES.has(code) || code === "INVALID_PAYLOAD") return 400;
  return 502;
}

export { ALIEXPRESS_OAUTH_CALLBACK_PATH, ALIEXPRESS_OAUTH_START_PATH };
