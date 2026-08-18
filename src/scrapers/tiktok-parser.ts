import { ScraperError } from "./types";
import { isHttpUrl } from "../utils/url";

/**
 * TikTok Shop product pages embed their SSR payload in the HTML as either a
 * `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">`
 * block or a `window.__UNIVERSAL_DATA_FOR_REHYDRATION__ = {...}` /
 * `window.SIGI_STATE = {...}` assignment. This module extracts that JSON,
 * locates the product item, and maps it into the raw shape that
 * `normalizeProduct({ raw, platform: "tiktok-shop", url, scrapedAt })`
 * already accepts. Everything TikTok-specific lives in `attributes` (and the
 * preserved `raw` payload) so the adapter layer stays platform-agnostic.
 */

export interface TiktokPrice {
  amount: number;
  currency: string;
  originalAmount?: number;
}

export interface TiktokImage {
  url: string;
  alt?: string;
}

export interface TiktokCategory {
  id?: string;
  name: string;
  path?: string[];
}

export interface TiktokRating {
  average?: number;
  count?: number;
}

/** Normalized, normalizeProduct-ready interpretation of one TikTok product. */
export interface TiktokParsedProduct {
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
   * The raw product context (the `productInfo`-like object or the item
   * itself). Preserved for `product_sources.raw` so TikTok-specific fields
   * survive even when they have no normalized home.
   */
  raw: Record<string, unknown>;
}

interface ProductItemHit {
  item: Record<string, unknown>;
  parent?: Record<string, unknown>;
  score: number;
}

const BLOCKED_MARKERS = ["access denied", "captcha", "verify you are human", "challenge-platform", "recaptcha"];

/**
 * Parses a TikTok Shop product page into the normalized raw shape. Throws a
 * typed `ScraperError` when the page carries no parseable product data
 * (`NO_PRODUCT_DATA`) or appears to be an anti-bot/challenge page (`BLOCKED`).
 */
export function parseTiktokPage(html: string, url?: URL): TiktokParsedProduct {
  const root = extractSsJson(html);
  if (!root) {
    if (looksBlocked(html)) {
      throw new ScraperError("BLOCKED", "TikTok served a verification or challenge page; no product data available");
    }
    throw new ScraperError("NO_PRODUCT_DATA", "no TikTok SSR product data found in page");
  }

  const hit = findProductItem(root);
  if (!hit) {
    throw new ScraperError("NO_PRODUCT_DATA", "TikTok page did not contain a recognizable product");
  }

  return mapItem(hit, url);
}

/** True when the HTML contains challenge/captcha markers. */
export function looksBlocked(html: string): boolean {
  const lowered = html.toLowerCase();
  return BLOCKED_MARKERS.some((marker) => lowered.includes(marker));
}

function extractSsJson(html: string): unknown {
  for (const candidate of collectJsonCandidates(html)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function collectJsonCandidates(html: string): string[] {
  const candidates: string[] = [];

  const scriptRe = /<script\b[^>]*id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRe)) {
    const content = match[1].trim();
    if (content) candidates.push(content);
  }

  for (const name of ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE"]) {
    const nameRe = new RegExp(`window\\.${name}\\s*=\\s*`, "g");
    for (const match of html.matchAll(nameRe)) {
      const brace = html.indexOf("{", match.index ?? 0);
      if (brace === -1) continue;
      const blob = extractBalancedJson(html, brace);
      if (blob) candidates.push(blob);
    }
  }

  return candidates;
}

/** Extracts a `{...}` JSON blob starting at `startIndex`, honoring strings. */
function extractBalancedJson(source: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(startIndex, i + 1);
    }
  }
  return null;
}

/** Depth-first search for the object that looks most like a product item. */
function findProductItem(root: unknown): ProductItemHit | undefined {
  const hits: ProductItemHit[] = [];
  walk(root, hits);
  hits.sort((a, b) => b.score - a.score);
  const best = hits[0];
  if (!best || best.score < 4) return undefined;
  return best;
}

function walk(node: unknown, out: ProductItemHit[]): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;

  const record = node as Record<string, unknown>;
  const score = itemScore(record);
  if (score > 0) {
    out.push({ item: record, parent: undefined, score });
  }

  for (const child of Object.values(record)) {
    walk(child, out);
  }
}

function itemScore(record: Record<string, unknown>): number {
  let score = 0;
  if (hasString(record, "productId", "product_id")) score += 3;
  if (hasString(record, "title", "productTitle")) score += 2;
  if (hasString(record, "price") || "salePrice" in record || "priceInfo" in record || "minPrice" in record) score += 2;
  if ("itemAvailable" in record || "stock" in record || "soldOut" in record || "images" in record) score += 1;
  return score;
}

function hasString(record: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => {
    const value = record[key];
    return (typeof value === "string" && value.trim().length > 0) || typeof value === "number";
  });
}

