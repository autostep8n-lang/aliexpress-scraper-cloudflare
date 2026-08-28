import type { Env } from "../env";
import {
  buildYouTubeSignal,
  normalizeYouTubeQuery,
  parseYouTubeSearchResponse,
  parseYouTubeVideosResponse,
  publishedAfterFor,
  toYouTubeObservationRow,
} from "./youtube-engine";
import { upsertYouTubeSignals } from "../supabase/repository";
import {
  MarketError,
  type MarketCollectResult,
  type MarketIntelligenceModule,
  type NormalizedYouTubeQuery,
  type YouTubeProvider,
  type YouTubeQuery,
  type YouTubeSignal,
  type YouTubeVideoStatistics,
} from "./types";

/**
 * YouTube - official Data API v3 provider and collect module (P3.3).
 *
 * YouTube has an official REST API that needs no OAuth for public reads: every
 * request carries the API key as a `key` query parameter. The provider makes
 * exactly two calls per keyword:
 *
 *   1. GET https://www.googleapis.com/youtube/v3/search
 *      `part=snippet&type=video&q=<keyword>&maxResults&order&publishedAfter&key`
 *      -> video metadata (title, channel, publish date) + total match count
 *   2. GET https://www.googleapis.com/youtube/v3/videos
 *      `part=statistics&id=<up to 50 video ids>&key`
 *      -> view/like/comment counts for the fetched videos
 *
 * Quota (verified against Google's official documentation, 2026-06-01):
 * - `search.list` costs 1 unit per call but is limited to 100 calls/day by a
 *   dedicated "Search Queries" bucket.
 * - `videos.list` costs 1 unit per call against the combined 10,000
 *   units/day bucket.
 * - Exhausting either quota returns HTTP 403 with error reason
 *   `quotaExceeded`, which this provider maps to a typed `QUOTA_EXCEEDED`
 *   error instead of retrying in a tight loop.
 *
 * Security/reliability posture (mirrors `src/market/reddit.ts`):
 * - fixed host allowlist (`www.googleapis.com`) only
 * - redirects followed manually, host revalidated on every hop, max 5
 * - 15s timeout per hop
 * - ~512KB response-size cap
 * - `429` maps to `RATE_LIMITED`; `401`/`403` and invalid-key `400`s map to
 *   `AUTH_ERROR`; `403 quotaExceeded` maps to `QUOTA_EXCEEDED`; no tight
 *   retry loops
 * - optional short-TTL `SCRAPE_CACHE` cache keyed on the normalized query
 *
 * The acquisition mechanism is isolated behind `YouTubeProvider`, so the domain
 * model and persistence never depend on how data is fetched.
 */

const API_HOST = "www.googleapis.com";
const SEARCH_PATH = "/youtube/v3/search";
const VIDEOS_PATH = "/youtube/v3/videos";
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_VIDEO_IDS_PER_REQUEST = 50;
const CACHE_PREFIX = "market:youtube:";
const CACHE_TTL_SECONDS = 60 * 60;
const DEFAULT_PROVIDER_NAME = "official-api";

/** True for the Google host this provider is allowed to talk to. */
export function isYouTubeHost(hostname: string): boolean {
  return hostname.toLowerCase() === API_HOST;
}

/**
 * Resolves the active YouTube provider. Today only the official Data API v3
 * provider exists; a future provider would be selected here without touching
 * the domain model.
 */
export function getYouTubeProvider(): YouTubeProvider {
  return officialApiYouTubeProvider;
}

class OfficialApiYouTubeProvider implements YouTubeProvider {
  readonly name = DEFAULT_PROVIDER_NAME;

  async fetchSignals(query: NormalizedYouTubeQuery, env: Env, ctx: ExecutionContext): Promise<YouTubeSignal[]> {
    const capturedAt = new Date().toISOString();
    const cacheKey = cacheKeyFor(query);

    const cached = await readCache(env, cacheKey);
    if (cached) return cached;

    const apiKey = env.YOUTUBE_API_KEY?.trim();
    if (!apiKey) {
      throw new MarketError("YOUTUBE_NOT_CONFIGURED", "youtube api key (YOUTUBE_API_KEY) is not configured");
    }

    const nowMs = Date.now();
    const searchUrl = buildSearchUrl(query, apiKey, nowMs);
    const searchPayload = await fetchJson(searchUrl, env, "search");
    const search = parseYouTubeSearchResponse(searchPayload, query);

    const statistics: Record<string, YouTubeVideoStatistics> = {};
    if (search.items.length > 0) {
      const videosUrl = buildVideosUrl(
        search.items.map((item) => item.id),
        apiKey,
      );
      const videosPayload = await fetchJson(videosUrl, env, "videos");
      Object.assign(statistics, parseYouTubeVideosResponse(videosPayload));
    }

    const signals = [buildYouTubeSignal(search, statistics, query, capturedAt)];

    await writeCache(env, ctx, cacheKey, signals);
    return signals;
  }
}

/** Default singleton provider instance. */
export const officialApiYouTubeProvider: YouTubeProvider = new OfficialApiYouTubeProvider();

/**
 * YouTube collect module: normalize -> fetch via the active provider -> persist
 * through the shared repository. Registered in `src/market/registry.ts`.
 */
