import type { PersistedObservationRecord, PersistedProductRecord } from "../supabase/repository";
import { toDescriptionHtml } from "./html";
import {
  DEFAULT_VARIANT_OPTION_NAME,
  DEFAULT_VARIANT_OPTION_VALUE,
  SHOPIFY_MAX_IMAGES,
  type ShopifyFileInput,
  type ShopifyMappedProduct,
  type ShopifyProductSetInput,
} from "./types";

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

export function isValidCurrencyCode(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  return CURRENCY_CODE.test(value.trim());
}

export function currenciesMatch(source: string, shop: string): boolean {
  return source.trim().toUpperCase() === shop.trim().toUpperCase();
}

export function isHttpOrHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function mapImageFiles(
  observation: PersistedObservationRecord | null,
  product: PersistedProductRecord,
): ShopifyFileInput[] {
  const seen = new Set<string>();
  const files: ShopifyFileInput[] = [];

  const push = (url: string, alt?: string): void => {
    if (files.length >= SHOPIFY_MAX_IMAGES) return;
    const trimmed = url.trim();
    if (!trimmed || seen.has(trimmed) || !isHttpOrHttpsUrl(trimmed)) return;
    seen.add(trimmed);
    files.push({
      originalSource: trimmed,
      contentType: "IMAGE",
      ...(alt ? { alt } : {}),
    });
  };

  for (const image of iterateImages(observation?.image_urls)) {
    push(image.url, image.alt);
  }
  for (const image of iterateImages(product.images)) {
    push(image.url, image.alt);
  }
  if (typeof product.primary_image_url === "string") {
    push(product.primary_image_url);
  }
  return files;
}

export function mapProductSetInput(
  product: PersistedProductRecord,
  observation: PersistedObservationRecord,
  options: { variantId?: string | null; includeEmptyFiles: boolean } = { includeEmptyFiles: false },
): ShopifyMappedProduct {
  const files = mapImageFiles(observation, product);
  const sku = observation.external_id.trim() ? observation.external_id : undefined;
  const vendor = product.brand != null && product.brand !== "" ? product.brand : undefined;
  const variant = {
    optionValues: [{ optionName: DEFAULT_VARIANT_OPTION_NAME, name: DEFAULT_VARIANT_OPTION_VALUE }],
    price: String(observation.price),
    ...(sku ? { sku } : {}),
    ...(options.variantId ? { id: options.variantId } : {}),
  };
  const input: ShopifyProductSetInput = {
    title: product.title,
    descriptionHtml: toDescriptionHtml(product.description),
    status: "DRAFT",
    ...(vendor ? { vendor } : {}),
    productOptions: [{ name: DEFAULT_VARIANT_OPTION_NAME, values: [{ name: DEFAULT_VARIANT_OPTION_VALUE }] }],
    variants: [variant],
  };
  if (files.length > 0 || options.includeEmptyFiles) {
    input.files = files;
  }
  return {
    input,
    sourceCurrency: observation.currency,
    imageCount: files.length,
  };
}

function iterateImages(value: unknown): Array<{ url: string; alt?: string }> {
  if (!Array.isArray(value)) return [];
  const images: Array<{ url: string; alt?: string }> = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      images.push({ url: entry });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { url?: unknown; alt?: unknown };
    if (typeof record.url !== "string") continue;
    images.push({
      url: record.url,
      ...(typeof record.alt === "string" && record.alt ? { alt: record.alt } : {}),
    });
  }
  return images;
}
