import type { Env } from "../env";
import { parseProductId } from "../dashboard/assemble";
import { getShopifyExportToken, readBearerToken, timingSafeEqual } from "../shopify";
import { exportProductToShopify } from "../shopify/export";
import { jsonError, jsonOk } from "../utils/http";

const PRODUCT_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/shopify/products/:id — manual Shopify draft export (P8.33).
 *
 * Requires `Authorization: Bearer <SHOPIFY_EXPORT_TOKEN>`. Never runs from
 * cron. Outcomes map to:
 * - 200 `{ status: "ok", listing }`
 * - 400 `INVALID_JSON` when a body is present and is not JSON
 * - 401 `UNAUTHORIZED`
 * - 404 `NOT_FOUND`
 * - 409 `CURRENCY_MISMATCH`
 * - 422 `NO_OBSERVATION` / `INVALID_CURRENCY`
 * - 503 `SUPABASE_NOT_CONFIGURED` / `SHOPIFY_NOT_CONFIGURED`
 * - 502 with the typed Shopify / listing persistence code
 */
export async function handleShopifyProductExport(
  request: Request,
  env: Env,
  requestId: string,
  productId: string,
): Promise<Response> {
  const expected = getShopifyExportToken(env);
  if (!expected) {
    return jsonError(503, "Shopify export token is not configured", "SHOPIFY_NOT_CONFIGURED", requestId);
  }
  const provided = readBearerToken(request);
  if (!provided || !timingSafeEqual(provided, expected)) {
    return jsonError(401, "Unauthorized", "UNAUTHORIZED", requestId);
  }

  const parsedId = parseProductId(productId);
  if (!parsedId || !PRODUCT_ID_UUID.test(parsedId)) {
    return jsonError(404, "Product not found", "NOT_FOUND", requestId);
  }

  const contentType = request.headers.get("content-type") ?? "";
  const hasBody = request.headers.get("content-length") !== "0" && request.headers.get("content-length") !== null;
  if (contentType.includes("application/json") || hasBody) {
    try {
      const text = await request.text();
      if (text.trim() !== "") {
        JSON.parse(text);
      }
    } catch {
      return jsonError(400, "Request body must be valid JSON", "INVALID_JSON", requestId);
    }
  }

  const result = await exportProductToShopify(env, parsedId);
  switch (result.status) {
    case "ok":
      return jsonOk({
        status: "ok",
        listing: {
          id: result.listing.id,
          productId: result.listing.product_id,
          shopDomain: result.listing.shop_domain,
          shopifyProductId: result.listing.shopify_product_id,
          shopifyVariantId: result.listing.shopify_variant_id,
          listingStatus: result.listing.status,
          title: result.listing.title,
          exportedAt: result.listing.exported_at,
          created: result.created,
        },
      });
    case "not_found":
      return jsonError(404, "Product not found", "NOT_FOUND", requestId);
    case "credentials_missing":
      return result.target === "supabase"
        ? jsonError(503, "Supabase is not configured", "SUPABASE_NOT_CONFIGURED", requestId)
        : jsonError(503, "Shopify is not configured", "SHOPIFY_NOT_CONFIGURED", requestId);
    case "no_observation":
      return jsonError(422, "Product has no source observation", "NO_OBSERVATION", requestId);
    case "invalid_currency":
      return jsonError(422, "Observation currency is missing or invalid", "INVALID_CURRENCY", requestId);
    case "currency_mismatch":
      return jsonError(409, "Observation currency does not match shop currency", "CURRENCY_MISMATCH", requestId);
    case "shopify_error":
      return jsonError(502, result.message, result.code, requestId);
    case "listing_upsert_failed":
      return jsonError(502, result.message, "shopify_listings_upsert_failed", requestId);
    case "error":
      return jsonError(502, result.message, result.code ?? "SHOPIFY_EXPORT_FAILED", requestId);
  }
}
