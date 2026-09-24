import type { Env } from "../env";
import { logInfo } from "../logging";
import { ScraperError } from "./types";
import { openApiCredentials } from "./aliexpress-openapi-credentials";
import { resolveAliExpressAccessToken } from "./aliexpress-oauth";
import { DS_BUSINESS_ENDPOINT, DS_SIGN_METHOD, dsHmacSign, dsTimestamp, quoteJsonIntegerFields } from "./aliexpress-sign";

/**
 * Official AliExpress Dropshipping text search (`aliexpress.ds.text.search`).
 *
 * Required business params: `local`, `countryCode`, `currency`.
 * Optional: `keyWord`, `categoryId`, `pageSize`, `pageIndex`, ...
 * Result path: `data.products[].itemId`.
 */

const SEARCH_METHOD = "aliexpress.ds.text.search";
const DOTTED_RESPONSE_KEY = `${SEARCH_METHOD}_response`;
const UNDERSCORE_RESPONSE_KEY = "aliexpress_ds_text_search_response";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;
const INTEGER_FIELDS = ["itemId", "productId", "item_id", "product_id"] as const;

export const DEFAULT_DS_LOCAL = "en_US";
export const DEFAULT_DS_COUNTRY = "US";
export const DEFAULT_DS_CURRENCY = "USD";

export interface DsTextSearchQuery {
  keyWord?: string;
  categoryId?: string;
  countryCode?: string;
  local?: string;
  currency?: string;
  pageSize?: number;
  pageIndex?: number;
  accessToken?: string;
}

export interface DsSearchProduct {
  itemId: string;
  raw: Record<string, unknown>;
}

export interface DsTextSearchResult {
  products: DsSearchProduct[];
  total?: number;
}

const CURRENCY_BY_COUNTRY: Record<string, string> = {
  US: "USD",
  GB: "GBP",
  UK: "GBP",
  DE: "EUR",
  FR: "EUR",
  ES: "EUR",
  IT: "EUR",
  NL: "EUR",
  PT: "EUR",
  AU: "AUD",
  CA: "CAD",
  JP: "JPY",
  KR: "KRW",
  SG: "SGD",
  BR: "BRL",
  MX: "MXN",
  IN: "INR",
  AE: "AED",
};

const LOCAL_BY_COUNTRY: Record<string, string> = {
  US: "en_US",
  GB: "en_GB",
  UK: "en_GB",
  DE: "de_DE",
  FR: "fr_FR",
  ES: "es_ES",
  IT: "it_IT",
  NL: "nl_NL",
  PT: "pt_PT",
  AU: "en_AU",
  CA: "en_CA",
  JP: "ja_JP",
  KR: "ko_KR",
  SG: "en_SG",
  BR: "pt_BR",
  MX: "es_MX",
  IN: "en_IN",
  AE: "en_AE",
};

export function dsCountryCode(region?: string): string {
  const code = region?.trim().toUpperCase();
  if (!code) return DEFAULT_DS_COUNTRY;
  if (code === "UK") return "GB";
  return /^[A-Z]{2}$/.test(code) ? code : DEFAULT_DS_COUNTRY;
}

export function dsCurrencyForCountry(countryCode: string): string {
  return CURRENCY_BY_COUNTRY[countryCode] ?? DEFAULT_DS_CURRENCY;
}

export function dsLocalForCountry(countryCode: string): string {
  return LOCAL_BY_COUNTRY[countryCode] ?? DEFAULT_DS_LOCAL;
}

