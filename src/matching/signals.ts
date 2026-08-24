/**
 * Signal extraction for product matching.
 *
 * Turns a normalized `Product` (or a persisted `products` row) into a compact,
 * comparable `ProductSignals` bundle: identifiers, brand, variant tokens and
 * title tokens. No database or network access — everything is derived from the
 * input object.
 */
import {
  canonicalGtin,
  cleanIdentifier,
  isValidGtin,
  isValidIsbn,
  normalizeText,
  tokenize,
} from "./normalize";

export type IdentifierType = "gtin" | "isbn" | "mpn" | "model" | "sku";

export interface IdentifierInfo {
  type: IdentifierType;
  value: string;
}

export interface ProductSignals {
  title: string;
  titleTokens: string[];
  brand: string | null;
  identifiers: IdentifierInfo[];
  variantTokens: string[];
  categoryPath: string[];
  hasIdentifier: boolean;
}

/** Attribute keys that are recognized as a global/structured identifier. */
const IDENTIFIER_KEY_MAP: ReadonlyArray<readonly [readonly string[], IdentifierType]> = [
  [["gtin", "upc", "ean", "barcode", "barcodes"], "gtin"],
  [["isbn"], "isbn"],
  [["mpn", "manufacturerpartnumber", "mfrpartno"], "mpn"],
  [["model", "modelnumber", "modelno"], "model"],
  [["sku", "partnumber", "pn"], "sku"],
];

/** Identifier priority used for the strong fingerprint. */
const IDENTIFIER_ORDER: readonly IdentifierType[] = ["gtin", "isbn", "mpn", "model", "sku"];

const BRAND_KEYS = ["brand", "manufacturer", "make"] as const;

/** Attribute keys whose values are variant-defining (color/size/capacity/...). */
const VARIANT_KEYS = [
  "color",
  "colour",
  "size",
  "capacity",
  "storage",
  "memory",
  "style",
  "flavor",
  "flavour",
  "variant",
  "pack",
  "count",
  "quantity",
  "units",
  "edition",
  "generation",
  "material",
] as const;

const COLOR_WORDS = new Set([
  "black",
  "white",
  "red",
  "blue",
  "green",
  "yellow",
  "pink",
  "purple",
  "gray",
  "grey",
  "orange",
  "brown",
  "silver",
  "gold",
  "navy",
  "beige",
  "cream",
  "teal",
  "olive",
  "maroon",
  "charcoal",
  "rose",
  "cyan",
  "ivory",
  "lime",
  "magenta",
  "tan",
]);

function isGoodIdentifier(type: IdentifierType, value: string): boolean {
  switch (type) {
    case "gtin":
      return isValidGtin(value);
    case "isbn":
      return isValidIsbn(value);
    case "mpn":
      return value.length >= 4 && value.length <= 40;
    case "model":
      return value.length >= 3 && value.length <= 60;
    case "sku":
      return value.length >= 4 && value.length <= 64;
  }
}

/**
 * Reads a fingerprint stored as a `dedup_key` (e.g. `gtin:00012345678905` or
 * `model:AB-100|black,color:black`) back into an identifier, ignoring any
 * variant signature suffix after the first `|`.
 */
export function parseFingerprintKey(key: string | null): IdentifierInfo | null {
  if (!key) return null;
  const match = key.match(/^(gtin|isbn|mpn|model|sku):(.+)$/);
  if (!match) return null;
  const type = match[1] as IdentifierType;
  let value = match[2];
  const bar = value.indexOf("|");
  if (bar !== -1) value = value.slice(0, bar);
  if (type === "gtin") value = canonicalGtin(value);
  return { type, value };
}

/**
 * Extracts the valid, normalized identifiers carried by a product. Only
 * identifiers that pass sanity/checksum checks are returned, so a garbage or
 * mistyped value can never anchor a match.
 */
