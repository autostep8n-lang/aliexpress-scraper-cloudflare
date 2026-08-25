import type { Env } from "../env";
import type { AliExpressParsedProduct, AliExpressPrice } from "./aliexpress-parser";
import { ScraperError } from "./types";
import { md5 } from "../utils/md5";

/**
 * AliExpress Open Platform (open.aliexpress.com) provider.
 *
 * The officially supported way to query AliExpress product data programmatically.
 * Unlike scraping the public HTML or the internal mtop gateway, the Open
 * Platform API is designed for automation: it never serves the anti-bot
 * punish page and is the architecture this scraper should use in production
 * for high-volume / reliable ingestion.
 *
 * This adapter implements the Open Platform "TOP"-style signing protocol used
 * by the dropshipping product endpoint `aliexpress.ds.product.get`:
 *
 *   - Request: `POST https://api.aliexpress.com/sync` (form-encoded)
 *   - Params: `method`, `app_key`, `timestamp` (`yyyy-MM-dd HH:mm:ss`),
 *     `format=json`, `v=1.0`, `sign_method=md5`, plus the API-specific params.
 *   - Signature: `sign = MD5(appSecret + <sorted params as "keyvalue" pairs>)`
 *     over every param except `sign` itself, sorted by key ascending.
 *
 * Credentials come from the environment (`ALIEXPRESS_OPENAPI_KEY` /
 * `ALIEXPRESS_OPENAPI_SECRET`) and are NEVER hardcoded. When they are not
 * configured the adapter throws a typed `PROVIDER_CREDENTIALS_MISSING` error so
 * callers can fall back to the no-credential providers (direct HTML, mtop).
 *
 * External setup still required:
 *   1. Register an app on https://open.aliexpress.com and enable the
 *      `aliexpress.ds.product.get` API for the "Dropshipping" category.
 *   2. Set `ALIEXPRESS_OPENAPI_KEY` and `ALIEXPRESS_OPENAPI_SECRET` as Worker
 *      secrets (Cloudflare dashboard or `wrangler secret put`).
 *   3. If the app was registered in a non-UTC timezone, the timestamp used
 *      here must match that timezone; adjust `TIMESTAMP_TZ_OFFSET_HOURS`.
 */

const OPEN_API_ENDPOINT = "https://api.aliexpress.com/sync";
const OPEN_API_METHOD = "aliexpress.ds.product.get";

/** Hour offset of the app's registered timezone vs UTC (China = +8). */
const TIMESTAMP_TZ_OFFSET_HOURS = 8;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface OpenApiCredentials {
  appKey: string;
  appSecret: string;
}

export function openApiCredentials(env: Env): OpenApiCredentials | undefined {
  const appKey = env.ALIEXPRESS_OPENAPI_KEY?.trim();
  const appSecret = env.ALIEXPRESS_OPENAPI_SECRET?.trim();
  if (!appKey || !appSecret) return undefined;
  return { appKey, appSecret };
}

export function hasOpenApiCredentials(env: Env): boolean {
  return openApiCredentials(env) !== undefined;
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
): Promise<AliExpressParsedProduct> {
  const credentials = openApiCredentials(env);
  if (!credentials) {
    throw new ScraperError(
      "PROVIDER_CREDENTIALS_MISSING",
      "AliExpress Open Platform is not configured; set ALIEXPRESS_OPENAPI_KEY and ALIEXPRESS_OPENAPI_SECRET to enable it",
    );
  }

  const params: Record<string, string> = {
    method: OPEN_API_METHOD,
    app_key: credentials.appKey,
    timestamp: openApiTimestamp(),
    format: "json",
    v: "1.0",
    sign_method: "md5",
    product_id: itemId,
  };
  params["sign"] = openApiSign(credentials.appSecret, params);

  let response: Response;
  try {
    response = await fetch(OPEN_API_ENDPOINT, {
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
 * normalize-ready shape. Exported for tests; the payload shape follows the
 * documented `productDetailModel` contract.
 */
export function parseOpenApiPayload(body: string, hint: { url: URL; itemId: string }): AliExpressParsedProduct {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new ScraperError("PROVIDER_INVALID_RESPONSE", "AliExpress Open Platform returned a non-JSON response");
  }

  const envelopeRecord = asRecord(envelope);
  const methodResponse = asRecord(envelopeRecord?.[`${OPEN_API_METHOD}_response`]);
  const errorResponse = asRecord(envelopeRecord?.["error_response"]);
  if (errorResponse) {
    const code = asString(errorResponse["code"]) ?? "UNKNOWN";
    const msg = asString(errorResponse["msg"]) ?? "unknown provider error";
    if (/401|signature|invalid app|credential/i.test(`${code} ${msg}`)) {
      throw new ScraperError("PROVIDER_AUTH_ERROR", `AliExpress Open Platform rejected credentials: ${msg}`);
    }
    if (/limit|frequency|throttle|exceed/i.test(msg)) {
      throw new ScraperError("PROVIDER_QUOTA_ERROR", `AliExpress Open Platform quota exceeded: ${msg}`);
    }
    throw new ScraperError("PROVIDER_API_ERROR", `AliExpress Open Platform error ${code}: ${msg}`);
  }

  const root = methodResponse ?? envelopeRecord;
  const resultWrapper = asRecord(root?.["result"]);
  const result = asRecord(resultWrapper?.["productDetailModel"]);
  if (!result) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress Open Platform response carries no product payload");
  }

  return mapOpenApiResult(result, hint);
}

/** Signature: `MD5(secret + sorted "keyvalue" pairs of every param but sign)`. */
export function openApiSign(secret: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .filter((key) => key !== "sign")
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");
  return md5(secret + sorted);
}

/** Open Platform timestamps use `yyyy-MM-dd HH:mm:ss` in the app's timezone. */
export function openApiTimestamp(date = new Date()): string {
  const shifted = new Date(date.getTime() + TIMESTAMP_TZ_OFFSET_HOURS * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(
    shifted.getUTCHours(),
  )}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
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
