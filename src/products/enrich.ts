import {
  asString,
  normalizeAttributes,
  normalizeAvailability,
  normalizeCategory,
  normalizeProduct,
  normalizeRating,
  normalizeShipping,
  toFiniteNumber,
} from "./normalize";
import type { NormalizeProductOptions } from "./normalize";
import type { Product, ProductCategory, ProductRating, ProductShipping } from "./types";

/**
 * Candidate raw keys used to derive each optional `Product` field. Ordered by
 * priority: the first key present on the raw record wins. Lists are
 * source-agnostic and can be overridden per call via {@link EnrichmentKeys}.
 */
export interface EnrichmentKeys {
  descriptionKeys?: string[];
  categoryKeys?: string[];
  ratingKeys?: string[];
  shippingKeys?: string[];
  attributeKeys?: string[];
  availabilityKeys?: string[];
  sourceKeys?: string[];
}

export interface EnrichProductOptions extends NormalizeProductOptions {
  /** Optional override of the candidate key lists. Unset entries use defaults. */
  enrich?: EnrichmentKeys;
}

export const DEFAULT_KEYS: Required<EnrichmentKeys> = Object.freeze({
  descriptionKeys: ["description", "desc", "summary", "subtitle"],
  categoryKeys: ["category", "categoryName", "categories", "type"],
  ratingKeys: ["rating", "ratingSummary", "reviewSummary"],
  shippingKeys: ["shipping", "delivery", "shipmentInfo"],
  attributeKeys: ["attributes", "specs", "variants", "properties", "details"],
  availabilityKeys: ["available", "inStock", "stock", "soldOut"],
  sourceKeys: ["source", "shopName", "seller", "merchant", "store", "shop"],
});

/**
 * Reusable, source-agnostic enrichment engine. Reuses {@link normalizeProduct}
 * to produce the core `Product`, then fills any optional fields that
 * normalization left empty by probing a configurable set of candidate keys on
 * the raw record. Existing values are never overwritten, so the output always
 * validates exactly like `normalizeProduct` output.
 */
export function enrichProduct(options: EnrichProductOptions): Product {
  const product = normalizeProduct(options);
  const raw = toRecord(options.raw);
  const keys = { ...DEFAULT_KEYS, ...(options.enrich ?? {}) };

  if (product.description === undefined) {
    const description = asString(pickFirst(raw, keys.descriptionKeys));
    if (description) product.description = description;
  }

  if (product.category === undefined) {
    const category = coerceCategory(pickFirst(raw, keys.categoryKeys));
    if (category) product.category = category;
  }

  if (product.rating === undefined) {
    const rating = coerceRating(pickFirst(raw, keys.ratingKeys));
    if (rating) product.rating = rating;
  }

  if (product.shipping === undefined) {
    const shipping = coerceShipping(pickFirst(raw, keys.shippingKeys), raw);
    if (shipping) product.shipping = shipping;
  }

  if (product.attributes === undefined) {
    const attributes = coerceAttributes(pickFirst(raw, keys.attributeKeys));
    if (attributes) product.attributes = attributes;
  }

  if (product.available === undefined) {
    const available = normalizeAvailability(pickFirst(raw, keys.availabilityKeys));
    if (available !== undefined) product.available = available;
  }

  if (product.source === undefined) {
    const source = asString(pickFirst(raw, keys.sourceKeys));
    if (source) product.source = source;
  }

  return product;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickFirst(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return value;
  }
  return undefined;
}

function coerceCategory(value: unknown): ProductCategory | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const category = normalizeCategory(entry);
      if (category) return category;
    }
    return undefined;
  }
  return normalizeCategory(value);
}

function coerceRating(value: unknown): ProductRating | undefined {
  if (typeof value === "number") return { average: value };
  if (typeof value === "string") {
    const average = toFiniteNumber(value);
    return average === undefined ? undefined : { average };
  }
  return normalizeRating(value);
}

function coerceShipping(value: unknown, raw: Record<string, unknown>): ProductShipping | undefined {
  if (typeof value === "boolean") return normalizeShipping({ free: value });
  if (typeof value === "string") {
    if (/free/i.test(value)) return normalizeShipping({ free: true });
    const amount = toFiniteNumber(value);
    const currency = asString(raw.currency);
    if (amount === undefined || !currency) return undefined;
    return normalizeShipping({ cost: { amount, currency } });
  }
  if (typeof value === "number") {
    const currency = asString(raw.currency);
    if (!currency) return undefined;
    return normalizeShipping({ cost: { amount: value, currency } });
  }
  return normalizeShipping(value);
}

function coerceAttributes(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value)) return normalizeAttributes(value);
  const attributes: Record<string, string> = {};
  for (const entry of value) {
    if (typeof entry === "object" && entry !== null) {
      const record = entry as Record<string, unknown>;
      const name = asString(record.name ?? record.key ?? record.label);
      const entryValue = record.value;
      if (name && (typeof entryValue === "string" || typeof entryValue === "number")) {
        attributes[name] = String(entryValue);
        continue;
      }
    }
    if (typeof entry === "string") attributes[entry] = "true";
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}
