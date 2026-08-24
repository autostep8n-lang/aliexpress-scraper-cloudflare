import { ScraperError } from "./types";
import { isHttpUrl } from "../utils/url";

/**
 * Amazon product page parser.
 *
 * Amazon embeds structured product data as JSON-LD (`application/ld+json`)
 * blocks (a `Product` graph, a `BreadcrumbList` graph, ...). This module
 * prefers those reliable blocks, then falls back to stable page metadata and
 * a small set of long-lived HTML selectors only when structured data is
 * absent. Values are never fabricated: fields that cannot be derived are
 * simply omitted, and the page is rejected with a typed error only when the
 * ASIN, title or price cannot be determined.
 */

export interface AmazonPrice {
  amount: number;
  currency: string;
  originalAmount?: number;
}

export interface AmazonImage {
  url: string;
  alt?: string;
}

export interface AmazonCategory {
  id?: string;
  name: string;
  path?: string[];
}

export interface AmazonRating {
  average?: number;
  count?: number;
}

/** normalizeProduct-ready interpretation of one Amazon product page. */
export interface AmazonParsedProduct {
  asin: string;
  title: string;
  description?: string;
  price: AmazonPrice;
  images: AmazonImage[];
  category?: AmazonCategory;
  rating?: AmazonRating;
  availability?: boolean;
  seller?: string;
  brand?: string;
  attributes: Record<string, string>;
  /**
   * The parsed JSON-LD `Product` graph. Preserved for `product_sources.raw`
   * so Amazon-specific fields survive even when they have no normalized home.
   */
  raw: Record<string, unknown>;
}

/** Optional context passed in by the caller (the adapter). */
export interface AmazonParseHint {
  url?: URL;
  asin?: string;
}

/** Amazon ASIN: exactly 10 uppercase alphanumeric characters. */
const ASIN_RE = /^[A-Z0-9]{10}$/;

/** Product page path prefixes: `/dp/<ASIN>`, `/gp/product/<ASIN>`, ... */
const AMAZON_PRODUCT_PATH_RE = /^\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Za-z0-9]{10})(?:\/|$)/;

/** True for product page paths carrying a (possibly lowercase) ASIN segment. */
export function isAmazonProductPath(pathname: string): boolean {
  return AMAZON_PRODUCT_PATH_RE.test(pathname);
}

/** Extracts and normalizes (uppercases) the ASIN from a product pathname. */
export function extractAsinFromPathname(pathname: string): string | undefined {
  const match = AMAZON_PRODUCT_PATH_RE.exec(pathname);
  if (!match) return undefined;
  const asin = match[1].toUpperCase();
  return ASIN_RE.test(asin) ? asin : undefined;
}

const CURRENCY_BY_DOMAIN: Record<string, string> = {
  "amazon.com": "USD",
  "amazon.co.uk": "GBP",
  "amazon.de": "EUR",
  "amazon.fr": "EUR",
  "amazon.it": "EUR",
  "amazon.es": "EUR",
  "amazon.ca": "CAD",
};

/** Deterministic currency for a supported Amazon host (USD when unknown). */
export function currencyForHost(hostname: string | undefined): string | undefined {
  if (!hostname) return undefined;
  const host = hostname.toLowerCase();
  for (const [domain, currency] of Object.entries(CURRENCY_BY_DOMAIN)) {
    if (host === domain || host.endsWith(`.${domain}`)) return currency;
  }
  return undefined;
}

const BLOCKED_MARKERS = [
  "robot check",
  "enter the characters you see below",
  "verify you are human",
  "captcha",
  "automated access",
  "api-services-support",
  "sorry, we just need to make sure you",
];

