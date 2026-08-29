import type { Env } from "../env";
import {
  buildInstagramSignal,
  normalizeInstagramQuery,
  parseInstagramHashtagSearchResponse,
  parseInstagramMediaResponse,
  toInstagramObservationRow,
} from "./instagram-engine";
import { upsertInstagramSignals } from "../supabase/repository";
import {
  MarketError,
  type InstagramHashtag,
  type InstagramMediaCollection,
  type InstagramProvider,
  type InstagramQuery,
  type InstagramSignal,
  type MarketCollectResult,
  type MarketIntelligenceModule,
  type NormalizedInstagramQuery,
} from "./types";

/**
 * Instagram - official Graph API provider and collect module (P3.4).
 *
 * Instagram has an official Graph API for reading public hashtag media from a
 * linked Instagram Business/Creator account. There is no runtime OAuth flow:
 * a long-lived app-user access token for the account is configured as a
 * secret and every request carries it as `access_token`. The provider makes
 * three calls per keyword:
 *
 *   1. GET https://graph.facebook.com/v26.0/{ig-user-id}/hashtag_search
 *      `q=<hashtag>&access_token=<token>` -> the IG hashtag id + name
 *   2. GET https://graph.facebook.com/v26.0/{ig-hashtag-id}/top_media
 *      `fields=id,media_type,caption,timestamp,permalink,like_count,
 *       comments_count,media_url&limit&access_token`
 *      -> most popular media (same methodology as instagram.com)
 *   3. GET https://graph.facebook.com/v26.0/{ig-hashtag-id}/recent_media
 *      (same fields) -> most recent media
 *
 * Access requirements (verified against the official documentation, 2026-08):
 * - the account must be an Instagram Business or Creator account linked via
 *   Facebook Login for Business to a Facebook Page the token's user can
 *   manage; `instagram_basic` permission and the "Instagram Public Content
 *   Access" feature (app review) are required
 * - `INSTAGRAM_ACCESS_TOKEN` is the long-lived app-user access token
 *   (~60 days, refreshed out of band); `INSTAGRAM_IG_USER_ID` is the IG
 *   Business/Creator account id
 *
 * Rate limiting (verified against the official documentation, 2026-08): each
 * IG Business/Creator account may query at most 30 unique hashtags per rolling
 * 7-day period, and fetching media for a tag counts as querying it. The Graph
 * API surfaces this as a typed error the provider maps to `RATE_LIMITED`
 * instead of retrying in a tight loop.
 *
 * Security/reliability posture (mirrors `src/market/youtube.ts`):
 * - fixed host allowlist (`graph.facebook.com`) only
 * - redirects followed manually, host revalidated on every hop, max 5
 * - 15s timeout per hop
 * - ~512KB response-size cap
 * - `429` and Graph error codes 4/17/613 map to `RATE_LIMITED`; codes 190/102
 *   and HTTP 401/403 map to `AUTH_ERROR`; no tight retry loops
 * - optional short-TTL `SCRAPE_CACHE` cache keyed on the normalized query
 *
 * The acquisition mechanism is isolated behind `InstagramProvider`, so the
 * domain model and persistence never depend on how data is fetched.
 */

const API_HOST = "graph.facebook.com";
const GRAPH_API_VERSION = "v26.0";
const HASHTAG_SEARCH_PATH = "hashtag_search";
const TOP_MEDIA_PATH = "top_media";
const RECENT_MEDIA_PATH = "recent_media";
const MEDIA_FIELDS =
  "id,media_type,caption,timestamp,permalink,like_count,comments_count,media_url";
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const CACHE_PREFIX = "market:instagram:";
const CACHE_TTL_SECONDS = 60 * 60;
const DEFAULT_PROVIDER_NAME = "official-api";

/** Graph API error codes treated as token/auth failures. */
const AUTH_ERROR_CODES = new Set([190, 102]);
/** Graph API error codes treated as quota/rate-limit failures. */
const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 613]);

/** True for the Instagram Graph host this provider is allowed to talk to. */
export function isInstagramHost(hostname: string): boolean {
  return hostname.toLowerCase() === API_HOST;
}

/**
 * Resolves the active Instagram provider. Today only the official Graph API
 * provider exists; a future provider would be selected here without touching
 * the domain model.
 */