export const youtubeModule: MarketIntelligenceModule<YouTubeQuery, YouTubeSignal> = {
  source: "youtube",

  async collect(query: YouTubeQuery, env: Env, ctx: ExecutionContext): Promise<MarketCollectResult<YouTubeSignal>> {
    const normalized = normalizeYouTubeQuery(query);
    const provider = getYouTubeProvider();
    const signals = await provider.fetchSignals(normalized, env, ctx);

    const persisted = await persistSignals(env, signals);
    const capturedAt = signals[0]?.capturedAt ?? "";

    return {
      source: "youtube",
      provider: provider.name,
      keyword: normalized.keyword,
      geo: "WORLD",
      timeRange: normalized.publishedWithin,
      property: "videos",
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
  signals: YouTubeSignal[],
): Promise<{ count: number; created: number; updated: number }> {
  if (signals.length === 0) {
    return { count: 0, created: 0, updated: 0 };
  }

  const rows = signals.map((signal) => toYouTubeObservationRow(signal, null));
  const persisted = await upsertYouTubeSignals(env, rows);

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

/** Builds the youtube.com API search URL for a normalized query. */
export function buildSearchUrl(query: NormalizedYouTubeQuery, apiKey: string, nowMs: number): URL {
  const url = new URL(`https://${API_HOST}${SEARCH_PATH}`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("q", query.keyword);
  url.searchParams.set("maxResults", String(query.limit));
  url.searchParams.set("order", query.order);
  url.searchParams.set("key", apiKey);
  const publishedAfter = publishedAfterFor(query.publishedWithin, nowMs);
  if (publishedAfter) {
    url.searchParams.set("publishedAfter", publishedAfter);
  }
  return url;
}

/** Builds the videos.list statistics URL for up to 50 video ids. */
export function buildVideosUrl(ids: string[], apiKey: string): URL {
  const url = new URL(`https://${API_HOST}${VIDEOS_PATH}`);
  url.searchParams.set("part", "statistics");
  url.searchParams.set("id", ids.slice(0, MAX_VIDEO_IDS_PER_REQUEST).join(","));
  url.searchParams.set("key", apiKey);
  return url;
}

async function fetchJson(url: URL, env: Env, label: string): Promise<Record<string, unknown>> {
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
      if (!isYouTubeHost(next.hostname)) {
        throw new MarketError(
          "REDIRECT_UNTRUSTED",
          `redirect from ${current.href} left www.googleapis.com (${next.hostname})`,
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
      throw new MarketError("TIMEOUT", `youtube request timed out: ${url}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new MarketError("HTTP_ERROR", `youtube request failed: ${message}`);
  }
  return response;
}

async function readJsonResponse(response: Response, url: string, label: string): Promise<Record<string, unknown>> {
  if (response.status === 429) {
    await response.body?.cancel();
    throw new MarketError("RATE_LIMITED", `youtube ${label} rate limited (HTTP 429) for ${url}`);
  }
  if (response.status === 401) {
    await response.body?.cancel();
    throw new MarketError("AUTH_ERROR", `youtube ${label} rejected the api key (HTTP 401) for ${url}`);
  }
  if (response.status === 403) {
    const reason = await readErrorReason(response);
    if (reason === "quotaExceeded") {
      throw new MarketError("QUOTA_EXCEEDED", `youtube ${label} exceeded the daily quota for ${url}`);
    }
    throw new MarketError(
      "AUTH_ERROR",
      `youtube ${label} rejected the api key (HTTP 403, reason ${reason ?? "forbidden"}) for ${url}`,
    );
  }
  if (response.status === 400) {
    const reason = await readErrorReason(response);
    if (reason === "keyInvalid" || reason === "keyMissing") {
      throw new MarketError("AUTH_ERROR", `youtube ${label} rejected the api key (HTTP 400, reason ${reason}) for ${url}`);
    }
    await response.body?.cancel();
    throw new MarketError("HTTP_ERROR", `youtube ${label} returned HTTP 400 (reason ${reason ?? "badRequest"}) for ${url}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new MarketError("HTTP_ERROR", `youtube ${label} returned HTTP ${response.status} for ${url}`);
  }

  const text = await readBodyLimited(response);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MarketError("INVALID_PAYLOAD", `youtube ${label} returned malformed JSON for ${url}`);
  }
  const record = asRecord(json);
  if (!record) {
    throw new MarketError("INVALID_PAYLOAD", `youtube ${label} response must be an object`);
  }
  return record;
}

/** Extracts the API error `reason` from a non-2xx Google API payload, if any. */
async function readErrorReason(response: Response): Promise<string | null> {
  try {
    const text = await readBodyLimited(response);
    const payload = JSON.parse(text) as unknown;
    const root = asRecord(payload);
    const error = asRecord(root?.error);
    const errors = error?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const first = asRecord(errors[0]);
      if (first && typeof first.reason === "string" && first.reason !== "") {
        return first.reason;
      }
    }
    return null;
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
    throw new MarketError("HTTP_ERROR", `failed to read youtube response: ${message}`);
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
  return new MarketError("RESPONSE_TOO_LARGE", `youtube response exceeds ${MAX_RESPONSE_BYTES} bytes`);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cacheKeyFor(query: NormalizedYouTubeQuery): string {
  const parts = [query.order, query.publishedWithin, String(query.limit), query.keyword.toLowerCase()];
  return `${CACHE_PREFIX}${parts.join(":")}`;
}

async function readCache(env: Env, key: string): Promise<YouTubeSignal[] | undefined> {
  if (!env.SCRAPE_CACHE) return undefined;
  try {
    const raw = await env.SCRAPE_CACHE.get(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed as YouTubeSignal[];
  } catch {
    return undefined;
  }
}

async function writeCache(env: Env, ctx: ExecutionContext, key: string, signals: YouTubeSignal[]): Promise<void> {
  if (!env.SCRAPE_CACHE) return;
  ctx.waitUntil(
    env.SCRAPE_CACHE.put(key, JSON.stringify(signals), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => undefined),
  );
}
