import type { AliExpressParsedProduct, AliExpressPrice } from "./aliexpress-parser";
import { ScraperError } from "./types";
import { md5 } from "../utils/md5";

/**
 * AliExpress mtop (internal mobile/desktop gateway) provider.
 *
 * The public product page (`aliexpress.com/item/<itemId>.html`) no longer
 * embeds product data server-side. Since late 2025 the pages are client-side
 * rendered (`window._d_c_.isCSR = true`): the HTML is a shell and the browser
 * fetches the actual product payload over the internal mtop gateway
 * (`acs.aliexpress.com`, api `mtop.aliexpress.pdp.pc.query`). AliExpress's
 * anti-bot (`_____tmd_____/punish`, x5sec) punishes headless browsers,
 * including Cloudflare Browser Run, so browser rendering is not a viable
 * fallback for these pages.
 *
 * This provider speaks the same mtop protocol the website uses - a plain HTTP
 * client, no browser required. Flow:
 *
 *   1. Send an unsigned request with the product payload; the gateway answers
 *      `FAIL_SYS_TOKEN_EMPTY` and sets the `_m_h5_tk` token cookie.
 *   2. Re-sign with `MD5("<token>&<ts>&<appKey>&<data>")` and retry.
 *   3. On success the `data.result` JSON carries the full product modules
 *      (title, price, images, attributes, rating, store, ...).
 *
 * The token is only used for the immediate signed request; no session is
 * stored. Responses that the anti-bot system punishes (`FAIL_SYS_USER_VALIDATE`
 * / `RGV587_ERROR::SM`) surface as a typed `BLOCKED` error.
 */

const MTOP_HOST = "acs.aliexpress.com";
const MTOP_API = "mtop.aliexpress.pdp.pc.query";
const MTOP_VERSION = "1.0";
const MTOP_APP_KEY = "12574478";
const MTOP_JSV = "2.6.1";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Regional parameters the mtop gateway uses to localize price/currency. */
export interface MtopRegion {
  site: string;
  lang: string;
  currency: string;
  country: string;
}

const REGION_BY_TLD: Record<string, MtopRegion> = {
  com: { site: "en", lang: "en_US", currency: "USD", country: "US" },
  us: { site: "en", lang: "en_US", currency: "USD", country: "US" },
  "co.uk": { site: "gb", lang: "en_GB", currency: "GBP", country: "GB" },
  de: { site: "de", lang: "de_DE", currency: "EUR", country: "DE" },
  fr: { site: "fr", lang: "fr_FR", currency: "EUR", country: "FR" },
  es: { site: "es", lang: "es_ES", currency: "EUR", country: "ES" },
  it: { site: "it", lang: "it_IT", currency: "EUR", country: "IT" },
  nl: { site: "nl", lang: "nl_NL", currency: "EUR", country: "NL" },
  pt: { site: "pt", lang: "pt_PT", currency: "EUR", country: "PT" },
  pl: { site: "pl", lang: "pl_PL", currency: "PLN", country: "PL" },
  cz: { site: "cz", lang: "cs_CZ", currency: "CZK", country: "CZ" },
  ru: { site: "ru", lang: "ru_RU", currency: "RUB", country: "RU" },
  il: { site: "il", lang: "he_IL", currency: "ILS", country: "IL" },
  mx: { site: "mx", lang: "es_MX", currency: "MXN", country: "MX" },
  br: { site: "br", lang: "pt_BR", currency: "BRL", country: "BR" },
  ar: { site: "ar", lang: "es_AR", currency: "ARS", country: "AR" },
  cl: { site: "cl", lang: "es_CL", currency: "CLP", country: "CL" },
  tr: { site: "tr", lang: "tr_TR", currency: "TRY", country: "TR" },
  in: { site: "in", lang: "en_IN", currency: "INR", country: "IN" },
  id: { site: "idn", lang: "id_ID", currency: "IDR", country: "ID" },
  sg: { site: "sg", lang: "en_SG", currency: "SGD", country: "SG" },
  th: { site: "th", lang: "th_TH", currency: "THB", country: "TH" },
  jp: { site: "jp", lang: "ja_JP", currency: "JPY", country: "JP" },
  kr: { site: "kr", lang: "ko_KR", currency: "KRW", country: "KR" },
  au: { site: "au", lang: "en_AU", currency: "AUD", country: "AU" },
  ca: { site: "ca", lang: "en_CA", currency: "CAD", country: "CA" },
  sa: { site: "sa", lang: "ar_SA", currency: "SAR", country: "SA" },
  ae: { site: "ae", lang: "en_AE", currency: "AED", country: "AE" },
  eg: { site: "eg", lang: "ar_EG", currency: "EGP", country: "EG" },
  ma: { site: "ma", lang: "fr_MA", currency: "MAD", country: "MA" },
  za: { site: "za", lang: "en_ZA", currency: "ZAR", country: "ZA" },
  nz: { site: "nz", lang: "en_NZ", currency: "NZD", country: "NZ" },
};

