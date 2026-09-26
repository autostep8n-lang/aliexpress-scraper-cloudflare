import type { Env } from "../env";
import type { AliExpressParsedProduct, AliExpressPrice } from "./aliexpress-parser";
import { ScraperError } from "./types";
import { md5 } from "../utils/md5";
import { openApiCredentials, hasOpenApiCredentials } from "./aliexpress-openapi-credentials";
import { resolveAliExpressAccessToken } from "./aliexpress-oauth";
import { DS_BUSINESS_ENDPOINT, DS_SIGN_METHOD, dsHmacSign, dsTimestamp } from "./aliexpress-sign";

/**
 * AliExpress Open Platform (open.aliexpress.com) provider.
 *
 * Official Dropshipping `aliexpress.ds.product.get`:
 *
 *   - Request: `POST https://api-sg.aliexpress.com/sync` (form-encoded)
 *   - Required: `product_id`, `ship_to_country`, `access_token`, `app_key`,
 *     `timestamp`, `sign_method=sha256`, `sign`
 *   - Signature: HMAC-SHA256 uppercase hex over sorted "keyvalue" pairs
 *
 * MD5 `openApiSign` is kept for the legacy signing helper only; DS calls
 * never reuse it. Credentials come from `ALIEXPRESS_OPENAPI_KEY` /
 * `ALIEXPRESS_OPENAPI_SECRET`. Access tokens are obtained via
 * `/api/aliexpress/oauth` and stored in `SCRAPE_CACHE`.
 */

const OPEN_API_METHOD = "aliexpress.ds.product.get";
const DOTTED_RESPONSE_KEY = `${OPEN_API_METHOD}_response`;
const UNDERSCORE_RESPONSE_KEY = "aliexpress_ds_product_get_response";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export { openApiCredentials, hasOpenApiCredentials };
export type { OpenApiCredentials } from "./aliexpress-openapi-credentials";

export interface FetchOpenApiOptions {
  shipToCountry?: string;
  accessToken?: string;
}

/**
 * Fetches a product through the official Open Platform API and maps it to the
 * parser's normalize-ready shape. Throws `PROVIDER_CREDENTIALS_MISSING` when
 * credentials are not configured, and typed provider errors on failure.
 */
export async function fetchAliExpressProductOpenApi(
  env: Env,
  itemId: string,
  url: URL,
  options: FetchOpenApiOptions = {},
): Promise<AliExpressParsedProduct> {
  const credentials = openApiCredentials(env);
  if (!credentials) {
    throw new ScraperError(
      "PROVIDER_CREDENTIALS_MISSING",
      "AliExpress Open Platform is not configured; set ALIEXPRESS_OPENAPI_KEY and ALIEXPRESS_OPENAPI_SECRET to enable it",
    );
  }

  const accessToken = options.accessToken?.trim() || (await resolveAliExpressAccessToken(env));
  const shipToCountry = shipToCountryCode(options.shipToCountry);

  const params: Record<string, string> = {
    method: OPEN_API_METHOD,
    app_key: credentials.appKey,
    timestamp: dsTimestamp(),
    format: "json",
    v: "1.0",
    sign_method: DS_SIGN_METHOD,
    product_id: itemId,
    ship_to_country: shipToCountry,
    access_token: accessToken,
  };
  params["sign"] = await dsHmacSign(credentials.appSecret, params);

  let response: Response;
  try {
    response = await fetch(DS_BUSINESS_ENDPOINT, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ScraperError("PROVIDER_NETWORK_ERROR", `AliExpress Open Platform request failed: ${detail}`);
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new ScraperError("PROVIDER_HTTP_ERROR", `AliExpress Open Platform returned HTTP ${response.status}`);
  }

  const body = await response.text();
  return parseOpenApiPayload(body, { url, itemId });
}

/**
 * Maps an Open Platform `aliexpress.ds.product.get` response into the parser's
 * normalize-ready shape. Supports the production underscore envelope
 * (`aliexpress_ds_product_get_response.result`) and the dotted
 * `productDetailModel` contract.
 */
export function parseOpenApiPayload(body: string, hint: { url: URL; itemId: string }): AliExpressParsedProduct {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new ScraperError("PROVIDER_INVALID_RESPONSE", "AliExpress Open Platform returned a non-JSON response");
  }

  const envelopeRecord = asRecord(envelope);
  const methodResponse =
    asRecord(envelopeRecord?.[DOTTED_RESPONSE_KEY]) ?? asRecord(envelopeRecord?.[UNDERSCORE_RESPONSE_KEY]);
  const errorResponse = asRecord(envelopeRecord?.["error_response"]);
  if (errorResponse) {
    const code = asString(errorResponse["code"]) ?? "UNKNOWN";
    const msg = asString(errorResponse["msg"]) ?? "unknown provider error";
    if (/401|signature|invalid app|credential|IllegalAccessToken|access.?token/i.test(`${code} ${msg}`)) {
      throw new ScraperError("PROVIDER_AUTH_ERROR", `AliExpress Open Platform rejected credentials: ${msg}`);
    }
    if (/limit|frequency|throttle|exceed/i.test(msg)) {
      throw new ScraperError("PROVIDER_QUOTA_ERROR", `AliExpress Open Platform quota exceeded: ${msg}`);
    }
    throw new ScraperError("PROVIDER_API_ERROR", `AliExpress Open Platform error ${code}: ${msg}`);
  }

  const root = methodResponse ?? envelopeRecord;
  const resultWrapper = asRecord(root?.["result"]);
  const productDetailModel = asRecord(resultWrapper?.["productDetailModel"]);
  if (productDetailModel) {
    return mapOpenApiResult(productDetailModel, hint);
  }
  if (isDsProductGetResult(resultWrapper)) {
    return mapDsProductGetResult(resultWrapper, hint);
  }
  throw new ScraperError("NO_PRODUCT_DATA", "AliExpress Open Platform response carries no product payload");
}

