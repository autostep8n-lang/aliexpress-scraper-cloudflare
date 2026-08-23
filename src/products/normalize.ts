import type {
  Product,
  ProductCategory,
  ProductImage,
  ProductPrice,
  ProductRating,
  ProductShipping,
} from "./types";
import type { ScraperPlatform } from "../scrapers/types";
import { isHttpUrl, parseHttpUrl } from "../utils/url";

export const SUPPORTED_PLATFORMS: readonly ScraperPlatform[] = [
  "aliexpress",
  "tiktok-shop",
  "amazon",
  "youtube",
  "instagram",
  "facebook",
  "alibaba",
];

export class ProductNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductNormalizationError";
  }
}

export interface NormalizeProductOptions {
  raw?: unknown;
  platform?: ScraperPlatform;
  url: string;
  scrapedAt?: string;
}

/**
 * Best-effort conversion of loosely-typed scraper/API data into the normalized
 * `Product` shape. Coerces numeric strings, uppercases currency codes, trims
 * text, and applies safe defaults. Throws `ProductNormalizationError` only
 * when a required field cannot be determined (url, platform, externalId,
 * title, or a numeric price with currency).
 */
export function normalizeProduct(options: NormalizeProductOptions): Product {
  const { raw = {}, platform, url, scrapedAt } = options;

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProductNormalizationError("raw product data must be an object");
  }
  const rawRecord = raw as Record<string, unknown>;

  const parsedUrl = parseHttpUrl(url);
  if (!parsedUrl) {
    throw new ProductNormalizationError(`invalid product url: ${url}`);
  }

  const resolvedPlatform = platform ?? rawRecord.platform;
  if (!isSupportedPlatform(resolvedPlatform)) {
    throw new ProductNormalizationError("product platform is required and must be supported");
  }

  const externalId = asString(rawRecord.externalId) || asString(rawRecord.id) || deriveExternalId(parsedUrl);
  if (!externalId) {
    throw new ProductNormalizationError("unable to determine product externalId");
  }

  const title = asString(rawRecord.title);
  if (!title) {
    throw new ProductNormalizationError("product title is required");
  }

  const price = normalizePrice(rawRecord.price, asString(rawRecord.currency));
  if (!price) {
    throw new ProductNormalizationError("product price is required and must be numeric with a valid currency");
  }

  const product: Product = {
    platform: resolvedPlatform,
    externalId,
    url: parsedUrl.href,
    title,
    price,
    images: normalizeImages(rawRecord.images ?? rawRecord.imageUrl),
    scrapedAt: normalizeScrapedAt(scrapedAt ?? rawRecord.scrapedAt, new Date().toISOString()),
  };

  const description = asString(rawRecord.description);
  if (description) product.description = description;

  const category = normalizeCategory(rawRecord.category);
  if (category) product.category = category;

  const rating = normalizeRating(rawRecord.rating);
  if (rating) product.rating = rating;

  const shipping = normalizeShipping(rawRecord.shipping);
  if (shipping) product.shipping = shipping;

  const attributes = normalizeAttributes(rawRecord.attributes);
  if (attributes) product.attributes = attributes;

  const available = normalizeAvailability(rawRecord.available);
  if (available !== undefined) product.available = available;

  const source = asString(rawRecord.source);
  if (source) product.source = source;

  return product;
}

function isSupportedPlatform(value: unknown): value is ScraperPlatform {
  return typeof value === "string" && (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

export function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.\-]/g, "");
    if (cleaned === "" || cleaned === "-") return undefined;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

function normalizeCurrency(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().toUpperCase().match(/[A-Z]{3}/);
  return match?.[0];
}

function normalizePrice(value: unknown, fallbackCurrency: string): ProductPrice | undefined {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const amount = toFiniteNumber(record.amount);
    const currency = normalizeCurrency(record.currency);
    if (amount === undefined || !currency) return undefined;
    const price: ProductPrice = { amount, currency };
    const originalAmount = toFiniteNumber(record.originalAmount);
    if (originalAmount !== undefined) price.originalAmount = originalAmount;
    return price;
  }
  const amount = toFiniteNumber(value);
  const currency = normalizeCurrency(fallbackCurrency);
  if (amount === undefined || !currency) return undefined;
  return { amount, currency };
}

function normalizeImages(value: unknown): ProductImage[] {
  if (typeof value === "string") {
    return isHttpUrl(value) ? [{ url: value }] : [];
  }
  if (!Array.isArray(value)) return [];

  const images: ProductImage[] = [];
  for (const item of value) {
    const url = typeof item === "string" ? item : (item as { url?: unknown } | null)?.url;
    if (typeof url !== "string" || !isHttpUrl(url)) continue;
    if (typeof item === "string") {
      images.push({ url });
      continue;
    }
    const alt = (item as { alt?: unknown }).alt;
    images.push({ url, ...(typeof alt === "string" && alt.trim() ? { alt: alt.trim() } : {}) });
  }
  return images;
}

export function normalizeCategory(value: unknown): ProductCategory | undefined {
  if (typeof value === "string") {
    const name = value.trim();
    return name ? { name } : undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;

  const record = value as Record<string, unknown>;
  const name = asString(record.name);
  if (!name) return undefined;

  const category: ProductCategory = { name };
  const id = asString(record.id);
  if (id) category.id = id;
  if (Array.isArray(record.path)) {
    const path = record.path.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    if (path.length > 0) category.path = path;
  }
  return category;
}

export function normalizeRating(value: unknown): ProductRating | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const rating: ProductRating = {};
  const average = toFiniteNumber(record.average);
  if (average !== undefined) rating.average = average;
  const count = toFiniteNumber(record.count);
  if (count !== undefined) rating.count = count;
  return Object.keys(rating).length > 0 ? rating : undefined;
}

export function normalizeShipping(value: unknown): ProductShipping | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const shipping: ProductShipping = {};
  if (typeof record.free === "boolean") shipping.free = record.free;

  const cost = normalizePrice(record.cost, "");
  if (cost) shipping.cost = cost;

  const minDays = toFiniteNumber(record.deliveryMinDays);
  const maxDays = toFiniteNumber(record.deliveryMaxDays);
  if (minDays !== undefined) shipping.deliveryMinDays = Math.floor(minDays);
  if (maxDays !== undefined) shipping.deliveryMaxDays = Math.floor(maxDays);

  const fromCountry = asString(record.fromCountry);
  if (fromCountry) shipping.fromCountry = fromCountry;

  return Object.keys(shipping).length > 0 ? shipping : undefined;
}

export function normalizeAttributes(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const attributes: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number") attributes[key] = String(entry);
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

export function normalizeAvailability(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  return undefined;
}

function normalizeScrapedAt(value: unknown, fallback: string): string {
  const candidate = asString(value);
  if (candidate && !Number.isNaN(Date.parse(candidate))) return candidate;
  return fallback;
}

function deriveExternalId(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return url.href;
  return last.replace(/\.(html?|php|asp)$/i, "");
}
