import type { Env } from "../env";
import { MarketError } from "./types";

/**
 * Instagram Business Login (Instagram API with Instagram Login) OAuth.
 *
 * Meta's current Business Login flow (not Facebook Login, not the Graph
 * hashtag collector) is an authorization-code grant:
 *
 *   1. GET https://www.instagram.com/oauth/authorize
 *      `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`
 *   2. Instagram redirects to this Worker's callback with `code` (or `error`)
 *   3. POST https://api.instagram.com/oauth/access_token
 *      form: `client_id`, `client_secret`, `grant_type=authorization_code`,
 *      `redirect_uri`, `code` -> short-lived user token + IG user id
 *   4. GET https://graph.instagram.com/access_token
 *      `grant_type=ig_exchange_token`, `client_secret`, `access_token`
 *      -> long-lived token (~60 days)
 *
 * The Redirect URL registered in the Meta app must be exactly
 * `{origin}/api/market/instagram/oauth/callback`. On the production Worker
 * that is:
 * `https://aliexpress-scraper-cloudflare.auto-step8n.workers.dev/api/market/instagram/oauth/callback`
 *
 * This module never logs access tokens, app secrets, or authorization codes.
 * The collector (`src/market/instagram.ts`) still reads
 * `INSTAGRAM_ACCESS_TOKEN` / `INSTAGRAM_IG_USER_ID` from Worker secrets;
 * this flow only obtains those values so an operator can configure them.
 */

export const INSTAGRAM_OAUTH_START_PATH = "/api/market/instagram/oauth";
export const INSTAGRAM_OAUTH_CALLBACK_PATH = "/api/market/instagram/oauth/callback";

const AUTHORIZE_HOST = "www.instagram.com";
const TOKEN_HOST = "api.instagram.com";
const GRAPH_HOST = "graph.instagram.com";
const AUTHORIZE_URL = `https://${AUTHORIZE_HOST}/oauth/authorize`;
const SHORT_LIVED_TOKEN_URL = `https://${TOKEN_HOST}/oauth/access_token`;
const LONG_LIVED_TOKEN_URL = `https://${GRAPH_HOST}/access_token`;
const DEFAULT_SCOPES = "instagram_business_basic";
const STATE_COOKIE = "ig_oauth_state";
const STATE_MAX_AGE_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

export interface InstagramOAuthCredentials {
  appId: string;
  appSecret: string;
}

export interface InstagramOAuthToken {
  accessToken: string;
  userId: string;
  tokenType: string;
  expiresIn: number | null;
}

/** True for the Instagram OAuth hosts this module is allowed to call. */
export function isInstagramOAuthHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === TOKEN_HOST || host === GRAPH_HOST;
}

export function instagramOAuthCredentials(env: Env): InstagramOAuthCredentials | undefined {
  const appId = env.INSTAGRAM_APP_ID?.trim();
  const appSecret = env.INSTAGRAM_APP_SECRET?.trim();
  if (!appId || !appSecret) return undefined;
  return { appId, appSecret };
}

export function hasInstagramOAuthCredentials(env: Env): boolean {
  return instagramOAuthCredentials(env) !== undefined;
}

/** Exact Redirect URL Meta must have registered for this request's origin. */
export function buildOAuthCallbackUrl(requestUrl: string | URL): string {
  const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  return `${url.origin}${INSTAGRAM_OAUTH_CALLBACK_PATH}`;
}

