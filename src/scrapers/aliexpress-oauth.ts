import type { Env } from "../env";
import { ScraperError } from "./types";
import {
  DS_AUTHORIZE_URL,
  DS_REST_PREFIX,
  DS_SIGN_METHOD,
  DS_TOKEN_CREATE_PATH,
  DS_TOKEN_REFRESH_PATH,
  dsHmacSign,
  dsTimestamp,
  quoteJsonIntegerFields,
} from "./aliexpress-sign";
import { openApiCredentials } from "./aliexpress-openapi-credentials";

/**
 * Official AliExpress Dropshipping OAuth (authorization-code grant).
 *
 * Authorize (do not invent `scope` / `state`):
 *   GET https://api-sg.aliexpress.com/oauth/authorize
 *     ?response_type=code&force_auth=true&redirect_uri=...&client_id=...
 *
 * Token create: POST https://api-sg.aliexpress.com/rest/auth/token/create
 * Token refresh: POST https://api-sg.aliexpress.com/rest/auth/token/refresh
 *
 * Tokens persist in `SCRAPE_CACHE` (KV). Never log access_token, refresh_token,
 * authorization codes, or app secrets.
 */

export const ALIEXPRESS_OAUTH_START_PATH = "/api/aliexpress/oauth";
export const ALIEXPRESS_OAUTH_CALLBACK_PATH = "/api/aliexpress/oauth/callback";

export const DS_TOKEN_KV_KEY = "aliexpress:ds:oauth:tokens";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const ACCESS_TOKEN_SKEW_MS = 60_000;
const INTEGER_FIELDS = [
  "user_id",
  "expire_time",
  "expires_in",
  "refresh_expires_in",
  "seller_id",
  "account_id",
] as const;

export interface AliExpressDsToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number | null;
  userId?: string;
  sellerId?: string;
}

export function buildAliExpressOAuthCallbackUrl(requestUrl: string | URL): string {
  const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  return `${url.origin}${ALIEXPRESS_OAUTH_CALLBACK_PATH}`;
}

