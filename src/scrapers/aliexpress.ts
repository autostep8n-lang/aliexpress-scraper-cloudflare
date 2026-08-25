import type { Env } from "../env";
import { normalizeProduct } from "../products/normalize";
import { isBrowserRecoverable } from "./amazon";
import {
  extractItemIdFromPathname,
  isAliExpressHost,
  parseAliExpressPage,
  type AliExpressParsedProduct,
} from "./aliexpress-parser";
import { fetchAliExpressProductMtop } from "./aliexpress-mtop";
import { fetchAliExpressProductOpenApi, hasOpenApiCredentials } from "./aliexpress-openapi";
import { ScraperError, type ScraperModule, type ScraperResult } from "./types";

export { isAliExpressHost };

/**
 * AliExpress scraper.
 *
 * Fetches the public product page (`aliexpress.com/item/<itemId>.html` or the
 * regional `aliexpress.<tld>` equivalents) and parses the embedded runParams /
 * RDS JSON modules (with JSON-LD and HTML fallbacks). No API key is required.
 * The output is the raw shape accepted by `normalizeProduct`, so the caller
 * can run the shared ingestion pipeline over the result. AliExpress identity
 * is the numeric item id throughout, so deduplication keeps working as
 * `aliexpress:<itemId>`.
 *
 * AliExpress no longer serves server-side product data for many pages: the
 * HTML is a client-side-rendered shell and the browser would fetch the payload
 * from the internal mtop gateway. Because AliExpress's anti-bot also punishes
 * headless browsers (including Cloudflare Browser Run - `_____tmd_____/punish`),
 * the recovery path prefers providers that need no browser:
 *
 *   1. Official Open Platform API (`aliexpress.ds.product.get`) when
 *      `ALIEXPRESS_OPENAPI_KEY` / `ALIEXPRESS_OPENAPI_SECRET` are configured.
 *   2. The mtop gateway (`acs.aliexpress.com`) - the same endpoint the website
 *      itself uses; works from a plain HTTP client with a token bootstrap.
 *   3. Cloudflare Browser Run as a last resort (fundamentally blocked by
 *      AliExpress, but kept as a fallback for other bot surfaces).
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_REDIRECTS = 5;
const CACHE_TTL_SECONDS = 60 * 60;
const CACHE_PREFIX = "scrape:aliexpress:";

/** The item id carried by an AliExpress product URL. */
export function extractItemId(url: URL): string | undefined {
  return extractItemIdFromPathname(url.pathname);
}

export interface ResolvedPage {
  url: URL;
  html: string;
}

export const aliexpressScraper: ScraperModule = {
  platform: "aliexpress",
  enabled: true,

  supports(url) {
    if (!isAliExpressHost(url.hostname)) return false;
    return extractItemId(url) !== undefined;
  },

  async scrape(url, env, ctx) {
    const itemId = extractItemId(url);
    if (!itemId) {
      throw new ScraperError("NOT_PRODUCT_PAGE", `not an AliExpress product URL: ${url.href}`);
    }

    const cacheKey = cacheKeyFor(url.hostname, itemId);
    const cached = await readCache(env, cacheKey);
    if (cached) return toResult(cached, url);

    let resolved = await fetchAliExpressPage(url);
    const resolvedItemId = extractItemId(resolved.url);
    if (!resolvedItemId) {
      throw new ScraperError(
        "NOT_PRODUCT_PAGE",
        `resolved page is not an AliExpress product page: ${resolved.url.href}`,
      );
    }

    let raw: Record<string, unknown>;
    try {
      raw = buildRawPayload(parseAliExpressPage(resolved.html, { url: resolved.url, itemId: resolvedItemId }));
    } catch (err) {
      // AliExpress serves datacenter-originated plain fetches an anti-bot
      // challenge page (BLOCKED) or a client-side-only shell
      // (NO_PRODUCT_DATA) whose payload lives behind the internal mtop
      // gateway. Recover by querying the no-browser providers first and only
      // fall back to Cloudflare Browser Run as a last resort.
      if (!isBrowserRecoverable(err)) {
        throw err;
      }
      const originalError = err as ScraperError;
      const parsed = await fetchAliExpressProductWithFallbacks(env, resolved.url, resolvedItemId, originalError);
      const canonical = canonicalProductUrl(parsed);
      if (canonical) {
        try {
          resolved = { url: new URL(canonical), html: resolved.html };
        } catch {
          // Malformed canonical URL - keep the resolved page URL.
        }
      }
      raw = buildRawPayload(parsed);
    }

    await writeCache(env, ctx, cacheKey, raw);
    return toResult(raw, resolved.url);
  },
};

