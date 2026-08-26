import type { Env } from "../env";
import { normalizeQuery, parseTimelinePayload, toObservationRow } from "./engine";
import { upsertGoogleTrends } from "../supabase/repository";
import {
  MarketError,
  type GoogleTrendsProvider,
  type GoogleTrendsQuery,
  type GoogleTrendsSignal,
  type MarketCollectResult,
  type MarketIntelligenceModule,
  type NormalizedTrendQuery,
} from "./types";

/**
 * Google Trends - Cloudflare-native provider and collect module (P3.1).
 *
 * There is NO official public Google Trends API. The website serves data
 * through undocumented internal endpoints. This provider talks to those
 * endpoints directly from the Worker - no third-party library, no SaaS, no
 * Python - using a two-request handshake:
 *
 *   1. GET /trends/api/explore  -> widget list with per-widget tokens and an
 *      NID cookie for the follow-up call
 *   2. GET /trends/api/widgetdata/multiline -> `{default:{timelineData:[...]}}`
 *
 * Security/reliability posture (mirrors `src/scrapers/amazon.ts`):
 * - fixed host allowlist (`trends.google.com` and subdomains) only
 * - redirects followed manually, host revalidated on every hop, max 5
 * - 15s timeout per hop
 * - ~512KB response-size cap
 * - `429` maps to `RATE_LIMITED`; no tight retry loops
 * - optional short-TTL `SCRAPE_CACHE` cache keyed on the normalized query
 *
 * The acquisition mechanism is isolated behind `GoogleTrendsProvider`, so the
 * domain model and persistence never depend on how data is fetched.
 */

const TRENDS_API_HOST = "trends.google.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const CACHE_PREFIX = "market:google-trends:";
const CACHE_TTL_SECONDS = 60 * 60;
const DEFAULT_PROVIDER_NAME = "internal-api";

/** True for trends.google.com and any of its subdomains. */
export function isTrendsHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === TRENDS_API_HOST || host.endsWith(`.${TRENDS_API_HOST}`);
}

/**
 * Resolves the active Google Trends provider. Defaults to the Cloudflare
 * native internal-API provider; a future official API or approved provider is
 * selected via the optional `GOOGLE_TRENDS_PROVIDER` env var without changing
 * the domain model.
 */
export function getGoogleTrendsProvider(env: Env): GoogleTrendsProvider {
  const selected = (env.GOOGLE_TRENDS_PROVIDER ?? DEFAULT_PROVIDER_NAME).toLowerCase();
  if (selected === DEFAULT_PROVIDER_NAME) {
    return internalApiTrendsProvider;
  }
  throw new MarketError("PROVIDER_UNAVAILABLE", `unknown google trends provider: ${selected}`);
}

class InternalApiTrendsProvider implements GoogleTrendsProvider {
  readonly name = DEFAULT_PROVIDER_NAME;

  async fetchSignals(query: NormalizedTrendQuery, env: Env, ctx: ExecutionContext): Promise<GoogleTrendsSignal[]> {
    const capturedAt = new Date().toISOString();
    const cacheKey = cacheKeyFor(query);

    const cached = await readCache(env, cacheKey);
    if (cached) return cached;

    const payload = await fetchMultiline(query);
    const signals = parseTimelinePayload(payload, query, capturedAt);

    await writeCache(env, ctx, cacheKey, signals);
    return signals;
  }
}

/** Default singleton provider instance. */
export const internalApiTrendsProvider: GoogleTrendsProvider = new InternalApiTrendsProvider();

/**
 * Google Trends collect module: normalize -> fetch via the active provider ->
 * persist through the shared repository. Registered in `src/market/registry.ts`.
 */