export function buildAliExpressAuthorizeUrl(opts: { appKey: string; redirectUri: string }): URL {
  const url = new URL(DS_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("force_auth", "true");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("client_id", opts.appKey);
  return url;
}

export function parseAliExpressOAuthCallbackParams(url: URL): {
  code?: string;
  error?: string;
  errorDescription?: string;
} {
  const code = url.searchParams.get("code")?.trim() || undefined;
  const error = url.searchParams.get("error")?.trim() || undefined;
  const errorDescription = url.searchParams.get("error_description")?.trim() || undefined;
  return { code, error, errorDescription };
}

export async function exchangeAliExpressAuthorizationCode(env: Env, code: string): Promise<AliExpressDsToken> {
  const credentials = openApiCredentials(env);
  if (!credentials) {
    throw new ScraperError(
      "ALIEXPRESS_OAUTH_NOT_CONFIGURED",
      "AliExpress Open Platform is not configured; set ALIEXPRESS_OPENAPI_KEY and ALIEXPRESS_OPENAPI_SECRET",
    );
  }
  const trimmed = code.trim();
  if (!trimmed) {
    throw new ScraperError("MISSING_CODE", "aliexpress oauth callback is missing the authorization code");
  }
  return createAliExpressToken(credentials.appKey, credentials.appSecret, trimmed);
}

export async function refreshAliExpressToken(env: Env, refreshToken: string): Promise<AliExpressDsToken> {
  const credentials = openApiCredentials(env);
  if (!credentials) {
    throw new ScraperError(
      "ALIEXPRESS_OAUTH_NOT_CONFIGURED",
      "AliExpress Open Platform is not configured; set ALIEXPRESS_OPENAPI_KEY and ALIEXPRESS_OPENAPI_SECRET",
    );
  }
  const trimmed = refreshToken.trim();
  if (!trimmed) {
    throw new ScraperError("PROVIDER_AUTH_ERROR", "AliExpress Dropshipping refresh token is missing");
  }
  return refreshAliExpressTokenWithSecret(credentials.appKey, credentials.appSecret, trimmed);
}

export async function loadPersistedAliExpressToken(env: Env): Promise<AliExpressDsToken | undefined> {
  if (!env.SCRAPE_CACHE) return undefined;
  try {
    const raw = await env.SCRAPE_CACHE.get(DS_TOKEN_KV_KEY);
    if (!raw) return undefined;
    return parseStoredToken(raw);
  } catch {
    return undefined;
  }
}

export async function persistAliExpressToken(env: Env, token: AliExpressDsToken): Promise<void> {
  if (!env.SCRAPE_CACHE) {
    throw new ScraperError(
      "TOKEN_STORE_UNAVAILABLE",
      "AliExpress Dropshipping token store is unavailable; bind SCRAPE_CACHE to persist OAuth tokens",
    );
  }
  await env.SCRAPE_CACHE.put(DS_TOKEN_KV_KEY, serializeStoredToken(token));
}

/**
 * Returns a usable access token, refreshing and persisting rotation when the
 * stored access token is expired (or about to expire) and a refresh token remains valid.
 */
export async function resolveAliExpressAccessToken(env: Env, now = Date.now()): Promise<string> {
  const stored = await loadPersistedAliExpressToken(env);
  if (!stored) {
    throw new ScraperError(
      "PROVIDER_AUTH_ERROR",
      "AliExpress Dropshipping access token is not available; complete /api/aliexpress/oauth",
    );
  }
  if (stored.expiresAt - ACCESS_TOKEN_SKEW_MS > now) {
    return stored.accessToken;
  }
  if (stored.refreshExpiresAt !== null && stored.refreshExpiresAt <= now) {
    throw new ScraperError(
      "PROVIDER_AUTH_ERROR",
      "AliExpress Dropshipping refresh token has expired; complete /api/aliexpress/oauth",
    );
  }
  const refreshed = await refreshAliExpressToken(env, stored.refreshToken);
  await persistAliExpressToken(env, refreshed);
  return refreshed.accessToken;
}

export function parseTokenCreatePayload(payload: Record<string, unknown>, now = Date.now()): AliExpressDsToken {
  const root = unwrapTokenPayload(payload);
  const accessToken = asNonEmptyString(root["access_token"]);
  const refreshToken = asNonEmptyString(root["refresh_token"]);
  if (!accessToken || !refreshToken) {
    throw new ScraperError("INVALID_PAYLOAD", "AliExpress token response is missing access_token or refresh_token");
  }
  const expiresIn = toFiniteInt(root["expires_in"]);
  const refreshExpiresIn = toFiniteInt(root["refresh_expires_in"]);
  const expiresAt = expiresIn !== null && expiresIn > 0 ? now + expiresIn * 1000 : now;
  const refreshExpiresAt =
    refreshExpiresIn !== null && refreshExpiresIn > 0 ? now + refreshExpiresIn * 1000 : null;
  const token: AliExpressDsToken = { accessToken, refreshToken, expiresAt, refreshExpiresAt };
  const userId = asNonEmptyString(root["user_id"]);
  const sellerId = asNonEmptyString(root["seller_id"]) ?? asNonEmptyString(root["account_id"]);
  if (userId) token.userId = userId;
  if (sellerId) token.sellerId = sellerId;
  return token;
}

async function createAliExpressToken(appKey: string, appSecret: string, code: string): Promise<AliExpressDsToken> {
  const params: Record<string, string> = {
    code,
    app_key: appKey,
    timestamp: dsTimestamp(),
    sign_method: DS_SIGN_METHOD,
  };
  params["sign"] = await dsHmacSign(appSecret, params, DS_TOKEN_CREATE_PATH);
  const payload = await postSystemApi(DS_TOKEN_CREATE_PATH, params, "token-create");
  return parseTokenCreatePayload(payload);
}

async function refreshAliExpressTokenWithSecret(
  appKey: string,
  appSecret: string,
  refreshToken: string,
): Promise<AliExpressDsToken> {
  const params: Record<string, string> = {
    refresh_token: refreshToken,
    app_key: appKey,
    timestamp: dsTimestamp(),
    sign_method: DS_SIGN_METHOD,
  };
  params["sign"] = await dsHmacSign(appSecret, params, DS_TOKEN_REFRESH_PATH);
  const payload = await postSystemApi(DS_TOKEN_REFRESH_PATH, params, "token-refresh");
  return parseTokenCreatePayload(payload);
}

async function postSystemApi(
  apiPath: string,
  params: Record<string, string>,
  label: string,
): Promise<Record<string, unknown>> {
  const url = `${DS_REST_PREFIX}${apiPath}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ScraperError("TIMEOUT", `AliExpress oauth ${label} timed out`);
    }
    throw new ScraperError("PROVIDER_NETWORK_ERROR", `AliExpress oauth ${label} request failed`);
  }

  const text = await readBodyLimited(response, label);
  if (!response.ok) {
    const info = extractProviderError(text);
    if (isInvalidCodeError(response.status, info, label)) {
      throw new ScraperError("INVALID_CODE", "AliExpress oauth authorization code was rejected");
    }
    if (response.status === 401 || response.status === 403) {
      throw new ScraperError("PROVIDER_AUTH_ERROR", `AliExpress oauth ${label} rejected the request`);
    }
    throw new ScraperError("PROVIDER_HTTP_ERROR", `AliExpress oauth ${label} returned HTTP ${response.status}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(quoteJsonIntegerFields(text, INTEGER_FIELDS));
  } catch {
    throw new ScraperError("INVALID_PAYLOAD", `AliExpress oauth ${label} returned malformed JSON`);
  }
  const record = asRecord(json);
  if (!record) {
    throw new ScraperError("INVALID_PAYLOAD", `AliExpress oauth ${label} response must be an object`);
  }
  const errorResponse = asRecord(record["error_response"]);
  if (errorResponse) {
    const code = asNonEmptyString(errorResponse["code"]) ?? "UNKNOWN";
    const msg = asNonEmptyString(errorResponse["msg"]) ?? "unknown provider error";
    if (/InvalidCode|invalid.?code/i.test(`${code} ${msg}`)) {
      throw new ScraperError("INVALID_CODE", "AliExpress oauth authorization code was rejected");
    }
    if (/401|signature|invalid app|credential|IllegalAccessToken|access.?token/i.test(`${code} ${msg}`)) {
      throw new ScraperError("PROVIDER_AUTH_ERROR", "AliExpress oauth token endpoint rejected the request");
    }
    throw new ScraperError("PROVIDER_API_ERROR", `AliExpress oauth ${label} error ${code}`);
  }
  return record;
}

function unwrapTokenPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const nested =
    asRecord(payload["result"]) ??
    asRecord(payload["response"]) ??
    asRecord(payload["data"]) ??
    asRecord(payload["/auth/token/create_response"]) ??
    asRecord(payload["/auth/token/refresh_response"]);
  return nested ?? payload;
}

function parseStoredToken(raw: string): AliExpressDsToken | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (!record) return undefined;
  const accessToken = asNonEmptyString(record["accessToken"]);
  const refreshToken = asNonEmptyString(record["refreshToken"]);
  const expiresAt = toFiniteInt(record["expiresAt"]);
  if (!accessToken || !refreshToken || expiresAt === null) return undefined;
  const refreshExpiresAt = toFiniteInt(record["refreshExpiresAt"]);
  const token: AliExpressDsToken = {
    accessToken,
    refreshToken,
    expiresAt,
    refreshExpiresAt,
  };
  const userId = asNonEmptyString(record["userId"]);
  const sellerId = asNonEmptyString(record["sellerId"]);
  if (userId) token.userId = userId;
  if (sellerId) token.sellerId = sellerId;
  return token;
}

function serializeStoredToken(token: AliExpressDsToken): string {
  return JSON.stringify({
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    refreshExpiresAt: token.refreshExpiresAt,
    ...(token.userId ? { userId: token.userId } : {}),
    ...(token.sellerId ? { sellerId: token.sellerId } : {}),
  });
}

function extractProviderError(text: string): { code?: string; msg?: string } | null {
  try {
    const payload = JSON.parse(text) as unknown;
    const root = asRecord(payload);
    if (!root) return null;
    const nested = asRecord(root.error_response) ?? root;
    const code = asNonEmptyString(nested.code) ?? asNonEmptyString(nested.error_code);
    const msg = asNonEmptyString(nested.msg) ?? asNonEmptyString(nested.message) ?? asNonEmptyString(nested.error_msg);
    if (!code && !msg) return null;
    return { code, msg };
  } catch {
    return null;
  }
}

function isInvalidCodeError(
  status: number,
  info: { code?: string; msg?: string } | null,
  label: string,
): boolean {
  if (label !== "token-create") return false;
  const haystack = `${info?.code ?? ""} ${info?.msg ?? ""}`;
  return status === 400 || /InvalidCode|invalid.?code/i.test(haystack);
}

async function readBodyLimited(response: Response, label: string): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ScraperError("RESPONSE_TOO_LARGE", `AliExpress oauth ${label} response exceeded the size cap`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new ScraperError("RESPONSE_TOO_LARGE", `AliExpress oauth ${label} response exceeded the size cap`);
  }
  return text;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return undefined;
}

function toFiniteInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}
