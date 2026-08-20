import { ScraperError } from "./types";
import { extractSsJson, findProductItems, looksBlocked, mapItem, type TiktokParsedProduct } from "./tiktok-parser";
import type { TiktokCategory, TiktokImage, TiktokPrice, TiktokRating } from "./tiktok-parser";

/**
 * TikTok Shop search / category pages embed their SSR payload in the same
 * `__UNIVERSAL_DATA_FOR_REHYDRATION__` block as product pages, but carry a
 * LIST of product items instead of a single one. This module extracts that
 * JSON, finds every recognizable product item (reusing the product-page item
 * scoring heuristics), and maps each into the raw shape accepted by
 * `normalizeProduct`. Items that are not real products (videos, ads, or
 * incomplete cards without a numeric id, title, or price) are skipped so the
 * caller only persists genuine products.
 */

export interface TiktokSearchProduct {
  externalId: string;
  title: string;
  description?: string;
  price: TiktokPrice;
  images: TiktokImage[];
  category?: TiktokCategory;
  rating?: TiktokRating;
  shipping?: Record<string, unknown>;
  available?: boolean;
  attributes: Record<string, string>;
  /**
   * The raw search item. Preserved for `product_sources.raw` so TikTok-specific
   * fields survive even when they have no normalized home.
   */
  raw: Record<string, unknown>;
  /** Canonical product page URL that the existing scraper understands. */
  canonicalUrl: string;
}

export interface TiktokSearchPage {
  products: TiktokSearchProduct[];
  /** Best-effort total result count from the SSR payload, when present. */
  total?: number;
}

/**
 * Parses a TikTok Shop search/category page into the list of products it
 * exposes. Throws a typed `ScraperError` when the page carries no parseable
 * SSR data (`NO_PRODUCT_DATA`) or appears to be an anti-bot/challenge page
 * (`BLOCKED`).
 */
export function parseTiktokSearchPage(html: string, searchUrl?: URL): TiktokSearchPage {
  const root = extractSsJson(html);
  if (!root) {
    if (looksBlocked(html)) {
      throw new ScraperError(
        "BLOCKED",
        "TikTok served a verification or challenge page; no search results available",
      );
    }
    throw new ScraperError("NO_PRODUCT_DATA", "no TikTok SSR search data found in page");
  }

  const products: TiktokSearchProduct[] = [];
  const seen = new Set<string>();

  for (const item of findProductItems(root)) {
    const externalId = firstString(item, ["productId", "product_id", "id"]);
    if (!externalId || !/^\d+$/.test(externalId)) continue;
    if (seen.has(externalId)) continue;

    let parsed: TiktokParsedProduct;
    try {
      parsed = mapItem({ item, parent: undefined, score: 0 }, searchUrl);
    } catch {
      // Missing title or price - not a usable product card.
      continue;
    }
    if (parsed.externalId !== externalId) continue;

    seen.add(externalId);
    products.push(toSearchProduct(parsed));
  }

  return { products, total: extractTotal(root, products.length) };
}

function toSearchProduct(parsed: TiktokParsedProduct): TiktokSearchProduct {
  const product: TiktokSearchProduct = {
    externalId: parsed.externalId,
    title: parsed.title,
    price: parsed.price,
    images: parsed.images,
    attributes: parsed.attributes,
    raw: parsed.raw,
    canonicalUrl: canonicalProductUrl(parsed.externalId),
  };
  if (parsed.description) product.description = parsed.description;
  if (parsed.category) product.category = parsed.category;
  if (parsed.rating) product.rating = parsed.rating;
  if (parsed.shipping) product.shipping = parsed.shipping;
  if (parsed.available !== undefined) product.available = parsed.available;
  return product;
}

/** Canonical product page URL accepted by `isTiktokProductPath`. */
function canonicalProductUrl(externalId: string): string {
  return `https://www.tiktok.com/@shop/product/${externalId}`;
}

/**
 * Best-effort total count. Walks the SSR tree for a numeric `total`,
 * `totalProducts`, or `totalCount` that is at least the number of products
 * actually found, and returns the first plausible value. Returns undefined
 * when nothing usable is found.
 */
function extractTotal(root: unknown, found: number): number | undefined {
  const candidates: number[] = [];
  collectTotals(root, candidates);
  for (const value of candidates) {
    if (value >= found) return value;
  }
  return undefined;
}

function collectTotals(node: unknown, out: number[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectTotals(child, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;

  const record = node as Record<string, unknown>;
  for (const key of ["total", "totalProducts", "totalCount"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out.push(value);
    }
  }
  for (const child of Object.values(record)) {
    collectTotals(child, out);
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