export const googleTrendsModule: MarketIntelligenceModule = {
  source: "google-trends",

  async collect(query: GoogleTrendsQuery, env: Env, ctx: ExecutionContext): Promise<MarketCollectResult> {
    const normalized = normalizeQuery(query);
    const provider = getGoogleTrendsProvider(env);
    const signals = await provider.fetchSignals(normalized, env, ctx);

    const persisted = await persistSignals(env, signals);
    const capturedAt = signals[0]?.capturedAt ?? "";

    return {
      source: "google-trends",
      provider: provider.name,
      keyword: normalized.keyword,
      geo: normalized.geo,
      timeRange: normalized.timeRange,
      property: normalized.property,
      category: normalized.category,
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
  signals: GoogleTrendsSignal[],
): Promise<{ count: number; created: number; updated: number }> {
  if (signals.length === 0) {
    return { count: 0, created: 0, updated: 0 };
  }

  const rows = signals.map((signal) => toObservationRow(signal, null));
  const persisted = await upsertGoogleTrends(env, rows);

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
 * Two-request handshake against the undocumented Google Trends internal API.
 * Returns the raw `widgetdata/multiline` payload for the single requested
 * keyword (see `buildExploreRequest`).
 */
async function fetchMultiline(query: NormalizedTrendQuery): Promise<unknown> {
  const explore = await fetchExplore(query);

  const widget = explore.widgets.find((widget) => widget.id === "TIMESERIES") ?? explore.widgets[0];
  if (!widget) {
    throw new MarketError("INVALID_PAYLOAD", "google trends explore response contained no usable widget");
  }

  const url = new URL(`https://${TRENDS_API_HOST}/trends/api/widgetdata/multiline`);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("tz", "0");
  url.searchParams.set("req", widget.request);
  url.searchParams.set("token", widget.token);

  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/json,text/plain,*/*",
  };
  if (explore.cookie) headers.cookie = explore.cookie;

  const response = await fetchWithRedirects(url, { headers, redirect: "manual" });
  const { json } = await readResponseJson(response, url);
  return json;
}

interface ExploreWidget {
  id: string;
  token: string;
  request: string;
}

async function fetchExplore(query: NormalizedTrendQuery): Promise<{ widgets: ExploreWidget[]; cookie: string | null }> {
  const url = new URL(`https://${TRENDS_API_HOST}/trends/api/explore`);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("tz", "0");
  url.searchParams.set("req", buildExploreRequest(query));

  const response = await fetchWithRedirects(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json,text/plain,*/*",
    },
    redirect: "manual",
  });
  const { json, cookie: headerCookie } = await readResponseJson(response, url);

  const root = asRecord(json);
  if (!root) {
    throw new MarketError("INVALID_PAYLOAD", "google trends explore response must be an object");
  }

  const bodyCookie = typeof root.cookie === "string" && root.cookie.trim() !== "" ? root.cookie : null;
  const widgets = extractWidgets(root.widgets);
  return { widgets, cookie: bodyCookie ?? headerCookie };
}

function extractWidgets(value: unknown): ExploreWidget[] {
  if (!Array.isArray(value)) return [];
  const widgets: ExploreWidget[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    if (typeof record.id !== "string" || typeof record.token !== "string" || record.token.trim() === "") continue;
    let request: string;
    if (typeof record.request === "string" && record.request.trim() !== "") {
      request = record.request;
    } else if (typeof record.request === "object" && record.request !== null) {
      request = JSON.stringify(record.request);
    } else {
      continue;
    }
    widgets.push({ id: record.id, token: record.token, request });
  }
  return widgets;
}

/** Builds the `req` query parameter for the explore request (one keyword). */
export function buildExploreRequest(query: NormalizedTrendQuery): string {
  const req = {
    comparisonItem: [
      {
        keyword: query.keyword,
        geo: query.geo === "WORLD" ? "" : query.geo,
        time: query.timeRange,
        category: query.category ?? 0,
        property: query.property === "web" ? "" : query.property,
      },
    ],
    category: 0,
    property: "",
  };
  return JSON.stringify(req);
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
      if (!isTrendsHost(next.hostname)) {
        throw new MarketError(
          "REDIRECT_UNTRUSTED",
          `redirect from ${current.href} left trends.google.com (${next.hostname})`,
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
      throw new MarketError("TIMEOUT", `google trends request timed out: ${url}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new MarketError("HTTP_ERROR", `google trends request failed: ${message}`);
  }
  return response;
}

interface JsonResponse {
  json: unknown;
  cookie: string | null;
}

async function readResponseJson(response: Response, url: URL): Promise<JsonResponse> {
  if (response.status === 429) {
    await response.body?.cancel();
    throw new MarketError("RATE_LIMITED", `google trends rate limited (HTTP 429) for ${url.href}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new MarketError("HTTP_ERROR", `google trends returned HTTP ${response.status} for ${url.href}`);
  }

  const text = await readBodyLimited(response);
  const cookie = response.headers.get("set-cookie");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MarketError("INVALID_PAYLOAD", `google trends returned malformed JSON for ${url.href}`);
  }
  return { json, cookie };
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
    throw new MarketError("HTTP_ERROR", `failed to read google trends response: ${message}`);
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
  return new MarketError("RESPONSE_TOO_LARGE", `google trends response exceeds ${MAX_RESPONSE_BYTES} bytes`);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cacheKeyFor(query: NormalizedTrendQuery): string {
  const parts = [query.geo, query.property, query.timeRange, String(query.category ?? ""), query.keyword.toLowerCase()];
  return `${CACHE_PREFIX}${parts.join(":")}`;
}

async function readCache(env: Env, key: string): Promise<GoogleTrendsSignal[] | undefined> {
  if (!env.SCRAPE_CACHE) return undefined;
  try {
    const raw = await env.SCRAPE_CACHE.get(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed as GoogleTrendsSignal[];
  } catch {
    return undefined;
  }
}

async function writeCache(env: Env, ctx: ExecutionContext, key: string, signals: GoogleTrendsSignal[]): Promise<void> {
  if (!env.SCRAPE_CACHE) return;
  ctx.waitUntil(
    env.SCRAPE_CACHE.put(key, JSON.stringify(signals), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => undefined),
  );
}