function mapItem(hit: ProductItemHit, url?: URL): TiktokParsedProduct {
  const item = hit.item;
  const context = looksLikeProductContext(hit.parent) ? (hit.parent as Record<string, unknown>) : item;

  const externalId =
    firstString(item, ["productId", "product_id", "id"]) ?? externalIdFromUrl(url);
  if (!externalId) {
    throw new ScraperError("NO_PRODUCT_DATA", "product item is missing an id");
  }

  const title = firstString(item, ["title", "productTitle", "name"]);
  if (!title) {
    throw new ScraperError("NO_PRODUCT_DATA", "product item is missing a title");
  }

  const price = parsePrice(item);
  if (!price) {
    throw new ScraperError("NO_PRODUCT_DATA", "product item is missing a price");
  }

  const parsed: TiktokParsedProduct = {
    externalId,
    title,
    price,
    images: parseImages(item),
    attributes: parseAttributes(item),
    raw: context,
  };

  const description = firstString(item, ["description", "productDescription", "subTitle"]);
  if (description) parsed.description = description;

  const category = parseCategory(item);
  if (category) parsed.category = category;

  const rating = parseRating(item);
  if (rating) parsed.rating = rating;

  const shipping = parseShipping(item, price.currency);
  if (shipping) parsed.shipping = shipping;

  const available = parseAvailability(item);
  if (available !== undefined) parsed.available = available;

  return parsed;
}

function looksLikeProductContext(record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  return "item" in record || "productInfo" in record || "seller" in record;
}

function externalIdFromUrl(url?: URL): string | undefined {
  if (!url) return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last && /^\d+$/.test(last) ? last : undefined;
}

function parsePrice(item: Record<string, unknown>): TiktokPrice | undefined {
  const priceInfo = asObject(item.priceInfo);
  const priceObj = asObject(item.price) ?? asObject(item.salePrice);

  const rawCurrency =
    firstString(item, ["currency"]) ??
    firstString(priceInfo ?? {}, ["currency"]) ??
    firstString(priceObj ?? {}, ["currency"]) ??
    "USD";
  const currency = normalizeCurrencyCode(rawCurrency);

  const current =
    numericOf(item.salePrice) ??
    numericOf(item.price) ??
    numericOf(item.minPrice) ??
    numericOf(priceInfo?.price) ??
    numericOf(priceInfo?.salePrice) ??
    numericOf(priceObj?.amount) ??
    numericOf(priceObj?.price);
  if (current === undefined) return undefined;

  const original =
    numericOf(item.compareAtPrice) ??
    numericOf(item.originalPrice) ??
    numericOf(item.originPrice) ??
    numericOf(item.maxPrice) ??
    numericOf(priceInfo?.originalPrice) ??
    numericOf(priceObj?.originalAmount) ??
    numericOf(priceObj?.originalPrice);

  const price: TiktokPrice = { amount: current, currency };
  if (original !== undefined && original > current) price.originalAmount = original;
  return price;
}

function parseImages(item: Record<string, unknown>): TiktokImage[] {
  const images: TiktokImage[] = [];
  const seen = new Set<string>();
  const alt = firstString(item, ["title"]);

  const push = (url: string): void => {
    if (!isHttpUrl(url) || seen.has(url)) return;
    seen.add(url);
    images.push(alt ? { url, alt } : { url });
  };

  const rawImages = item.images;
  if (Array.isArray(rawImages)) {
    for (const entry of rawImages) {
      if (typeof entry === "string") {
        push(entry);
        continue;
      }
      const obj = asObject(entry);
      if (!obj) continue;
      const url = firstString(obj, ["url", "originUrl", "src", "cdnUrl"]);
      if (url) push(url);
      if (Array.isArray(obj.urlList)) {
        for (const u of obj.urlList) if (typeof u === "string") push(u);
      }
    }
  }

  const imageObj = asObject(item.image);
  if (imageObj) {
    const url = firstString(imageObj, ["url", "originUrl", "src"]);
    if (url) push(url);
    if (Array.isArray(imageObj.urlList)) {
      for (const u of imageObj.urlList) if (typeof u === "string") push(u);
    }
  }

  const imagesUrl = item.imagesUrl;
  if (Array.isArray(imagesUrl)) {
    for (const u of imagesUrl) if (typeof u === "string") push(u);
  }

  return images;
}

function parseCategory(item: Record<string, unknown>): TiktokCategory | undefined {
  const categoryObj = asObject(item.category) ?? asObject(item.categoryInfo);
  const name = firstString(item, ["categoryName"]) ?? firstString(categoryObj ?? {}, ["name", "categoryName"]);
  if (!name) return undefined;

  const category: TiktokCategory = { name };
  const id = firstString(item, ["categoryId"]) ?? firstString(categoryObj ?? {}, ["id", "categoryId"]);
  if (id) category.id = id;

  const pathRaw = categoryObj?.path ?? item.categoryPath;
  if (Array.isArray(pathRaw)) {
    const path = pathRaw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    if (path.length > 0) category.path = path;
  }

  return category;
}