const DEFAULT_REGION: MtopRegion = { site: "en", lang: "en_US", currency: "USD", country: "US" };

/**
 * Deterministic region for a supported AliExpress host (defaults to en_US/USD).
 * Regional sites are served from subdomains (`ar.aliexpress.com`,
 * `id.aliexpress.com`) as well as country TLDs (`aliexpress.co.uk`), so both
 * the subdomain prefix and the TLD are considered.
 */
export function regionForHost(hostname: string): MtopRegion {
  const lower = hostname.toLowerCase();
  const subdomain = lower.match(/^([a-z]{2,3}(?:\.[a-z]{2})?)\.aliexpress\.(?:[a-z]{2,3}(?:\.[a-z]{2})?)$/);
  if (subdomain?.[1] && REGION_BY_TLD[subdomain[1]]) return REGION_BY_TLD[subdomain[1]];
  const tld = lower.match(/aliexpress\.([a-z]{2,3}(?:\.[a-z]{2})?)$/);
  return (tld && REGION_BY_TLD[tld[1]]) ?? DEFAULT_REGION;
}

interface MtopCallResult {
  body: string;
  setCookie?: string;
}

/** Minimal envelope of the JSONP response the mtop gateway returns. */
interface MtopEnvelope {
  ret?: string[];
  data?: { result?: unknown } | Record<string, unknown> | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * Fetches a product through the mtop gateway and maps it to the parser's
 * normalize-ready shape. No browser and no API key required.
 */
export async function fetchAliExpressProductMtop(itemId: string, url: URL): Promise<AliExpressParsedProduct> {
  const region = regionForHost(url.hostname);
  const data = JSON.stringify({
    productId: itemId,
    _lang: region.lang,
    _currency: region.currency,
    country: region.country,
    channel: "pc",
    clientType: "pc",
    ext: JSON.stringify({ site: region.site, crawler: false }),
  });

  let call = await callMtop(data, "");
  let token = extractToken(call.setCookie);
  if (needsTokenRetry(call.body) && token) {
    call = await callMtop(data, token);
  }

  return parseMtopPayload(call.body, { url, itemId });
}

async function callMtop(data: string, token: string): Promise<MtopCallResult> {
  const timestamp = String(Date.now());
  const sign = md5(`${token}&${timestamp}&${MTOP_APP_KEY}&${data}`);

  const endpoint = new URL(`https://${MTOP_HOST}/h5/${MTOP_API}/${MTOP_VERSION}/`);
  endpoint.searchParams.set("jsv", MTOP_JSV);
  endpoint.searchParams.set("appKey", MTOP_APP_KEY);
  endpoint.searchParams.set("t", timestamp);
  endpoint.searchParams.set("sign", sign);
  endpoint.searchParams.set("type", "originaljsonp");
  endpoint.searchParams.set("data", data);

  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    referer: `https://${MTOP_HOST}/`,
  };
  if (token) headers.cookie = `_m_h5_tk=${token}`;

  let response: Response;
  try {
    response = await fetch(endpoint.href, { headers });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ScraperError("MTop_HTTP_ERROR", `mtop gateway request failed: ${detail}`);
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new ScraperError("MTop_HTTP_ERROR", `mtop gateway returned HTTP ${response.status}`);
  }

  return {
    body: await response.text(),
    setCookie: response.headers.get("set-cookie") ?? undefined,
  };
}

/** Reads the `_m_h5_tk` token from a `Set-Cookie` header value. */
export function extractToken(setCookie: string | undefined): string | undefined {
  if (!setCookie) return undefined;
  const match = setCookie.match(/(?:^|[,;\s])_m_h5_tk=([^;,]+)/);
  if (!match) return undefined;
  const token = match[1].split("_")[0];
  return token.length > 0 ? token : undefined;
}

/** True when the gateway wants a token-signed retry (token missing/expired). */
export function needsTokenRetry(body: string): boolean {
  return /FAIL_SYS_TOKEN_(EMPTY|EXOIRED|ILLEGAL)/.test(body);
}