/** True when the HTML looks like Amazon's bot/captcha check page. */
export function looksBlocked(html: string): boolean {
  const lowered = html.toLowerCase();
  return BLOCKED_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Parses an Amazon product page into the normalize-ready shape. Throws a
 * typed `ScraperError` when the page carries no parseable product data
 * (`NO_PRODUCT_DATA`) or appears to be a bot/captcha check page (`BLOCKED`).
 */
export function parseAmazonPage(html: string, hint: AmazonParseHint = {}): AmazonParsedProduct {
  if (looksBlocked(html)) {
    throw new ScraperError("BLOCKED", "Amazon served a robot/captcha check page; no product data available");
  }

  const ld = extractJsonLd(html);
  const productLd = findProductLd(ld);
  const pageUrl = hint.url ?? canonicalUrlFromHtml(html);

  const asin = extractAsinFromPage(html, ld) ?? hint.asin;
  if (!asin) {
    throw new ScraperError("NO_PRODUCT_DATA", "Amazon page is missing an ASIN");
  }

  const title = ldString(productLd, ["name"]) ?? textById(html, "productTitle");
  if (!title) {
    throw new ScraperError("NO_PRODUCT_DATA", "Amazon page is missing a product title");
  }

  const price = parsePrice(html, productLd, pageUrl);
  if (!price) {
    throw new ScraperError("NO_PRODUCT_DATA", "Amazon page is missing a price");
  }

  const description = ldString(productLd, ["description"]) ?? textById(html, "productDescription");

  const category = parseCategory(ld, html);
  const rating = parseRating(html, productLd);
  const availability = parseAvailability(html, productLd);

  const offers = firstOffers(productLd);
  const sellerRaw = ldValue(offers, ["seller"]);
  const seller =
    typeof sellerRaw === "string"
      ? sellerRaw.trim() || undefined
      : (ldString(asObject(sellerRaw), ["name"]) ?? textById(html, "sellerProfileTriggerId") ?? textById(html, "bylineInfo"));

  const brandRaw = ldValue(productLd, ["brand"]);
  const brand =
    typeof brandRaw === "string"
      ? brandRaw.trim() || undefined
      : (ldString(asObject(brandRaw), ["name"]) ?? undefined);

  const attributes = attributesOf({ seller, brand });

  const parsed: AmazonParsedProduct = {
    asin,
    title,
    price,
    images: parseImages(html, productLd),
    attributes,
    raw: { ...(productLd ?? {}), asin },
  };

  if (description) parsed.description = description;
  if (category) parsed.category = category;
  if (rating) parsed.rating = rating;
  if (availability !== undefined) parsed.availability = availability;
  if (seller) parsed.seller = seller;
  if (brand) parsed.brand = brand;

  return parsed;
}

/** Parses every `application/ld+json` block into objects (malformed ones are skipped). */
export function extractJsonLd(html: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRe)) {
    const content = match[1].trim();
    if (!content) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (asObject(entry)) blocks.push(entry as Record<string, unknown>);
      }
    } else if (asObject(parsed)) {
      blocks.push(parsed as Record<string, unknown>);
    }
  }
  return blocks;
}

/** The `Product` JSON-LD graph, if any. */
export function findProductLd(blocks: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return blocks.find((block) => isType(block, "Product") || isType(block, "https://schema.org/Product"));
}

function findBreadcrumbLd(blocks: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return blocks.find((block) => isType(block, "BreadcrumbList") || isType(block, "https://schema.org/BreadcrumbList"));
}

function extractAsinFromPage(html: string, ld: Array<Record<string, unknown>>): string | undefined {
  const canonicalUrl = canonicalUrlFromHtml(html);
  if (canonicalUrl) {
    const asin = extractAsinFromPathname(canonicalUrl.pathname);
    if (asin) return asin;
  }
  const productLd = findProductLd(ld);
  const sku = ldString(productLd, ["sku", "asin"]);
  if (sku && ASIN_RE.test(sku.toUpperCase())) return sku.toUpperCase();
  const detail = html.match(/<th[^>]*>\s*ASIN\s*<\/th>\s*<td[^>]*>([^<]+)<\/td>/i);
  if (detail) {
    const asin = detail[1].trim().toUpperCase();
    if (ASIN_RE.test(asin)) return asin;
  }
  return undefined;
}

