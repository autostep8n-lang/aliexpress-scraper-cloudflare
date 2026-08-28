import type { Env } from "../env";
import { normalizeRedditQuery, parseRedditSearchResponse, toRedditObservationRow } from "./reddit-engine";
import { upsertRedditSignals } from "../supabase/repository";
import {
  MarketError,
  type MarketCollectResult,
  type MarketIntelligenceModule,
  type NormalizedRedditQuery,
  type RedditProvider,
  type RedditQuery,
  type RedditSignal,
} from "./types";

/**
 * Reddit - official API provider and collect module (P3.2).
 *
 * Reddit has an official OAuth2 API. This provider uses the app-only
 * client-credentials flow straight from the Worker - no third-party library,
 * no SaaS, no scraper:
 *
 *   1. POST https://www.reddit.com/api/v1/access_token with
 *      `grant_type=client_credentials` + HTTP Basic auth
 *      (REDDIT_CLIENT_ID : REDDIT_CLIENT_SECRET) -> bearer access token
 *   2. GET https://oauth.reddit.com/search?q=<keyword>&limit&sort&t&raw_json=1
 *      with the bearer token -> a `Listing` of matching posts
 *
 * Security/reliability posture (mirrors `src/market/google-trends.ts`):
 * - fixed host allowlist (`www.reddit.com`, `oauth.reddit.com`) only
 * - redirects followed manually, host revalidated on every hop, max 5; a
 *   redirect toward the web login page is treated as an auth failure
 * - 15s timeout per hop
 * - ~512KB response-size cap
 * - `429` maps to `RATE_LIMITED`; `401`/`403` map to `AUTH_ERROR`; no tight
 *   retry loops
 * - optional short-TTL `SCRAPE_CACHE` cache keyed on the normalized query
 *
 * The acquisition mechanism is isolated behind `RedditProvider`, so the domain
 * model and persistence never depend on how data is fetched.
 */

const OAUTH_HOST = "www.reddit.com";
const API_HOST = "oauth.reddit.com";
const TOKEN_ENDPOINT = `https://${OAUTH_HOST}/api/v1/access_token`;
const SEARCH_PATH = "/search";
const DEFAULT_USER_AGENT =
  "monkeycode-product-intelligence/0.1.0 (Cloudflare Worker market-intelligence collector)";
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const CACHE_PREFIX = "market:reddit:";
const CACHE_TTL_SECONDS = 60 * 60;
const DEFAULT_PROVIDER_NAME = "official-api";

/** True for the Reddit OAuth hosts this provider is allowed to talk to. */
export function isRedditHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === OAUTH_HOST || host === API_HOST;
}

/**
 * Resolves the active Reddit provider. Today only the official OAuth2 API
 * provider exists; a future provider would be selected here without touching
 * the domain model.
 */
export function getRedditProvider(): RedditProvider {
  return officialApiRedditProvider;
}

class OfficialApiRedditProvider implements RedditProvider {
  readonly name = DEFAULT_PROVIDER_NAME;

  async fetchSignals(query: NormalizedRedditQuery, env: Env, ctx: ExecutionContext): Promise<RedditSignal[]> {
    const capturedAt = new Date().toISOString();
    const cacheKey = cacheKeyFor(query);

    const cached = await readCache(env, cacheKey);
    if (cached) return cached;

    const token = await acquireAccessToken(env);
    const url = buildSearchUrl(query);
    const payload = await fetchSearchJson(url, token, env);
    const signals = [parseRedditSearchResponse(payload, query, capturedAt)];

    await writeCache(env, ctx, cacheKey, signals);
    return signals;
  }
}

/** Default singleton provider instance. */
export const officialApiRedditProvider: RedditProvider = new OfficialApiRedditProvider();

/**
 * Reddit collect module: normalize -> fetch via the active provider -> persist
 * through the shared repository. Registered in `src/market/registry.ts`.
 */
export const redditModule: MarketIntelligenceModule<RedditQuery, RedditSignal> = {
  source: "reddit",

  async collect(query: RedditQuery, env: Env, ctx: ExecutionContext): Promise<MarketCollectResult<RedditSignal>> {
    const normalized = normalizeRedditQuery(query);
    const provider = getRedditProvider();
    const signals = await provider.fetchSignals(normalized, env, ctx);

    const persisted = await persistSignals(env, signals);
    const capturedAt = signals[0]?.capturedAt ?? "";

    return {
      source: "reddit",
      provider: provider.name,
      keyword: normalized.keyword,
      geo: "WORLD",
      timeRange: normalized.timeFilter,
      property: "posts",
      category: null,
      capturedAt,
      requested: signals.length,
      persisted: persisted.count,
      created: persisted.created,
      updated: persisted.updated,
      failed: signals.length - persisted.count,
      signals,
    };
  },
};

async function persistSignals(
  env: Env,
  signals: RedditSignal[],
): Promise<{ count: number; created: number; updated: number }> {
  if (signals.length === 0) {
    return { count: 0, created: 0, updated: 0 };
  }

  const rows = signals.map((signal) => toRedditObservationRow(signal, null));
  const persisted = await upsertRedditSignals(env, rows);

  switch (persisted.status) {
    case "credentials_missing":
      throw new MarketError("SUPABASE_NOT_CONFIGURED", "Supabase is not configured");
    case "invalid":
      throw new MarketError("INVALID_TREND_DATA", persisted.message);
    case "error":
      throw new MarketError(persisted.code ?? "INGEST_FAILED", persisted.message);
    case "created":
    case "updated":
      return {
        count: persisted.data.length,
        created: persisted.status === "created" ? persisted.data.length : 0,
        updated: persisted.status === "updated" ? persisted.data.length : 0,
      };
    case "found":
    case "not_found":
      throw new MarketError("INGEST_FAILED", "unexpected repository outcome");
  }
}

