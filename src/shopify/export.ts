import type { Env } from "../env";
import {
  getProductById,
  getShopifyListingByShopAndProduct,
  listObservationsForProducts,
  upsertShopifyListing,
  type PersistedObservationRecord,
  type PersistedProductRecord,
  type PersistedShopifyListingRecord,
} from "../supabase/repository";
import { fetchShopCurrency, productSet } from "./client";
import { getShopifyConfig } from "./config";
import { currenciesMatch, isValidCurrencyCode, mapProductSetInput } from "./map";
import { ShopifyClientError, type ShopifyProductSetInput } from "./types";

export type ShopifyExportFailure =
  | { status: "not_found" }
  | { status: "credentials_missing"; target: "supabase" | "shopify" }
  | { status: "no_observation" }
  | { status: "invalid_currency" }
  | { status: "currency_mismatch"; sourceCurrency: string; shopCurrency: string }
  | { status: "shopify_error"; code: ShopifyClientError["code"]; message: string }
  | { status: "listing_upsert_failed"; message: string; shopifyProductId: string | null }
  | { status: "error"; code?: string; message: string };

export type ShopifyExportResult =
  | {
      status: "ok";
      listing: PersistedShopifyListingRecord;
      created: boolean;
    }
  | ShopifyExportFailure;

export async function exportProductToShopify(env: Env, productId: string): Promise<ShopifyExportResult> {
  const config = getShopifyConfig(env);
  if (!config) {
    return { status: "credentials_missing", target: "shopify" };
  }

  const productResult = await getProductById(env, productId);
  if (productResult.status === "credentials_missing") {
    return { status: "credentials_missing", target: "supabase" };
  }
  if (productResult.status === "not_found") {
    return { status: "not_found" };
  }
  if (productResult.status === "error") {
    return { status: "error", code: productResult.code, message: productResult.message };
  }
  if (productResult.status === "invalid") {
    return { status: "error", message: productResult.message };
  }
  const product = productResult.data;

  const observationsResult = await listObservationsForProducts(env, [product.id]);
  if (observationsResult.status === "credentials_missing") {
    return { status: "credentials_missing", target: "supabase" };
  }
  if (observationsResult.status === "error") {
    return { status: "error", code: observationsResult.code, message: observationsResult.message };
  }
  if (observationsResult.status === "not_found" || observationsResult.status === "invalid") {
    return { status: "no_observation" };
  }
  const observation = selectLatestObservation(observationsResult.data);
  if (!observation) {
    return { status: "no_observation" };
  }
  if (!isValidCurrencyCode(observation.currency)) {
    return { status: "invalid_currency" };
  }

  const listingResult = await getShopifyListingByShopAndProduct(env, config.shopDomain, product.id);
  if (listingResult.status === "credentials_missing") {
    return { status: "credentials_missing", target: "supabase" };
  }
  if (listingResult.status === "error") {
    return { status: "error", code: listingResult.code, message: listingResult.message };
  }
  const existing = listingResult.status === "found" ? listingResult.data : null;
  const existingProductGid = existing?.shopify_product_id ?? null;
  const existingVariantGid = existing?.shopify_variant_id ?? null;

  const mapped = mapProductSetInput(product, observation, {
    variantId: existingVariantGid,
    includeEmptyFiles: Boolean(existingProductGid),
  });

  let shopCurrency: string;
  try {
    shopCurrency = await fetchShopCurrency(config);
  } catch (err) {
    return shopifyFailure(err);
  }
  if (!isValidCurrencyCode(shopCurrency)) {
    return { status: "shopify_error", code: "SHOPIFY_SHOP_FAILED", message: "shop currencyCode invalid" };
  }
  if (!currenciesMatch(mapped.sourceCurrency, shopCurrency)) {
    return {
      status: "currency_mismatch",
      sourceCurrency: mapped.sourceCurrency,
      shopCurrency,
    };
  }

  let setResult;
  try {
    setResult = await productSet(
      config,
      mapped.input,
      existingProductGid ? { id: existingProductGid } : undefined,
    );
  } catch (err) {
    return shopifyFailure(err);
  }

  const persisted = await persistListing({
    env,
    product,
    shopDomain: config.shopDomain,
    input: mapped.input,
    shopifyProductId: setResult.productId,
    shopifyVariantId: setResult.variantId,
  });
  if (persisted.status !== "ok") {
    return persisted;
  }
  return {
    status: "ok",
    listing: persisted.listing,
    created: !existingProductGid,
  };
}

async function persistListing(args: {
  env: Env;
  product: PersistedProductRecord;
  shopDomain: string;
  input: ShopifyProductSetInput;
  shopifyProductId: string;
  shopifyVariantId: string | null;
}): Promise<{ status: "ok"; listing: PersistedShopifyListingRecord } | ShopifyExportFailure> {
  const upserted = await upsertShopifyListing(args.env, {
    product_id: args.product.id,
    shop_domain: args.shopDomain,
    shopify_product_id: args.shopifyProductId,
    shopify_variant_id: args.shopifyVariantId,
    status: "draft",
    dedup_key: `${args.shopDomain}:${args.product.id}`,
    title: args.product.title,
    payload: args.input as unknown as Record<string, unknown>,
    last_error: null,
    exported_at: new Date().toISOString(),
  });
  if (upserted.status === "credentials_missing") {
    return { status: "credentials_missing", target: "supabase" };
  }
  if (upserted.status === "invalid") {
    return {
      status: "listing_upsert_failed",
      message: upserted.message,
      shopifyProductId: args.shopifyProductId,
    };
  }
  if (upserted.status === "error" || upserted.status === "not_found") {
    return {
      status: "listing_upsert_failed",
      message: upserted.status === "error" ? upserted.message : "failed to upsert shopify listing",
      shopifyProductId: args.shopifyProductId,
    };
  }
  return { status: "ok", listing: upserted.data };
}

function selectLatestObservation(rows: PersistedObservationRecord[]): PersistedObservationRecord | null {
  return rows[0] ?? null;
}

function shopifyFailure(err: unknown): ShopifyExportFailure {
  if (err instanceof ShopifyClientError) {
    return { status: "shopify_error", code: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: "shopify_error", code: "SHOPIFY_EXPORT_FAILED", message };
}
