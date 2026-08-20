import type { Env } from "../env";
import { normalizeProduct } from "../products/normalize";
import type { Product } from "../products/types";
import { fetchTiktokPage, isBrowserRecoverable, renderWithBrowser } from "../scrapers/tiktok";
import { parseTiktokSearchPage, type TiktokSearchPage, type TiktokSearchProduct } from "../scrapers/tiktok-search-parser";
import { upsertProduct } from "../supabase/repository";
import type { DiscoveryModule, DiscoveryQuery, DiscoveryResult, DiscoveredProduct } from "./types";

/**
 * TikTok Shop discovery.
 *
 * Renders the TikTok Shop search/category page for a query (fetch first, then
 * the Cloudflare Browser Run `content` quick action when TikTok serves a
 * challenge page or a client-side-only shell), parses every product card in
 * the SSR payload, and persists each one through the shared ingestion
 * pipeline (`normalizeProduct` + `upsertProduct`). The search page itself is
 * cached briefly in `SCRAPE_CACHE` since results rotate; persisted products
 * are deduplicated by the repository's `(source, external_id)` unique key, so
 * repeat runs refresh instead of duplicating.
 */

const CACHE_PREFIX = "discover:tiktok-shop:";
const CACHE_TTL_SECONDS = 30 * 60;

interface CachedSearch {
  url: string;
  products: TiktokSearchProduct[];
  total?: number;
}

export const tiktokDiscovery: DiscoveryModule = {
  platform: "tiktok-shop",

  async discover(query: DiscoveryQuery, env: Env, ctx: ExecutionContext): Promise<DiscoveryResult> {
    const searchUrl = buildSearchUrl(query);
    const page = await loadSearchPage(searchUrl, env, ctx);

    const discovered: DiscoveredProduct[] = [];
    let created = 0;
    let updated = 0;
    let failed = 0;

    for (const item of page.products.slice(0, query.limit)) {
      const outcome = await persistSearchProduct(item, env);
      switch (outcome.persisted.status) {
        case "created":
          created++;
          break;
        case "updated":
          updated++;
          break;
        default:
          failed++;
          break;
      }
      discovered.push(outcome);
    }

    return {
      platform: "tiktok-shop",
      query: query.query,
      category: query.category,
      region: query.region,
      requested: query.limit,
      discovered: page.products.length,
      persisted: created + updated,
      created,
      updated,
      failed,
      products: discovered,
    };
  },
};

function buildSearchUrl(query: DiscoveryQuery): URL {
  const url = new URL("https://www.tiktok.com/search/shop");
  if (query.query) url.searchParams.set("q", query.query);
  if (query.category) url.searchParams.set("category_id", query.category);
  if (query.region) url.searchParams.set("region", query.region);
  return url;
}

async function loadSearchPage(url: URL, env: Env, ctx: ExecutionContext): Promise<TiktokSearchPage> {
  const cacheKey = cacheKeyFor(url);
  const cached = await readCache(env, cacheKey);
  if (cached) {
    return { products: cached.products, total: cached.total };
  }

  let page: TiktokSearchPage;
  try {
    const resolved = await fetchTiktokPage(url);
    page = parseTiktokSearchPage(resolved.html, resolved.url);
  } catch (err) {
    if (!isBrowserRecoverable(err) || !env.BROWSER) {
      throw err;
    }
    const rendered = await renderWithBrowser(env, url);
    page = parseTiktokSearchPage(rendered.html, rendered.url);
  }

  await writeCache(env, ctx, cacheKey, { products: page.products, total: page.total, url: url.href });
  return page;
}

async function persistSearchProduct(
  item: TiktokSearchProduct,
  env: Env,
): Promise<DiscoveredProduct> {
  const raw = buildRawPayload(item);
  let product: Product;
  try {
    product = normalizeProduct({
      raw,
      platform: "tiktok-shop",
      url: item.canonicalUrl,
      scrapedAt: new Date().toISOString(),
    });
  } catch {
    return {
      raw,
      persisted: { status: "invalid", message: "discovered product could not be normalized" },
    };
  }

  const persisted = await upsertProduct(env, product, { raw });
  return { product, raw, persisted };
}

/**
 * Raw payload stored on `product_sources.raw`, mirroring the product-page
 * scraper so discovery and scrape observations look consistent.
 */
function buildRawPayload(item: TiktokSearchProduct): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    ...item.raw,
    externalId: item.externalId,
    title: item.title,
    price: item.price,
    images: item.images,
    attributes: item.attributes,
    source: "tiktok-shop",
  };
  if (item.description) raw.description = item.description;
  if (item.category) raw.category = item.category;
  if (item.rating) raw.rating = item.rating;
  if (item.shipping) raw.shipping = item.shipping;
  if (item.available !== undefined) raw.available = item.available;
  return raw;
}

function cacheKeyFor(url: URL): string {
  const params = new URLSearchParams();
  const q = url.searchParams.get("q");
  const category = url.searchParams.get("category_id");
  const region = url.searchParams.get("region");
  if (q) params.set("q", q);
  if (category) params.set("category_id", category);
  if (region) params.set("region", region);
  const suffix = params.toString() || "all";
  return `${CACHE_PREFIX}${suffix}`;
}

async function readCache(env: Env, key: string): Promise<CachedSearch | undefined> {
  if (!env.SCRAPE_CACHE) return undefined;
  try {
    const value = await env.SCRAPE_CACHE.get(key);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as CachedSearch;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.url === "string" &&
      Array.isArray(parsed.products)
    ) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(env: Env, ctx: ExecutionContext, key: string, value: CachedSearch): Promise<void> {
  if (!env.SCRAPE_CACHE) return;
  ctx.waitUntil(
    env.SCRAPE_CACHE.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => undefined),
  );
}