export async function searchAliExpressDsText(env: Env, query: DsTextSearchQuery): Promise<DsTextSearchResult> {
  const credentials = openApiCredentials(env);
  if (!credentials) {
    throw new ScraperError(
      "PROVIDER_CREDENTIALS_MISSING",
      "AliExpress Open Platform is not configured; set ALIEXPRESS_OPENAPI_KEY and ALIEXPRESS_OPENAPI_SECRET to enable it",
    );
  }

  const countryCode = dsCountryCode(query.countryCode);
  const accessToken = query.accessToken?.trim() || (await resolveAliExpressAccessToken(env));
  const pageSize = clampPageSize(query.pageSize);
  const pageIndex = query.pageIndex && query.pageIndex > 0 ? Math.trunc(query.pageIndex) : 1;

  const params: Record<string, string> = {
    method: SEARCH_METHOD,
    app_key: credentials.appKey,
    timestamp: dsTimestamp(),
    format: "json",
    v: "1.0",
    sign_method: DS_SIGN_METHOD,
    access_token: accessToken,
    local: query.local?.trim() || dsLocalForCountry(countryCode),
    countryCode,
    currency: query.currency?.trim() || dsCurrencyForCountry(countryCode),
    pageSize: String(pageSize),
    pageIndex: String(pageIndex),
  };
  const keyWord = query.keyWord?.trim();
  const categoryId = query.categoryId?.trim();
  if (keyWord) params["keyWord"] = keyWord;
  if (categoryId) params["categoryId"] = categoryId;
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ScraperError("TIMEOUT", "AliExpress Dropshipping text search timed out");
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new ScraperError("PROVIDER_NETWORK_ERROR", `AliExpress Dropshipping text search failed: ${detail}`);
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new ScraperError("PROVIDER_HTTP_ERROR", `AliExpress Dropshipping text search returned HTTP ${response.status}`);
  }

  const body = await response.text();
  logInfo("aliexpress.ds.text.search.response", dsSearchResponseDiagnostics(response.status, body));
  return parseDsTextSearchPayload(body);
}

/** Temporary diagnostic fields only. Never includes tokens, secrets, sign, or request body. */
export function dsSearchResponseDiagnostics(status: number, body: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    httpStatus: status,
    bodyLength: body.length,
    topLevelKeys: [],
    hasUnderscoreResponse: false,
    hasDottedResponse: false,
    hasErrorResponse: false,
  };
  try {
    const parsed: unknown = JSON.parse(body);
    const record = asRecord(parsed);
    if (!record) return fields;
    const keys = Object.keys(record);
    fields.topLevelKeys = keys;
    fields.hasUnderscoreResponse = Object.prototype.hasOwnProperty.call(record, "aliexpress_ds_text_search_response");
    fields.hasDottedResponse = Object.prototype.hasOwnProperty.call(record, "aliexpress.ds.text.search_response");
    fields.hasErrorResponse = Object.prototype.hasOwnProperty.call(record, "error_response");
    const errorResponse = asRecord(record["error_response"]);
    const providerCode = asString(record["code"]) ?? asString(errorResponse?.["code"]);
    const providerMsg = asString(record["msg"]) ?? asString(errorResponse?.["msg"]);
    if (providerCode) fields.providerCode = providerCode;
    if (providerMsg) fields.providerMsg = providerMsg;
  } catch {
    fields.parseableJson = false;
  }
  return fields;
}

export function parseDsTextSearchPayload(body: string): DsTextSearchResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(quoteJsonIntegerFields(body, INTEGER_FIELDS));
  } catch {
    throw new ScraperError("PROVIDER_INVALID_RESPONSE", "AliExpress Dropshipping text search returned a non-JSON response");
  }

  const envelopeRecord = asRecord(envelope);
  logInfo("aliexpress.ds.text.search.response", dsTextSearchEnvelopeDiagnostic(envelopeRecord));
  logInfo("aliexpress.ds.text.search.underscore_response", dsTextSearchUnderscoreResponseDiagnostic(envelopeRecord));
  const methodResponse =
    asRecord(envelopeRecord?.[DOTTED_RESPONSE_KEY]) ??
    coerceDiagnosticRecord(envelopeRecord?.[UNDERSCORE_RESPONSE_KEY]);
  const errorResponse = asRecord(envelopeRecord?.["error_response"]);
  if (errorResponse) {
    throw mapProviderError(errorResponse);
  }

  const root = methodResponse ?? envelopeRecord;
  if (!root) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress Dropshipping text search carries no product payload");
  }

  const result = asRecord(root["result"]);
  const data = asRecord(root["data"]) ?? asRecord(result?.["data"]) ?? result ?? root;
  const productsRaw = data["products"] ?? result?.["products"] ?? root["products"];
  const products = extractProducts(productsRaw);
  if (!Array.isArray(productsRaw) && products.length === 0 && !asRecord(data)) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress Dropshipping text search carries no product payload");
  }

  const total =
    toFiniteInt(data["total"]) ??
    toFiniteInt(data["totalCount"]) ??
    toFiniteInt(result?.["total"]) ??
    toFiniteInt(result?.["totalCount"]) ??
    undefined;
  return total === undefined ? { products } : { products, total };
}