export function extractIdentifiers(
  attributes: Record<string, string> | undefined,
  dedupKey: string | null,
): IdentifierInfo[] {
  const result: IdentifierInfo[] = [];
  const seen = new Set<string>();
  const add = (type: IdentifierType, raw: string): void => {
    const cleaned = cleanIdentifier(raw);
    if (!cleaned || !isGoodIdentifier(type, cleaned)) return;
    const value = type === "gtin" ? canonicalGtin(cleaned) : cleaned;
    const fingerprintPart = `${type}:${value}`;
    if (seen.has(fingerprintPart)) return;
    seen.add(fingerprintPart);
    result.push({ type, value });
  };

  for (const [keys, type] of IDENTIFIER_KEY_MAP) {
    for (const key of keys) {
      const raw = attributes?.[key];
      if (typeof raw === "string" && raw.trim()) add(type, raw);
    }
  }
  const fromKey = parseFingerprintKey(dedupKey);
  if (fromKey) add(fromKey.type, fromKey.value);
  return result;
}

/** First good identifier in priority order -> `type:value` fingerprint, or null. */
export function deriveFingerprint(identifiers: IdentifierInfo[], variantTokens: readonly string[]): string | null {
  for (const type of IDENTIFIER_ORDER) {
    const found = identifiers.find((identifier) => identifier.type === type);
    if (found) {
      let fingerprint = `${found.type}:${found.value}`;
      if (found.type !== "gtin" && found.type !== "isbn" && variantTokens.length > 0) {
        const signature = [...variantTokens].sort().join(",");
        fingerprint += `|${signature}`;
      }
      return fingerprint;
    }
  }
  return null;
}

export function extractBrand(attributes: Record<string, string> | undefined): string | null {
  for (const key of BRAND_KEYS) {
    const value = attributes?.[key];
    if (typeof value === "string" && value.trim()) return normalizeText(value);
  }
  return null;
}

/**
 * Variant-defining tokens: values of variant attribute keys plus spec/color
 * tokens parsed out of the title (e.g. `128gb`, `2-pack`, `black`).
 */
export function extractVariantTokens(
  attributes: Record<string, string> | undefined,
  title: string,
): string[] {
  const tokens = new Set<string>();
  const add = (token: string): void => {
    if (token.length >= 2) tokens.add(token);
  };

  for (const key of VARIANT_KEYS) {
    const value = attributes?.[key];
    if (typeof value !== "string" || !value.trim()) continue;
    for (const part of tokenize(value)) {
      add(`${key}:${part}`);
      add(part);
    }
  }

  const lower = title.toLowerCase();
  for (const match of lower.match(/\d+(?:gb|tb|ml|l|oz|pk|w|watt|v|volt)\b/g) ?? []) {
    add(match);
  }
  for (const match of lower.match(/\b\d+\s*[-]?\s*(?:pack|packof|count|pc|pcs)\b/g) ?? []) {
    add(match.replace(/[\s-]/g, ""));
  }
  const packOf = lower.match(/\b(?:pack|bundle)\s+(?:of\s+)?(\d+)\b/);
  if (packOf) add(`pack${packOf[1]}`);
  for (const match of lower.match(/[a-z]+/g) ?? []) {
    if (COLOR_WORDS.has(match)) add(match);
  }

  return [...tokens];
}

export interface ProductLike {
  title: string;
  attributes?: Record<string, string> | undefined;
  category?: { name?: string; path?: string[] } | undefined;
}

export function buildSignalsFromProduct(product: ProductLike): ProductSignals {
  const attributes = product.attributes ?? {};
  const identifiers = extractIdentifiers(attributes, null);
  const path = product.category?.path?.filter((entry): entry is string => Boolean(entry)) ?? [];
  const categoryPath = path.length > 0 ? path : product.category?.name ? [product.category.name] : [];
  return {
    title: product.title,
    titleTokens: tokenize(product.title),
    brand: extractBrand(attributes),
    identifiers,
    variantTokens: extractVariantTokens(attributes, product.title),
    categoryPath,
    hasIdentifier: identifiers.length > 0,
  };
}

export interface RowLike {
  title: string;
  brand: string | null;
  attributes: unknown;
  dedup_key: string | null;
}

export function buildSignalsFromRow(row: RowLike): ProductSignals {
  const attributes = isStringRecord(row.attributes) ? row.attributes : {};
  const identifiers = extractIdentifiers(attributes, row.dedup_key);
  return {
    title: row.title,
    titleTokens: tokenize(row.title),
    brand: row.brand ? normalizeText(row.brand) : null,
    identifiers,
    variantTokens: extractVariantTokens(attributes, row.title),
    categoryPath: [],
    hasIdentifier: identifiers.length > 0,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