export function getInstagramProvider(): InstagramProvider {
  return officialApiInstagramProvider;
}

class OfficialApiInstagramProvider implements InstagramProvider {
  readonly name = DEFAULT_PROVIDER_NAME;

  async fetchSignals(query: NormalizedInstagramQuery, env: Env, ctx: ExecutionContext): Promise<InstagramSignal[]> {
    const capturedAt = new Date().toISOString();
    const cacheKey = cacheKeyFor(query);

    const cached = await readCache(env, cacheKey);
    if (cached) return cached;

    const token = env.INSTAGRAM_ACCESS_TOKEN?.trim();
    if (!token) {
      throw new MarketError("INSTAGRAM_NOT_CONFIGURED", "instagram access token (INSTAGRAM_ACCESS_TOKEN) is not configured");
    }
    const igUserId = env.INSTAGRAM_IG_USER_ID?.trim();
    if (!igUserId) {
      throw new MarketError(
        "INSTAGRAM_NOT_CONFIGURED",
        "instagram business account id (INSTAGRAM_IG_USER_ID) is not configured",
      );
    }

    const searchPayload = await fetchJson(buildHashtagSearchUrl(igUserId, query.hashtag, token), env, "hashtag_search");
    const hashtag = parseInstagramHashtagSearchResponse(searchPayload);

    const collection = await fetchMediaCollection(hashtag, query, token, env);

    const signals = [buildInstagramSignal(collection, query, capturedAt)];

    await writeCache(env, ctx, cacheKey, signals);
    return signals;
  }
}

/** Default singleton provider instance. */
export const officialApiInstagramProvider: InstagramProvider = new OfficialApiInstagramProvider();

/**
 * Instagram collect module: normalize -> fetch via the active provider ->
 * persist through the shared repository. Registered in
 * `src/market/registry.ts`.
 */