export function buildInstagramAuthorizeUrl(opts: {
  appId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): URL {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", opts.appId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scope?.trim() || DEFAULT_SCOPES);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("force_reauth", "true");
  return url;
}

export function createOAuthState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const STATE_COOKIE_PATH = "/api/market/instagram";

export function oauthStateCookie(state: string, maxAge = STATE_MAX_AGE_SECONDS): string {
  return `${STATE_COOKIE}=${state}; Path=${STATE_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearOAuthStateCookie(): string {
  return `${STATE_COOKIE}=; Path=${STATE_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function readOAuthStateCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (name !== STATE_COOKIE) continue;
    const value = trimmed.slice(eq + 1).trim();
    return value || undefined;
  }
  return undefined;
}

export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

export interface InstagramOAuthCallbackParams {
  code?: string;
  state?: string;
  error?: string;
  errorReason?: string;
  errorDescription?: string;
}

export function parseInstagramOAuthCallbackParams(url: URL): InstagramOAuthCallbackParams {
  const code = url.searchParams.get("code")?.trim() || undefined;
  const state = url.searchParams.get("state")?.trim() || undefined;
  const error = url.searchParams.get("error")?.trim() || undefined;
  const errorReason = url.searchParams.get("error_reason")?.trim() || undefined;
  const errorDescription = url.searchParams.get("error_description")?.trim() || undefined;
  return { code, state, error, errorReason, errorDescription };
}

/**
 * Exchanges an authorization code for a long-lived Instagram user token.
 * Throws typed `MarketError`s; never includes secrets, codes, or tokens in
 * error messages.
 */
export async function exchangeInstagramAuthorizationCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<InstagramOAuthToken> {
  const credentials = instagramOAuthCredentials(env);
  if (!credentials) {
    throw new MarketError(
      "INSTAGRAM_OAUTH_NOT_CONFIGURED",
      "instagram business login is not configured; set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET",
    );
  }

  const trimmedCode = code.trim();
  if (!trimmedCode) {
    throw new MarketError("MISSING_CODE", "instagram oauth callback is missing the authorization code");
  }

  const shortLived = await exchangeShortLivedToken(credentials, trimmedCode, redirectUri);
  const longLived = await exchangeLongLivedToken(credentials, shortLived.accessToken);
  return {
    accessToken: longLived.accessToken,
    userId: shortLived.userId,
    tokenType: longLived.tokenType,
    expiresIn: longLived.expiresIn,
  };
}

async function exchangeShortLivedToken(
  credentials: InstagramOAuthCredentials,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; userId: string }> {
  const body = new URLSearchParams({
    client_id: credentials.appId,
    client_secret: credentials.appSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });

  const response = await fetchOAuthJson(new URL(SHORT_LIVED_TOKEN_URL), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body: body.toString(),
    redirect: "manual",
  }, "token");

  return parseShortLivedTokenPayload(response);
}

async function exchangeLongLivedToken(
  credentials: InstagramOAuthCredentials,
  shortLivedToken: string,
): Promise<{ accessToken: string; tokenType: string; expiresIn: number | null }> {
  const url = new URL(LONG_LIVED_TOKEN_URL);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", credentials.appSecret);
  url.searchParams.set("access_token", shortLivedToken);

  const payload = await fetchOAuthJson(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
  }, "long-lived-token");

  return parseLongLivedTokenPayload(payload);
}

export function parseShortLivedTokenPayload(payload: Record<string, unknown>): { accessToken: string; userId: string } {
  const entry = firstTokenEntry(payload);
  const accessToken = asNonEmptyString(entry["access_token"]);
  const userId = asNonEmptyString(entry["user_id"]);
  if (!accessToken || !userId) {
    throw new MarketError("INVALID_PAYLOAD", "instagram oauth token response is missing access_token or user_id");
  }
  return { accessToken, userId };
}

export function parseLongLivedTokenPayload(
  payload: Record<string, unknown>,
): { accessToken: string; tokenType: string; expiresIn: number | null } {
  const accessToken = asNonEmptyString(payload["access_token"]);
  if (!accessToken) {
    throw new MarketError("INVALID_PAYLOAD", "instagram long-lived token response is missing access_token");
  }
  const tokenType = asNonEmptyString(payload["token_type"]) ?? "bearer";
  const expiresIn = toFiniteInt(payload["expires_in"]);
  return { accessToken, tokenType, expiresIn };
}