/**
 * Exchanges the app's client credentials for a short-lived bearer access token
 * via the OAuth2 client-credentials grant. Throws `REDDIT_NOT_CONFIGURED`
 * when the credentials are absent, `AUTH_ERROR` on 401/403, `RATE_LIMITED` on
 * 429, and `INVALID_PAYLOAD` on a malformed token response.
 */
export async function acquireAccessToken(env: Env): Promise<string> {
  const clientId = env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = env.REDDIT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new MarketError(
      "REDDIT_NOT_CONFIGURED",
      "reddit oauth credentials (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET) are not configured",
    );
  }

  const basic = btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`);
  const response = await fetchWithTimeout(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "user-agent": userAgentFor(env),
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    redirect: "manual",
  });

  const payload = await readJsonResponse(response, TOKEN_ENDPOINT, "token");
  const token = payload.access_token;
  if (typeof token !== "string" || token.trim() === "") {
    throw new MarketError("INVALID_PAYLOAD", "reddit token response is missing access_token");
  }
  return token.trim();
}

/** Builds the oauth.reddit.com search URL for a normalized query. */
export function buildSearchUrl(query: NormalizedRedditQuery): URL {
  const url = new URL(`https://${API_HOST}${SEARCH_PATH}`);
  url.searchParams.set("q", query.keyword);
  url.searchParams.set("limit", String(query.limit));
  url.searchParams.set("sort", query.sort);
  url.searchParams.set("t", query.timeFilter);
  url.searchParams.set("raw_json", "1");
  return url;
}

async function fetchSearchJson(url: URL, token: string, env: Env): Promise<Record<string, unknown>> {
  const response = await fetchWithRedirects(url, {
    headers: {
      authorization: `bearer ${token}`,
      "user-agent": userAgentFor(env),
      accept: "application/json",
    },
    redirect: "manual",
  });
  return readJsonResponse(response, url.href, "search");
}

function userAgentFor(env: Env): string {
  return env.REDDIT_USER_AGENT?.trim() || DEFAULT_USER_AGENT;
}

async function fetchWithRedirects(start: URL, init: RequestInit): Promise<Response> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchWithTimeout(current.href, init);

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) {
        throw new MarketError("REDIRECT_NO_LOCATION", `redirect from ${current.href} had no location header`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new MarketError("REDIRECT_INVALID_LOCATION", `invalid redirect location from ${current.href}`);
      }
      if (next.pathname.includes("/login")) {
        throw new MarketError("AUTH_ERROR", `reddit redirected to login (${next.pathname}); token is invalid`);
      }
      if (!isRedditHost(next.hostname)) {
        throw new MarketError(
          "REDIRECT_UNTRUSTED",
          `redirect from ${current.href} left reddit.com (${next.hostname})`,
        );
      }
      current = next;
      continue;
    }

    return response;
  }

  throw new MarketError("TOO_MANY_REDIRECTS", `too many redirects resolving ${start.href}`);
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new MarketError("TIMEOUT", `reddit request timed out: ${url}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new MarketError("HTTP_ERROR", `reddit request failed: ${message}`);
  }
  return response;
}

async function readJsonResponse(response: Response, url: string, label: string): Promise<Record<string, unknown>> {
  if (response.status === 429) {
    await response.body?.cancel();
    throw new MarketError("RATE_LIMITED", `reddit ${label} rate limited (HTTP 429) for ${url}`);
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new MarketError("AUTH_ERROR", `reddit ${label} rejected the oauth credentials (HTTP ${response.status}) for ${url}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new MarketError("HTTP_ERROR", `reddit ${label} returned HTTP ${response.status} for ${url}`);
  }

  const text = await readBodyLimited(response);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MarketError("INVALID_PAYLOAD", `reddit ${label} returned malformed JSON for ${url}`);
  }
  const record = asRecord(json);
  if (!record) {
    throw new MarketError("INVALID_PAYLOAD", `reddit ${label} response must be an object`);
  }
  return record;
}

/** Reads a response body, cancelling once the size cap is exceeded. */
async function readBodyLimited(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw tooLargeError();
  }

  if (!response.body) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw tooLargeError();
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
        throw tooLargeError();
      }
      chunks.push(value);
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // best-effort cancel; the original error is preserved
    }
    if (err instanceof MarketError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new MarketError("HTTP_ERROR", `failed to read reddit response: ${message}`);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function tooLargeError(): MarketError {
  return new MarketError("RESPONSE_TOO_LARGE", `reddit response exceeds ${MAX_RESPONSE_BYTES} bytes`);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cacheKeyFor(query: NormalizedRedditQuery): string {
  const parts = [query.sort, query.timeFilter, String(query.limit), query.keyword.toLowerCase()];
  return `${CACHE_PREFIX}${parts.join(":")}`;
}

async function readCache(env: Env, key: string): Promise<RedditSignal[] | undefined> {
  if (!env.SCRAPE_CACHE) return undefined;
  try {
    const raw = await env.SCRAPE_CACHE.get(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed as RedditSignal[];
  } catch {
    return undefined;
  }
}

async function writeCache(env: Env, ctx: ExecutionContext, key: string, signals: RedditSignal[]): Promise<void> {
  if (!env.SCRAPE_CACHE) return;
  ctx.waitUntil(
    env.SCRAPE_CACHE.put(key, JSON.stringify(signals), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => undefined),
  );
}