function parseRating(item: Record<string, unknown>): TiktokRating | undefined {
  const ratingObj = asObject(item.rating);
  const average =
    numericOf(item.ratingScore) ??
    numericOf(item.avgRating) ??
    numericOf(ratingObj?.ratingScore) ??
    numericOf(ratingObj?.average) ??
    numericOf(ratingObj?.score) ??
    numericOf(ratingObj?.rating);
  const count =
    numericOf(item.ratingCount) ??
    numericOf(item.reviewCount) ??
    numericOf(ratingObj?.ratingCount) ??
    numericOf(ratingObj?.count) ??
    numericOf(ratingObj?.reviewCount);

  if (average === undefined && count === undefined) return undefined;
  const rating: TiktokRating = {};
  if (average !== undefined) rating.average = average;
  if (count !== undefined) rating.count = count;
  return rating;
}

function parseShipping(item: Record<string, unknown>, currency: string): Record<string, unknown> | undefined {
  const shipping = asObject(item.shipping) ?? asObject(item.shippingInfo);
  const out: Record<string, unknown> = {};

  const free = shipping?.free ?? shipping?.isFree ?? item.freeShipping ?? item.isFreeShipping ?? item.shippingFree;
  if (typeof free === "boolean") out.free = free;

  const costRaw =
    numericOf(shipping?.price) ??
    numericOf(shipping?.cost) ??
    numericOf(item.shippingPrice) ??
    numericOf(item.deliveryFee);
  if (costRaw !== undefined) out.cost = { amount: costRaw, currency };

  const minDays =
    numericOf(shipping?.deliveryMinDays) ??
    numericOf(shipping?.minDeliveryDays) ??
    numericOf(item.deliveryMinDays) ??
    numericOf(item.minDeliveryDays);
  const maxDays =
    numericOf(shipping?.deliveryMaxDays) ??
    numericOf(shipping?.maxDeliveryDays) ??
    numericOf(item.deliveryMaxDays) ??
    numericOf(item.maxDeliveryDays);
  if (minDays !== undefined) out.deliveryMinDays = Math.floor(minDays);
  if (maxDays !== undefined) out.deliveryMaxDays = Math.floor(maxDays);

  const fromCountry =
    firstString(shipping ?? {}, ["fromCountry", "countryCode", "shippingFrom"]) ??
    firstString(item, ["fromCountry", "shipFrom", "shipFromCountry"]);
  if (fromCountry) out.fromCountry = fromCountry;

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseAvailability(item: Record<string, unknown>): boolean | undefined {
  const itemAvailable = item.itemAvailable;
  if (typeof itemAvailable === "boolean") return itemAvailable;

  const soldOut = item.soldOut;
  if (typeof soldOut === "boolean") return !soldOut;

  const stock = numericOf(item.stock);
  if (stock !== undefined) return stock > 0;

  const available = item.available;
  if (typeof available === "boolean") return available;

  return undefined;
}

const ATTRIBUTE_FIELDS: ReadonlyArray<[string, string]> = [
  ["sellerId", "sellerId"],
  ["sellerName", "sellerName"],
  ["shopName", "shopName"],
  ["sellerRegion", "sellerRegion"],
  ["sellerLanguage", "sellerLanguage"],
  ["productType", "productType"],
  ["isOfficialStore", "isOfficialStore"],
  ["isOversea", "isOversea"],
  ["itemGroupId", "itemGroupId"],
  ["sales", "sales"],
  ["soldCount", "soldCount"],
  ["reviewCount", "reviewCount"],
  ["itemCategory", "itemCategory"],
  ["productUrl", "productUrl"],
  ["link", "link"],
  ["originStorePrice", "originStorePrice"],
  ["skuId", "skuId"],
  ["itemStatus", "itemStatus"],
  ["isVerified", "isVerified"],
  ["collectionCount", "collectionCount"],
  ["shareCount", "shareCount"],
  ["firstVideoId", "firstVideoId"],
  ["certifications", "productCertifications"],
];

function parseAttributes(item: Record<string, unknown>): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [key, source] of ATTRIBUTE_FIELDS) {
    const value = item[source];
    if (typeof value === "string" && value.trim().length > 0) attributes[key] = value.trim();
    else if (typeof value === "number" && Number.isFinite(value)) attributes[key] = String(value);
    else if (typeof value === "boolean") attributes[key] = String(value);
  }
  return attributes;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function numericOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.\-]/g, "");
    if (cleaned === "" || cleaned === "-") return undefined;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

function normalizeCurrencyCode(value: string): string {
  const match = value.toUpperCase().match(/[A-Z]{3}/);
  return match?.[0] ?? "USD";
}