function canonicalUrlFromHtml(html: string): URL | undefined {
  const canonical = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i);
  if (!canonical) return undefined;
  const href = canonical[0].match(/href=["']([^"']+)["']/i)?.[1];
  if (!href) return undefined;
  try {
    return new URL(href, "https://www.amazon.com");
  } catch {
    return undefined;
  }
}

function parsePrice(html: string, productLd: Record<string, unknown> | undefined, url: URL | undefined): AmazonPrice | undefined {
  const offers = firstOffers(productLd);
  const aggregate = isType(offers, "AggregateOffer");
  const amount = toFiniteNumber(ldValue(offers, aggregate ? ["lowPrice", "price"] : ["price", "lowPrice"]));
  const currency = ldString(offers, ["priceCurrency"]) ?? currencyForHost(url?.hostname);

  let price = amount;
  if (price === undefined) {
    const text = firstPriceText(html);
    const parsed = text ? parsePriceText(text) : undefined;
    if (parsed === undefined) return undefined;
    price = parsed;
  }
  if (price === undefined || !currency) return undefined;

  const result: AmazonPrice = { amount: price, currency };
  const original = parseListPrice(html);
  if (original !== undefined && original > price) result.originalAmount = original;
  return result;
}

function firstOffers(productLd: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const offers = productLd?.offers;
  if (Array.isArray(offers)) return asObject(offers[0]);
  return asObject(offers);
}

function parseCategory(ld: Array<Record<string, unknown>>, html: string): AmazonCategory | undefined {
  const names = breadcrumbNames(ld, html);
  if (names.length === 0) return undefined;
  return { name: names[names.length - 1], path: names };
}

function breadcrumbNames(ld: Array<Record<string, unknown>>, html: string): string[] {
  const breadcrumb = findBreadcrumbLd(ld);
  if (breadcrumb) {
    const elements = Array.isArray(breadcrumb.itemListElement)
      ? (breadcrumb.itemListElement as unknown[])
          .map((entry) => asObject(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== undefined)
          .sort((a, b) => (toFiniteNumber(a.position) ?? 0) - (toFiniteNumber(b.position) ?? 0))
      : [];
    const names = elements.map((entry) => ldString(entry, ["name"])).filter((name): name is string => name !== undefined);
    if (names.length > 0) return names;
  }
  const wayfinding = html.match(/id="wayfinding-breadcrumbs_feature_div"[\s\S]*?<\/div>/i);
  if (wayfinding) {
    const names: string[] = [];
    const linkRe = /<a\b[^>]*>([^<]+)<\/a>/g;
    for (const match of wayfinding[0].matchAll(linkRe)) {
      const name = match[1].trim();
      if (name) names.push(name);
    }
    return names;
  }
  return [];
}

function parseRating(html: string, productLd: Record<string, unknown> | undefined): AmazonRating | undefined {
  const aggregate = asObject(productLd?.aggregateRating);
  let average = toFiniteNumber(ldValue(aggregate, ["ratingValue"]));
  let count = toFiniteNumber(ldValue(aggregate, ["reviewCount"]));

  if (average === undefined) {
    const marker = html.match(/id="acrPopover"[^>]*title="([^"]*)"/i);
    if (marker) average = parseRatingText(marker[1]);
  }
  if (count === undefined) {
    const text = textById(html, "acrCustomerReviewText");
    if (text) count = parseCountText(text);
  }

  if (average === undefined && count === undefined) return undefined;
  const rating: AmazonRating = {};
  if (average !== undefined) rating.average = average;
  if (count !== undefined) rating.count = count;
  return rating;
}

function parseAvailability(html: string, productLd: Record<string, unknown> | undefined): boolean | undefined {
  const offers = firstOffers(productLd);
  const availability = ldString(offers, ["availability"]);
  if (availability) {
    if (/instock/i.test(availability)) return true;
    if (/outofstock|soldout|unavailable/i.test(availability)) return false;
  }
  if (/id="outOfStock"/i.test(html)) return false;
  if (/\bid="add-to-cart-button"\b/i.test(html)) return true;
  return undefined;
}