function isDsProductGetResult(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  if (!value) return false;
  return (
    Object.prototype.hasOwnProperty.call(value, "ae_item_base_info_dto") ||
    Object.prototype.hasOwnProperty.call(value, "ae_item_sku_info_dtos")
  );
}

/** Legacy MD5 signature. Not used by official DS HMAC-SHA256 calls. */
export function openApiSign(secret: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .filter((key) => key !== "sign")
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");
  return md5(secret + sorted);
}

/** Open Platform timestamps use `yyyy-MM-dd HH:mm:ss` in the app's timezone (UTC+8). */
export function openApiTimestamp(date = new Date()): string {
  return dsTimestamp(date);
}

function shipToCountryCode(region?: string): string {
  const code = region?.trim().toUpperCase();
  if (!code) return "US";
  if (code === "UK") return "GB";
  return /^[A-Z]{2}$/.test(code) ? code : "US";
}

function mapOpenApiResult(result: Record<string, unknown>, hint: { url: URL; itemId: string }): AliExpressParsedProduct {
  const productId = asString(result["productId"]);
  const itemId = productId && /^\d{6,20}$/.test(productId) ? productId : hint.itemId;

  const title = asString(result["subject"]);
  if (!title) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress Open Platform response is missing a product title");
  }

  const price = openApiPrice(result);
  if (!price) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress Open Platform response is missing a price");
  }

  const images = openApiImages(result["imageUrls"]);
  const attributes = openApiAttributes(result["properties"]);
  const brand = findBrand(attributes);
  const seller = asString(asRecord(result["storeInfo"])?.["storeName"]) ?? asString(result["storeName"]);
  const rating = openApiRating(asRecord(result["evarating"]));

  const parsed: AliExpressParsedProduct = {
    itemId,
    title,
    price,
    images,
    attributes: { ...attributes, ...(seller ? { seller } : {}), ...(brand ? { brand } : {}) },
    raw: { openApi: result, itemId },
  };

  if (seller) parsed.seller = seller;
  if (brand) parsed.brand = brand;
  if (rating) parsed.rating = rating;

  const saleInfo = asRecord(result["saleInfo"]);
  if (saleInfo && Object.keys(saleInfo).length > 0) parsed.raw["saleInfo"] = saleInfo;

  return parsed;
}

function mapDsProductGetResult(result: Record<string, unknown>, hint: { url: URL; itemId: string }): AliExpressParsedProduct {
  const baseInfo = asRecord(result["ae_item_base_info_dto"]);
  const productId = asString(baseInfo?.["product_id"]);
  const itemId = productId && /^\d{6,20}$/.test(productId) ? productId : hint.itemId;

  const title = asString(baseInfo?.["subject"]);
  if (!title) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress Open Platform response is missing a product title");
  }

  const price = dsSkuPrice(result, baseInfo);
  if (!price) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress Open Platform response is missing a price");
  }

  const images = dsImageUrls(asRecord(result["ae_multimedia_info_dto"])?.["image_urls"]);
  const attributes = dsAttributes(result["ae_item_properties"]);
  const brand = findBrand(attributes);
  const seller = asString(asRecord(result["ae_store_info"])?.["store_name"]);
  const rating = dsRating(baseInfo);

  const parsed: AliExpressParsedProduct = {
    itemId,
    title,
    price,
    images,
    attributes: { ...attributes, ...(seller ? { seller } : {}), ...(brand ? { brand } : {}) },
    raw: { openApi: result, itemId },
  };

  if (seller) parsed.seller = seller;
  if (brand) parsed.brand = brand;
  if (rating) parsed.rating = rating;

  return parsed;
}