/**
 * Parses an mtop JSONP response into the normalize-ready shape. Throws a typed
 * `ScraperError` for anti-bot punishment (`BLOCKED`) or missing product data
 * (`NO_PRODUCT_DATA`).
 */
export function parseMtopPayload(body: string, hint: { url: URL; itemId: string }): AliExpressParsedProduct {
  const envelope = unwrapJsonp(body);
  const ret = envelope?.ret ?? [];
  const retText = ret.join(" ");

  const punishUrl = /_____tmd_____|RGV587_ERROR|FAIL_SYS_USER_VALIDATE/.test(retText);
  if (punishUrl) {
    throw new ScraperError(
      "BLOCKED",
      "AliExpress mtop gateway returned an anti-bot challenge (RGV587_ERROR::SM); no product data available",
    );
  }

  if (/FAIL_SYS_TOKEN/.test(retText)) {
    throw new ScraperError(
      "BLOCKED",
      "AliExpress mtop gateway refused the request token; no product data available",
    );
  }

  if (!ret.some((item) => item.startsWith("SUCCESS"))) {
    const detail = retText.slice(0, 200) || "unknown mtop error";
    throw new ScraperError("MTop_API_ERROR", `AliExpress mtop gateway returned: ${detail}`);
  }

  const result = (envelope?.data as { result?: unknown } | null)?.result;
  if (!isObject(result)) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress mtop response carries no product payload");
  }

  return mapMtopResult(result, hint);
}

function unwrapJsonp(body: string): MtopEnvelope | undefined {
  const trimmed = body.trim();
  const json = trimmed.startsWith("{") ? trimmed : trimmed.replace(/^[^(]*\(/, "").replace(/\)[^)]*$/, "");
  try {
    const parsed = JSON.parse(json) as unknown;
    return isObject(parsed) ? (parsed as unknown as MtopEnvelope) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Maps the mtop `data.result` module map into `AliExpressParsedProduct`, the
 * exact shape `parseAliExpressPage` produces, so the caller can feed it through
 * the same `normalizeProduct` pipeline unchanged.
 */
export function mapMtopResult(result: Record<string, unknown>, hint: { url: URL; itemId: string }): AliExpressParsedProduct {
  const globalDataRecord = asRecord(result["GLOBAL_DATA"]);
  const globalData = asRecord(globalDataRecord?.["globalData"]);
  const productInfo = asRecord(globalData?.["productInfo"]);
  const productId = asString(productInfo?.["productId"]) ?? asString(globalData?.["productId"]);

  const itemId = productId && /^\d{6,20}$/.test(productId) ? productId : hint.itemId;

  const titleModule = asRecord(result["PRODUCT_TITLE"]);
  const title = asString(titleModule?.["text"]) ?? asString(globalData?.["subject"]);
  if (!title) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress mtop response is missing a product title");
  }

  const price = parseMtopPrice(asRecord(result["PRICE"]));
  if (!price) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress mtop response is missing a price");
  }

  const imageHeader = asRecord(result["HEADER_IMAGE_PC"]);
  const images = collectImages(imageHeader);
  const attributes = collectAttributes(asRecord(result["PRODUCT_PROP_PC"]));
  const seller =
    asString(asRecord(result["SHOP_CARD_PC"])?.["storeName"]) ?? asString(globalData?.["sellerName"]);
  const brand = findBrand(attributes);
  const rating = parseMtopRating(asRecord(result["PC_RATING"]));
  const available = parseAvailability(globalData, productInfo);

  const parsed: AliExpressParsedProduct = {
    itemId,
    title,
    price,
    images,
    attributes: { ...attributes, ...(seller ? { seller } : {}), ...(brand ? { brand } : {}) },
    raw: { mtop: result, itemId },
  };

  const detailUrl = asString(productInfo?.["detailUrl"]);
  if (detailUrl) {
    try {
      const parsedUrl = new URL(detailUrl);
      parsed.raw["productUrl"] = parsedUrl.href;
    } catch {
      // Malformed detailUrl - ignore.
    }
  }

  if (seller) parsed.seller = seller;
  if (brand) parsed.brand = brand;
  if (rating) parsed.rating = rating;
  if (available !== undefined) parsed.availability = available;

  const category = parseCategoryPath(asString(globalData?.["categoryPath"]));
  if (category) parsed.category = category;

  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function parseMtopPrice(priceModule: Record<string, unknown> | undefined): AliExpressPrice | undefined {
  if (!priceModule) return undefined;

  const target = asRecord(priceModule["targetSkuPriceInfo"]);
  const original = asRecord(target?.["originalPrice"]);
  const currency = asString(original?.["currency"]);

  let amount = parseSaleAmount(asString(target?.["salePriceLocal"]));
  if (amount === undefined) {
    const skuMap = asRecord(priceModule["skuIdStrPriceInfoMap"]);
    const first = skuMap ? firstEntry(skuMap) : undefined;
    amount = parseSaleAmount(asString(first?.["salePriceLocal"]));
  }
  if (amount === undefined) {
    const selected = asString(priceModule["selectedSkuId"]);
    const skuMap = asRecord(priceModule["skuIdStrPriceInfoMap"]);
    const entry = skuMap && selected ? asRecord(skuMap[selected]) : undefined;
    amount = entry ? parseSaleAmount(asString(entry["salePriceLocal"])) : undefined;
  }
  if (amount === undefined) return undefined;
  if (!currency) return undefined;

  const price: AliExpressPrice = { amount, currency };
  const originalAmount = toNumber(original?.["value"]) ?? toNumber(target?.["value"]);
  if (originalAmount !== undefined && originalAmount > amount) price.originalAmount = originalAmount;
  return price;
}

/** `salePriceLocal` is `"Rp343,297|343297|..."` - the numeric part is segment 1. */
function parseSaleAmount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const segments = value.split("|");
  if (segments.length >= 2) {
    const numeric = toNumber(segments[1]);
    if (numeric !== undefined) return numeric;
  }
  return toNumber(segments[0]);
}