/** Envelope keys/flags only. Never includes token, secret, sign, or body values. */
export function dsTextSearchEnvelopeDiagnostic(envelope: Record<string, unknown> | undefined): Record<string, unknown> {
  const keys = envelope ? Object.keys(envelope) : [];
  return {
    keys,
    hasDottedResponse: Boolean(envelope && DOTTED_RESPONSE_KEY in envelope),
    hasUnderscoreResponse: Boolean(envelope && UNDERSCORE_RESPONSE_KEY in envelope),
    hasErrorResponse: Boolean(envelope && "error_response" in envelope),
  };
}

/**
 * Keys/types inside `aliexpress_ds_text_search_response` only.
 * Never includes token, secret, sign, product values, or the raw body.
 */
export function dsTextSearchUnderscoreResponseDiagnostic(
  envelope: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const inner = coerceDiagnosticRecord(envelope?.[UNDERSCORE_RESPONSE_KEY]);
  if (!inner) {
    return { present: false };
  }

  const data = coerceDiagnosticRecord(inner["data"]);
  const result = coerceDiagnosticRecord(inner["result"]);
  const products = inner["products"] ?? data?.["products"] ?? result?.["products"];
  const nested = {
    result: objectKeys(inner["result"]),
    items: objectKeys(inner["items"]) ?? objectKeys(data?.["items"]) ?? objectKeys(result?.["items"]),
    products: objectKeys(inner["products"]) ?? objectKeys(data?.["products"]) ?? objectKeys(result?.["products"]),
  };

  return {
    present: true,
    keys: Object.keys(inner),
    dataKeys: data ? Object.keys(data) : undefined,
    resultKeys: result ? Object.keys(result) : undefined,
    productsType: products === undefined ? undefined : diagnosticType(products),
    ...(Array.isArray(products)
      ? {
          productsLength: products.length,
          firstProductKeys: objectKeys(products[0]),
        }
      : {}),
    nestedContainerKeys: {
      ...(nested.result ? { result: nested.result } : {}),
      ...(nested.items ? { items: nested.items } : {}),
      ...(nested.products ? { products: nested.products } : {}),
    },
  };
}

function coerceDiagnosticRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function objectKeys(value: unknown): string[] | undefined {
  const record = coerceDiagnosticRecord(value);
  return record ? Object.keys(record) : undefined;
}

function diagnosticType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function extractProducts(value: unknown): DsSearchProduct[] {
  if (!Array.isArray(value)) return [];
  const products: DsSearchProduct[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const itemId =
      asItemId(record["itemId"]) ?? asItemId(record["productId"]) ?? asItemId(record["item_id"]) ?? asItemId(record["product_id"]);
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    products.push({ itemId, raw: record });
  }
  return products;
}

function mapProviderError(errorResponse: Record<string, unknown>): ScraperError {
  const code = asString(errorResponse["code"]) ?? "UNKNOWN";
  const msg = asString(errorResponse["msg"]) ?? "unknown provider error";
  if (/401|signature|invalid app|credential|IllegalAccessToken|access.?token/i.test(`${code} ${msg}`)) {
    return new ScraperError("PROVIDER_AUTH_ERROR", `AliExpress Dropshipping text search rejected credentials: ${msg}`);
  }
  if (/limit|frequency|throttle|exceed/i.test(msg)) {
    return new ScraperError("PROVIDER_QUOTA_ERROR", `AliExpress Dropshipping text search quota exceeded: ${msg}`);
  }
  return new ScraperError("PROVIDER_API_ERROR", `AliExpress Dropshipping text search error ${code}: ${msg}`);
}

function clampPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20;
  return Math.min(50, Math.max(1, Math.trunc(value)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function asItemId(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  return /^\d{6,20}$/.test(text) ? text : undefined;
}

function toFiniteInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return undefined;
}