function parseImages(html: string, productLd: Record<string, unknown> | undefined): AmazonImage[] {
  const images: AmazonImage[] = [];
  const seen = new Set<string>();
  const push = (url: string): void => {
    if (!isHttpUrl(url) || seen.has(url)) return;
    seen.add(url);
    images.push({ url });
  };

  const ldImage = productLd?.image;
  if (typeof ldImage === "string") {
    push(ldImage);
  } else if (Array.isArray(ldImage)) {
    for (const entry of ldImage) if (typeof entry === "string") push(entry);
  } else if (asObject(ldImage)) {
    const url = ldString(ldImage as Record<string, unknown>, ["url", "contentUrl"]);
    if (url) push(url);
  }

  const landing = html.match(/id="landingImage"[^>]*\bsrc="([^"]+)"/i);
  if (landing) push(landing[1]);
  for (const match of html.matchAll(/\bclass="a-dynamic-image"[^>]*\bsrc="([^"]+)"/gi)) {
    push(match[1]);
  }
  for (const match of html.matchAll(/\bdata-a-dynamic-image="([^"]+)"/gi)) {
    try {
      const parsed = JSON.parse(match[1].replace(/&quot;/g, '"')) as unknown;
      if (asObject(parsed)) {
        for (const url of Object.keys(parsed as Record<string, unknown>)) push(url);
      }
    } catch {
      // Malformed image data - skip.
    }
  }
  return images;
}

function firstPriceText(html: string): string | undefined {
  for (const id of ["priceblock_ourprice", "priceblock_dealprice", "priceblock_saleprice"]) {
    const text = textById(html, id);
    if (text) return text;
  }
  const core = html.match(/id="corePrice_feature_div"[\s\S]*?class="a-offscreen">([^<]+)</i);
  if (core) return core[1].trim();
  return undefined;
}

/** List price shown with a strikethrough, e.g. `<span class="a-text-price">`. */
function parseListPrice(html: string): number | undefined {
  const match = html.match(/class="a-text-price"[^>]*>\s*<span class="a-offscreen">([^<]+)<\/span>/i);
  if (!match) return undefined;
  return parsePriceText(match[1]);
}

function parsePriceText(text: string): number | undefined {
  let cleaned = text.replace(/[^0-9.,\-]/g, "");
  if (/,\d{1,2}$/.test(cleaned) && !cleaned.includes(".")) {
    cleaned = cleaned.replace(",", ".");
  }
  cleaned = cleaned.replace(/,/g, "");
  if (cleaned === "" || cleaned === "-") return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseRatingText(text: string): number | undefined {
  const match = text.match(/(\d+(?:\.\d+)?)\s*out\s*of\s*5/i) ?? text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 5 ? value : undefined;
}

function parseCountText(text: string): number | undefined {
  const match = text.replace(/,/g, "").match(/(\d+)\s*(?:ratings?|reviews?)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function attributesOf(entries: { seller?: string; brand?: string }): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (entries.seller) attributes.seller = entries.seller;
  if (entries.brand) attributes.brand = entries.brand;
  return attributes;
}

/** Text content of the first element whose `id` matches, with tags stripped. */
function textById(html: string, id: string): string | undefined {
  const re = new RegExp(`id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/`, "i");
  const match = html.match(re);
  if (!match) return undefined;
  const text = match[1]
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

function isType(record: Record<string, unknown> | undefined, type: string): boolean {
  if (!record) return false;
  const value = record["@type"];
  if (value === type) return true;
  return Array.isArray(value) && value.includes(type);
}

function ldValue(record: Record<string, unknown> | undefined, keys: readonly string[] | undefined): unknown {
  if (!record || !keys) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) return value[0];
      continue;
    }
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return undefined;
}

function ldString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  const value = ldValue(record, keys);
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").replace(/[^0-9.\-]/g, "");
    if (cleaned === "" || cleaned === "-") return undefined;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