function firstEntry(record: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const value of Object.values(record)) {
    const entry = asRecord(value);
    if (entry) return entry;
  }
  return undefined;
}

function collectImages(imageHeader: Record<string, unknown> | undefined): Array<{ url: string; alt?: string }> {
  const images: Array<{ url: string; alt?: string }> = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const url = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
    if (seen.has(url)) return;
    seen.add(url);
    images.push({ url });
  };

  const mainList = imageHeader?.["mainImages"];
  if (Array.isArray(mainList)) {
    for (const entry of mainList) {
      if (typeof entry === "string") push(entry);
      else push(asRecord(entry)?.["imageUrl"]);
    }
  }
  for (const key of ["imagePathList", "imgList", "summImagePathList"]) {
    const list = imageHeader?.[key];
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (typeof entry === "string") push(entry);
        else push(asRecord(entry)?.["imageUrl"]);
      }
    }
  }
  return images;
}

function collectAttributes(propModule: Record<string, unknown> | undefined): Record<string, string> {
  const attributes: Record<string, string> = {};
  const props = propModule?.["showedProps"];
  if (Array.isArray(props)) {
    for (const entry of props) {
      const record = asRecord(entry);
      if (!record) continue;
      const name = asString(record["attrName"]);
      const value = asString(record["attrValue"]);
      if (name && value) attributes[name] = value;
    }
  }
  return attributes;
}

function findBrand(attributes: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(attributes)) {
    if (/^brand$/i.test(name)) return value;
  }
  return undefined;
}

function parseMtopRating(ratingModule: Record<string, unknown> | undefined): { average?: number; count?: number } | undefined {
  if (!ratingModule) return undefined;
  const average = toNumber(ratingModule["rating"]);
  const count = toNumber(ratingModule["totalValidNum"]);
  const rating: { average?: number; count?: number } = {};
  if (average !== undefined && average > 0) rating.average = average;
  if (count !== undefined && count > 0) rating.count = count;
  return Object.keys(rating).length > 0 ? rating : undefined;
}

function parseAvailability(globalData: Record<string, unknown> | undefined, productInfo: Record<string, unknown> | undefined): boolean | undefined {
  const hasStock = productInfo?.["hasStock"];
  if (typeof hasStock === "boolean") return hasStock;
  const offline = asRecord(globalData?.["offlineInfo"]);
  const itemStatus = toNumber(offline?.["itemStatus"]);
  if (itemStatus !== undefined) return itemStatus === 0;
  return undefined;
}

/** `categoryPath` is `"66/200001168/201375716/200001211"` - ids, no names. */
function parseCategoryPath(path: string | undefined): { id?: string; name: string; path?: string[] } | undefined {
  if (!path) return undefined;
  const segments = path.split("/").map((entry) => entry.trim()).filter(Boolean);
  if (segments.length === 0) return undefined;
  const id = segments[segments.length - 1];
  return { id, name: id, path: segments };
}