function firstTokenEntry(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload["data"];
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (typeof first === "object" && first !== null && !Array.isArray(first)) {
      return first as Record<string, unknown>;
    }
  }
  return payload;
}

async function fetchOAuthJson(url: URL, init: RequestInit, label: string): Promise<Record<string, unknown>> {
  const response = await fetchWithRedirects(url, init);
  return readJsonResponse(response, label);
}

async function fetchWithRedirects(start: URL, init: RequestInit): Promise<Response> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchWithTimeout(current.href, init);
    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) {
        throw new MarketError("REDIRECT_NO_LOCATION", "instagram oauth redirect had no location header");
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new MarketError("REDIRECT_INVALID_LOCATION", "instagram oauth returned an invalid redirect location");
      }
      if (!isInstagramOAuthHost(next.hostname)) {
        throw new MarketError("REDIRECT_UNTRUSTED", "instagram oauth redirect left the allowlisted hosts");
      }
      current = next;
      continue;
    }
    return response;
  }
  throw new MarketError("TOO_MANY_REDIRECTS", "instagram oauth followed too many redirects");
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new MarketError("TIMEOUT", "instagram oauth request timed out");
    }
    throw new MarketError("HTTP_ERROR", "instagram oauth request failed");
  }
}

async function readJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  if (response.status === 429) {
    await response.body?.cancel();
    throw new MarketError("RATE_LIMITED", `instagram oauth ${label} was rate limited`);
  }

  const text = await readBodyLimited(response);

  if (!response.ok) {
    const info = extractOAuthError(text);
    if (isInvalidCodeError(response.status, info)) {
      throw new MarketError("INVALID_CODE", "instagram oauth authorization code was rejected");
    }
    if (response.status === 401 || response.status === 403 || info?.type === "OAuthException") {
      throw new MarketError("AUTH_ERROR", "instagram oauth token endpoint rejected the request");
    }
    throw new MarketError("HTTP_ERROR", `instagram oauth ${label} returned HTTP ${response.status}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MarketError("INVALID_PAYLOAD", `instagram oauth ${label} returned malformed JSON`);
  }
  const record = asRecord(json);
  if (!record) {
    throw new MarketError("INVALID_PAYLOAD", `instagram oauth ${label} response must be an object`);
  }
  if (record.error) {
    throw new MarketError("AUTH_ERROR", "instagram oauth token endpoint rejected the request");
  }
  return record;
}

function extractOAuthError(text: string): { type?: string; code?: number; message?: string } | null {
  try {
    const payload = JSON.parse(text) as unknown;
    const root = asRecord(payload);
    if (!root) return null;
    const nested = asRecord(root.error);
    const error = nested ?? root;
    const type =
      (typeof error.type === "string" && error.type) ||
      (typeof error.error_type === "string" && error.error_type) ||
      undefined;
    const code = typeof error.code === "number" ? error.code : undefined;
    const message =
      (typeof error.message === "string" && error.message) ||
      (typeof error.error_message === "string" && error.error_message) ||
      undefined;
    if (!type && code === undefined && !message) return null;
    return { type, code, message };
  } catch {
    return null;
  }
}

function isInvalidCodeError(status: number, info: { type?: string; message?: string } | null): boolean {
  if (status !== 400) return false;
  const haystack = `${info?.type ?? ""} ${info?.message ?? ""}`;
  return /code|authorization/i.test(haystack);
}

async function readBodyLimited(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new MarketError("RESPONSE_TOO_LARGE", "instagram oauth response exceeded the size cap");
  }

  if (!response.body) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new MarketError("RESPONSE_TOO_LARGE", "instagram oauth response exceeded the size cap");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new MarketError("RESPONSE_TOO_LARGE", "instagram oauth response exceeded the size cap");
      }
      chunks.push(value);
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // best-effort cancel
    }
    if (err instanceof MarketError) throw err;
    throw new MarketError("HTTP_ERROR", "failed to read instagram oauth response");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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
