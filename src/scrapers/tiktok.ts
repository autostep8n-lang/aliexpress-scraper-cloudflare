import type { Env } from "../env";
import { normalizeProduct } from "../products/normalize";
import { parseTiktokPage, type TiktokParsedProduct } from "./tiktok-parser";
import { ScraperError, type ScraperModule, type ScraperResult } from "./types";

/**
 * TikTok Shop scraper.
 *
 * Fetches the public product page (`tiktok.com/@shop/product/<id>` or
 * `shop.tiktok.com/view/product/<id>`, plus short links that redirect to one
 * of those) and parses the embedded SSR JSON. No API key is required. The
 * output is the raw shape accepted by `normalizeProduct`, so the caller can
 * run the shared ingestion pipeline over the result.
 */

const TIKTOK_TLD = "tiktok.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_REDIRECTS = 5;
const CACHE_TTL_SECONDS = 60 * 60;
const CACHE_PREFIX = "scrape:tiktok-shop:";

/** True for tiktok.com and any of its subdomains (vm., shop., m., www.). */
export function isTiktokHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === TIKTOK_TLD || host.endsWith(`.${TIKTOK_TLD}`);
}

/** True for product page paths on the main site and the shop subdomain. */
export function isTiktokProductPath(pathname: string): boolean {
  return pathname.startsWith("/view/product/") || /^\/@[^/]+\/product\//.test(pathname);
}

function isShortLink(url: URL): boolean {
  return url.hostname.toLowerCase() === "vm.tiktok.com" || url.pathname.startsWith("/t/");
}

interface ResolvedPage {
  url: URL;
  html: string;
}

export const tiktokScraper: ScraperModule = {
  platform: "tiktok-shop",
  enabled: true,

  supports(url) {
    if (!isTiktokHost(url.hostname)) return false;
    return isShortLink(url) || isTiktokProductPath(url.pathname);
  },

  async scrape(url, env, ctx) {
    const directCacheKey = isTiktokProductPath(url.pathname) ? cacheKeyFor(url.pathname) : undefined;
    if (directCacheKey) {
      const cached = await readCache(env, directCacheKey);
      if (cached) return toResult(cached, url);
    }

    const resolved = await fetchTiktokPage(url);
    if (!isTiktokProductPath(resolved.url.pathname)) {
      throw new ScraperError(
        "NOT_PRODUCT_PAGE",
        `resolved page is not a TikTok Shop product page: ${resolved.url.href}`,
      );
    }

    const cacheKey = cacheKeyFor(resolved.url.pathname);
    let raw = directCacheKey === cacheKey ? undefined : await readCache(env, cacheKey);
    if (!raw) {
      const parsed = parseTiktokPage(resolved.html, resolved.url);
      raw = buildRawPayload(parsed);
      await writeCache(env, ctx, cacheKey, raw);
    }
    return toResult(raw, resolved.url);
  },
};

function toResult(raw: Record<string, unknown>, resolvedUrl: URL): ScraperResult {
  const product = normalizeProduct({
    raw,
    platform: "tiktok-shop",
    url: resolvedUrl.href,
    scrapedAt: new Date().toISOString(),
  });
  return {
    platform: "tiktok-shop",
    url: resolvedUrl.href,
    title: product.title,
    scrapedAt: product.scrapedAt,
    data: raw,
  };
}

function cacheKeyFor(pathname: string): string {
  return `${CACHE_PREFIX}${pathname}`;
}

function buildRawPayload(parsed: TiktokParsedProduct): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    ...parsed.raw,
    externalId: parsed.externalId,
    title: parsed.title,
    price: parsed.price,
    images: parsed.images,
    attributes: parsed.attributes,
    source: "tiktok-shop",
  };
  if (parsed.description) raw.description = parsed.description;
  if (parsed.category) raw.category = parsed.category;
  if (parsed.rating) raw.rating = parsed.rating;
  if (parsed.shipping) raw.shipping = parsed.shipping;
  if (parsed.available !== undefined) raw.available = parsed.available;
  return raw;
}

async function fetchTiktokPage(start: URL): Promise<ResolvedPage> {
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
      if (!isTiktokHost(next.hostname)) {
        throw new ScraperError(
          "REDIRECT_UNTRUSTED",
          `redirect from ${current.href} left tiktok.com (${next.hostname})`,
        );
      }
      current = next;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new ScraperError("HTTP_ERROR", `TikTok returned HTTP ${response.status} for ${current.href}`);
    }

    const html = await response.text();
    return { url: new URL(response.url || current.href), html };
  }

  throw new ScraperError("TOO_MANY_REDIRECTS", `too many redirects resolving ${start.href}`);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
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