function toResult(raw: Record<string, unknown>, resolvedUrl: URL): ScraperResult {
  const product = normalizeProduct({
    raw,
    platform: "aliexpress",
    url: resolvedUrl.href,
    scrapedAt: new Date().toISOString(),
  });
  return {
    platform: "aliexpress",
    url: resolvedUrl.href,
    title: product.title,
    scrapedAt: product.scrapedAt,
    data: raw,
  };
}

function cacheKeyFor(hostname: string, itemId: string): string {
  return `${CACHE_PREFIX}${hostname.toLowerCase()}:${itemId}`;
}

function buildRawPayload(parsed: AliExpressParsedProduct): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    ...parsed.raw,
    externalId: parsed.itemId,
    title: parsed.title,
    price: parsed.price,
    images: parsed.images,
    attributes: parsed.attributes,
    source: "aliexpress",
  };
  if (parsed.description) raw.description = parsed.description;
  if (parsed.category) raw.category = parsed.category;
  if (parsed.rating) raw.rating = parsed.rating;
  if (parsed.availability !== undefined) raw.available = parsed.availability;
  return raw;
}

/**
 * Recovers a `BLOCKED` / `NO_PRODUCT_DATA` page by querying the no-browser
 * AliExpress providers in order, then the browser as a last resort. Returns the
 * first successfully parsed product, or throws a typed error describing the
 * most precise failure (an anti-bot `BLOCKED`/`NO_PRODUCT_DATA` from any
 * provider wins over transient provider errors).
 *
 * The Open Platform provider is STRICTLY OPTIONAL: it is only attempted when
 * credentials are configured, and when it fails the loop falls through to the
 * credential-free mtop gateway. The scraper never requires
 * `ALIEXPRESS_OPENAPI_KEY` / `ALIEXPRESS_OPENAPI_SECRET` to function.
 */
async function fetchAliExpressProductWithFallbacks(
  env: Env,
  url: URL,
  itemId: string,
  originalError: ScraperError,
): Promise<AliExpressParsedProduct> {
  const attempts: Array<() => Promise<AliExpressParsedProduct>> = [];
  if (hasOpenApiCredentials(env)) {
    attempts.push(() => fetchAliExpressProductOpenApi(env, itemId, url));
  }
  attempts.push(() => fetchAliExpressProductMtop(itemId, url));

  const errors: ScraperError[] = [];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof ScraperError) {
        errors.push(err);
        continue;
      }
      throw err;
    }
  }

  if (env.BROWSER) {
    try {
      const rendered = await renderAliExpressWithBrowser(env, url);
      if (looksLikePunishPage(rendered.url.href, rendered.html)) {
        throw new ScraperError(
          "BLOCKED",
          "AliExpress redirected the headless browser to its anti-bot punish page (_____tmd_____/punish); no product data available",
        );
      }
      const renderedItemId = extractItemId(rendered.url);
      if (!renderedItemId) {
        throw new ScraperError(
          "NOT_PRODUCT_PAGE",
          `browser-rendered page is not an AliExpress product page: ${rendered.url.href}`,
        );
      }
      return parseAliExpressPage(rendered.html, { url: rendered.url, itemId: renderedItemId });
    } catch (err) {
      if (err instanceof ScraperError) {
        errors.push(err);
      } else {
        throw err;
      }
    }
  }

  throw selectFallbackError(originalError, errors);
}

/** A `BLOCKED`/`NO_PRODUCT_DATA` from a provider is more precise than the page error. */
function selectFallbackError(originalError: ScraperError, errors: ScraperError[]): ScraperError {
  const definitive = errors.find((err) => err.code === "BLOCKED" || err.code === "NO_PRODUCT_DATA");
  return definitive ?? originalError;
}