function dsSkuEntries(result: Record<string, unknown>): Record<string, unknown>[] {
  const skuInfo = result["ae_item_sku_info_dtos"];
  if (Array.isArray(skuInfo)) {
    return skuInfo.map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry));
  }
  const wrapped = asRecord(skuInfo)?.["ae_item_sku_info_d_t_o"];
  if (Array.isArray(wrapped)) {
    return wrapped.map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry));
  }
  const single = asRecord(wrapped);
  return single ? [single] : [];
}

function dsSkuPrice(
  result: Record<string, unknown>,
  baseInfo: Record<string, unknown> | undefined,
): AliExpressPrice | undefined {
  const baseCurrency = asString(baseInfo?.["currency_code"]);
  for (const sku of dsSkuEntries(result)) {
    const amount = toNumber(sku["offer_sale_price"]) ?? toNumber(sku["sku_price"]);
    const currency = asString(sku["currency_code"]) ?? baseCurrency;
    if (amount === undefined || !currency) continue;
    const price: AliExpressPrice = { amount, currency };
    const originalAmount = toNumber(sku["sku_price"]);
    if (originalAmount !== undefined && originalAmount > amount) price.originalAmount = originalAmount;
    return price;
  }
  return undefined;
}

function dsImageUrls(value: unknown): Array<{ url: string; alt?: string }> {
  if (typeof value === "string" && value.includes(";")) {
    return openApiImages(value.split(";"));
  }
  return openApiImages(value);
}

function dsAttributes(value: unknown): Record<string, string> {
  const attributes: Record<string, string> = {};
  const container = asRecord(value);
  const raw = container?.["ae_item_property"] ?? value;
  const entries = Array.isArray(raw) ? raw : asRecord(raw) ? [raw] : [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const name = asString(record["attr_name"]) ?? asString(record["name"]);
    const propValue = asString(record["attr_value"]) ?? asString(record["value"]);
    if (name && propValue) attributes[name] = propValue;
  }
  return attributes;
}

function dsRating(baseInfo: Record<string, unknown> | undefined): { average?: number; count?: number } | undefined {
  if (!baseInfo) return undefined;
  const average = toNumber(baseInfo["avg_evaluation_rating"]);
  const count = toNumber(baseInfo["evaluation_count"]);
  const rating: { average?: number; count?: number } = {};
  if (average !== undefined && average > 0) rating.average = average;
  if (count !== undefined && count > 0) rating.count = count;
  return Object.keys(rating).length > 0 ? rating : undefined;
}

function openApiPrice(result: Record<string, unknown>): AliExpressPrice | undefined {
  const currency = asString(result["currencyCode"]);
  const amount = toNumber(result["productPrice"]);
  if (amount === undefined || !currency) return undefined;

  const price: AliExpressPrice = { amount, currency };
  const originalAmount = toNumber(result["originalPrice"]);
  if (originalAmount !== undefined && originalAmount > amount) price.originalAmount = originalAmount;
  return price;
}

function openApiImages(value: unknown): Array<{ url: string; alt?: string }> {
  const images: Array<{ url: string; alt?: string }> = [];
  const seen = new Set<string>();
  const push = (url: unknown): void => {
    const value = asString(url);
    if (!value || seen.has(value)) return;
    seen.add(value);
    images.push({ url: value });
  };
  if (typeof value === "string") {
    push(value);
    return images;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") push(entry);
      else push(asRecord(entry)?.["imageUrl"]);
    }
  }
  return images;
}

function openApiAttributes(value: unknown): Record<string, string> {
  const attributes: Record<string, string> = {};
  const properties = asRecord(value)?.["productProps"];
  if (Array.isArray(properties)) {
    for (const entry of properties) {
      const record = asRecord(entry);
      if (!record) continue;
      const name = asString(record["name"]);
      const propValue = asString(record["value"]);
      if (name && propValue) attributes[name] = propValue;
    }
  }
  return attributes;
}

function openApiRating(value: Record<string, unknown> | undefined): { average?: number; count?: number } | undefined {
  if (!value) return undefined;
  const average = toNumber(value["evarating"]);
  const count = toNumber(value["feedbackNum"]);
  const rating: { average?: number; count?: number } = {};
  if (average !== undefined && average > 0) rating.average = average;
  if (count !== undefined && count > 0) rating.count = count;
  return Object.keys(rating).length > 0 ? rating : undefined;
}

function findBrand(attributes: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(attributes)) {
    if (/^brand$/i.test(name)) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").replace(/[^0-9.\-]/g, "");
    if (cleaned === "" || cleaned === "-") return undefined;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}