export const instagramModule: MarketIntelligenceModule<InstagramQuery, InstagramSignal> = {
  source: "instagram",

  async collect(query: InstagramQuery, env: Env, ctx: ExecutionContext): Promise<MarketCollectResult<InstagramSignal>> {
    const normalized = normalizeInstagramQuery(query);
    const provider = getInstagramProvider();
    const signals = await provider.fetchSignals(normalized, env, ctx);

    const persisted = await persistSignals(env, signals);
    const capturedAt = signals[0]?.capturedAt ?? "";

    return {
      source: "instagram",
      provider: provider.name,
      keyword: normalized.keyword,
      geo: "WORLD",
      timeRange: "any",
      property: "media",
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

async function fetchMediaCollection(
  hashtag: InstagramHashtag | null,
  query: NormalizedInstagramQuery,
  token: string,
  env: Env,
): Promise<InstagramMediaCollection> {
  if (!hashtag) {
    return { hashtagId: "", hashtagName: "", topMedia: [], recentMedia: [] };
  }

  const topPayload = await fetchJson(buildTopMediaUrl(hashtag.id, query.limit, token), env, "top_media");
  const recentPayload = await fetchJson(buildRecentMediaUrl(hashtag.id, query.limit, token), env, "recent_media");

  return {
    hashtagId: hashtag.id,
    hashtagName: hashtag.name,
    topMedia: parseInstagramMediaResponse(topPayload),
    recentMedia: parseInstagramMediaResponse(recentPayload),
  };
}

async function persistSignals(
  env: Env,
  signals: InstagramSignal[],
): Promise<{ count: number; created: number; updated: number }> {
  if (signals.length === 0) {
    return { count: 0, created: 0, updated: 0 };
  }

  const rows = signals.map((signal) => toInstagramObservationRow(signal, null));
  const persisted = await upsertInstagramSignals(env, rows);

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

/** Builds the Graph API hashtag_search URL for a normalized query. */
export function buildHashtagSearchUrl(igUserId: string, hashtag: string, token: string): URL {
  const url = new URL(`https://${API_HOST}/${GRAPH_API_VERSION}/${igUserId}/${HASHTAG_SEARCH_PATH}`);
  url.searchParams.set("q", hashtag);
  url.searchParams.set("access_token", token);
  return url;
}

/** Builds the Graph API top_media URL for an IG hashtag id. */
export function buildTopMediaUrl(hashtagId: string, limit: number, token: string): URL {
  const url = new URL(`https://${API_HOST}/${GRAPH_API_VERSION}/${hashtagId}/${TOP_MEDIA_PATH}`);
  url.searchParams.set("fields", MEDIA_FIELDS);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", token);
  return url;
}

/** Builds the Graph API recent_media URL for an IG hashtag id. */
export function buildRecentMediaUrl(hashtagId: string, limit: number, token: string): URL {
  const url = new URL(`https://${API_HOST}/${GRAPH_API_VERSION}/${hashtagId}/${RECENT_MEDIA_PATH}`);
  url.searchParams.set("fields", MEDIA_FIELDS);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", token);
  return url;
}

async function fetchJson(url: URL, _env: Env, label: string): Promise<Record<string, unknown>> {
  const response = await fetchWithRedirects(url, {
    headers: {
      accept: "application/json",
    },
    redirect: "manual",
  });
  return readJsonResponse(response, url.href, label);
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
      if (!isInstagramHost(next.hostname)) {
        throw new MarketError(
          "REDIRECT_UNTRUSTED",
          `redirect from ${current.href} left graph.facebook.com (${next.hostname})`,
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
      throw new MarketError("TIMEOUT", `instagram request timed out: ${url}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new MarketError("HTTP_ERROR", `instagram request failed: ${message}`);
  }
  return response;
}

async function readJsonResponse(response: Response, url: string, label: string): Promise<Record<string, unknown>> {
  if (response.status === 429) {
    await response.body?.cancel();
    throw new MarketError("RATE_LIMITED", `instagram ${label} rate limited (HTTP 429) for ${url}`);
  }

  const text = await readBodyLimited(response);

  if (!response.ok) {
    const info = extractGraphError(text);
    if (info && AUTH_ERROR_CODES.has(info.code)) {
      throw new MarketError("AUTH_ERROR", `instagram ${label} rejected the access token (code ${info.code}) for ${url}`);
    }
    if (info && RATE_LIMIT_ERROR_CODES.has(info.code)) {
      throw new MarketError(
        "RATE_LIMITED",
        `instagram ${label} exceeded a rate limit (code ${info.code}) for ${url}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new MarketError(
        "AUTH_ERROR",
        `instagram ${label} rejected the access token (HTTP ${response.status}) for ${url}`,
      );
    }
    throw new MarketError(
      "HTTP_ERROR",
      `instagram ${label} returned HTTP ${response.status} (graph code ${info?.code ?? "none"}) for ${url}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MarketError("INVALID_PAYLOAD", `instagram ${label} returned malformed JSON for ${url}`);
  }
  const record = asRecord(json);
  if (!record) {
    throw new MarketError("INVALID_PAYLOAD", `instagram ${label} response must be an object`);
  }
  return record;
}

/**
 * Extracts the Graph API error code from a non-2xx payload, if any. Graph
 * errors have the shape `{ "error": { "code": 613, "message": "..." } }`.
 */
function extractGraphError(text: string): { code: number; message: string } | null {
  try {
    const payload = JSON.parse(text) as unknown;
    const root = asRecord(payload);
    const error = asRecord(root?.error);
    if (!error || typeof error.code !== "number" || !Number.isFinite(error.code)) return null;
    const message = typeof error.message === "string" ? error.message : "";
    return { code: Math.floor(error.code), message };
  } catch {
    return null;
  }
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
    throw new MarketError("HTTP_ERROR", `failed to read instagram response: ${message}`);
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
  return new MarketError("RESPONSE_TOO_LARGE", `instagram response exceeds ${MAX_RESPONSE_BYTES} bytes`);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cacheKeyFor(query: NormalizedInstagramQuery): string {
  return `${CACHE_PREFIX}${query.hashtag}:${query.limit}`;
}

async function readCache(env: Env, key: string): Promise<InstagramSignal[] | undefined> {
  if (!env.SCRAPE_CACHE) return undefined;
  try {
    const raw = await env.SCRAPE_CACHE.get(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed as InstagramSignal[];
  } catch {
    return undefined;
  }
}

async function writeCache(env: Env, ctx: ExecutionContext, key: string, signals: InstagramSignal[]): Promise<void> {
  if (!env.SCRAPE_CACHE) return;
  ctx.waitUntil(
    env.SCRAPE_CACHE.put(key, JSON.stringify(signals), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => undefined),
  );
}
