import type { Env } from "../env";
import { normalizeProduct } from "../products/normalize";
import { isBrowserRecoverable } from "./amazon";
import {
  extractItemIdFromPathname,
  isAliExpressHost,
  parseAliExpressPage,
  type AliExpressParsedProduct,
} from "./aliexpress-parser";
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
      // (NO_PRODUCT_DATA). When the Cloudflare Browser Run binding is
      // available, render the page in a real headless Chromium and re-parse
      // the post-JS HTML.
      if (!isBrowserRecoverable(err) || !env.BROWSER) {
        throw err;
      }
      const rendered = await renderAliExpressWithBrowser(env, resolved.url);
      const renderedItemId = extractItemId(rendered.url);
      if (!renderedItemId) {
        throw new ScraperError(
          "NOT_PRODUCT_PAGE",
          `browser-rendered page is not an AliExpress product page: ${rendered.url.href}`,
        );
      }
      raw = buildRawPayload(parseAliExpressPage(rendered.html, { url: rendered.url, itemId: renderedItemId }));
      resolved = rendered;
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
