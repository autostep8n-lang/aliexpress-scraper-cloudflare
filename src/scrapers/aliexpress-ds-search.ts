import type { Env } from "../env";
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
  return parseDsTextSearchPayload(body);
}

export function parseDsTextSearchPayload(body: string): DsTextSearchResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(quoteJsonIntegerFields(body, INTEGER_FIELDS));
  } catch {
    throw new ScraperError("PROVIDER_INVALID_RESPONSE", "AliExpress Dropshipping text search returned a non-JSON response");
  }

  const envelopeRecord = asRecord(envelope);
  const methodResponse = asRecord(envelopeRecord?.[`${SEARCH_METHOD}_response`]);
  const errorResponse = asRecord(envelopeRecord?.["error_response"]);
  if (errorResponse) {
    throw mapProviderError(errorResponse);
  }

  const root = methodResponse ?? envelopeRecord;
  if (!root) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress Dropshipping text search carries no product payload");
  }

  const result = asRecord(root["result"]) ?? root;
  const data = asRecord(result["data"]) ?? result;
  const productsRaw = data["products"] ?? result["products"];
  const products = extractProducts(productsRaw);
  if (!Array.isArray(productsRaw) && products.length === 0 && !asRecord(data)) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress Dropshipping text search carries no product payload");
  }

  const total = toFiniteInt(data["total"]) ?? toFiniteInt(result["total"]) ?? undefined;
  return total === undefined ? { products } : { products, total };
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