/** The canonical product URL carried by a parsed product, if any. */
function canonicalProductUrl(parsed: AliExpressParsedProduct): string | undefined {
  const productUrl = typeof parsed.raw?.["productUrl"] === "string" ? parsed.raw["productUrl"] : undefined;
  if (productUrl) return productUrl;
  if (/^\d{6,20}$/.test(parsed.itemId)) {
    return `https://www.aliexpress.com/item/${parsed.itemId}.html`;
  }
  return undefined;
}

/** True when a URL or HTML looks like AliExpress's anti-bot punish page. */
export function looksLikePunishPage(url: string, html: string): boolean {
  return /_____tmd_____|(^|[\/_.-])punish([\/?]|$)/i.test(url) || /_____tmd_____|RGV587_ERROR|x5sec/i.test(html);
}

export async function fetchAliExpressPage(start: URL): Promise<ResolvedPage> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current.href, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "manual",
    });

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) {
        throw new ScraperError("REDIRECT_NO_LOCATION", `redirect from ${current.href} had no location header`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new ScraperError("REDIRECT_INVALID_LOCATION", `invalid redirect location from ${current.href}`);
      }
      if (!isAliExpressHost(next.hostname)) {
        throw new ScraperError(
          "REDIRECT_UNTRUSTED",
          `redirect from ${current.href} left aliexpress.com (${next.hostname})`,
        );
      }
      current = next;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new ScraperError("HTTP_ERROR", `AliExpress returned HTTP ${response.status} for ${current.href}`);
    }

    const html = await response.text();
    return { url: new URL(response.url || current.href), html };
  }

  throw new ScraperError("TOO_MANY_REDIRECTS", `too many redirects resolving ${start.href}`);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Minimal shape of the Browser Run `content` quick action JSON response. */
interface BrowserRenderedContent {
  success?: boolean;
  result?: string;
  meta?: {
    finalUrl?: string;
    status?: number;
    title?: string;
  };
  errors?: Array<{ code?: number; message?: string }>;
}

/**
 * Renders a product page in Cloudflare's headless Chromium (Browser Run
 * `content` quick action) and returns the post-JavaScript HTML plus the final
 * URL the browser resolved to. Throws a typed `BLOCKED` ScraperError when the
 * render fails or returns nothing, preserving the existing error surface.
 */
async function renderAliExpressWithBrowser(env: Env, url: URL): Promise<ResolvedPage> {
  if (!env.BROWSER) {
    throw new ScraperError(
      "BLOCKED",
      "AliExpress served an anti-bot check page; no product data available",
    );
  }

  let response: Response;
  try {
    response = await env.BROWSER.quickAction("content", {
      url: url.href,
      userAgent: USER_AGENT,
      setExtraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
      gotoOptions: { waitUntil: "networkidle2", timeout: 45000 },
      bestAttempt: true,
      cacheTTL: 0,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ScraperError(
      "BLOCKED",
      `AliExpress served an anti-bot check page and browser rendering failed: ${detail}`,
    );
  }

  const payload = (await response.json().catch(() => undefined)) as BrowserRenderedContent | undefined;
  if (!payload || payload.success !== true || typeof payload.result !== "string" || payload.result.length === 0) {
    throw new ScraperError(
      "BLOCKED",
      "AliExpress served an anti-bot check page; browser rendering returned no product data",
    );
  }

  let resolved = url;
  const finalUrl = payload.meta?.finalUrl;
  if (finalUrl) {
    try {
      const parsed = new URL(finalUrl);
      if (isAliExpressHost(parsed.hostname)) resolved = parsed;
    } catch {
      // Malformed final URL - keep the requested URL.
    }
  }

  return { url: resolved, html: payload.result };
}

async function readCache(env: Env, key: string): Promise<Record<string, unknown> | undefined> {
  if (!env.SCRAPE_CACHE) return undefined;
  try {
    const value = await env.SCRAPE_CACHE.get(key);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(env: Env, ctx: ExecutionContext, key: string, raw: Record<string, unknown>): Promise<void> {
  if (!env.SCRAPE_CACHE) return;
  ctx.waitUntil(
    env.SCRAPE_CACHE.put(key, JSON.stringify(raw), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => undefined),
  );
}
