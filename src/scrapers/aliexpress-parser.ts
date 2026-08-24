import { isHttpUrl } from "../utils/url";
import { ScraperError } from "./types";

/**
 * AliExpress product page parser.
 *
 * AliExpress product pages embed the bulk of their product data in a
 * `window.runParams = {...}` JSON literal (a set of "modules": titleModule,
 * priceModule, skuModule, imageModule, specsModule, storeModule,
 * feedbackModule, ...). On some page versions the same modules are delivered
 * through `RDS.init({...})` blocks. This parser prefers those embedded JSON
 * sources, falls back to schema.org JSON-LD blocks, and only then to stable
 * HTML metadata (og: tags, canonical link, title). Values are never
 * fabricated: fields that cannot be derived are omitted, and the page is
 * rejected with a typed error only when the item id, title or price cannot be
 * determined. AliExpress identity is the numeric item id, so deduplication
 * keeps working as `aliexpress:<itemId>`.
 */

export interface AliExpressPrice {
  amount: number;
  currency: string;
  originalAmount?: number;
}

export interface AliExpressImage {
  url: string;
  alt?: string;
}

export interface AliExpressCategory {
  id?: string;
  name: string;
  path?: string[];
}

export interface AliExpressRating {
  average?: number;
  count?: number;
}

/** normalizeProduct-ready interpretation of one AliExpress product page. */
export interface AliExpressParsedProduct {
  itemId: string;
  title: string;
  description?: string;
  price: AliExpressPrice;
  images: AliExpressImage[];
  category?: AliExpressCategory;
  rating?: AliExpressRating;
  availability?: boolean;
  seller?: string;
  brand?: string;
  attributes: Record<string, string>;
  /**
   * The parsed schema.org `Product` graph merged with the extracted runParams
   * modules. Preserved for `product_sources.raw` so AliExpress-specific
   * fields (variants, store, seller reviews, ...) survive even when they have
   * no normalized home.
   */
  raw: Record<string, unknown>;
}

/** Optional context passed in by the caller (the adapter). */
export interface AliExpressParseHint {
  url?: URL;
  itemId?: string;
}

/** AliExpress item id: a numeric order/item id of 6-20 digits. */
const ITEM_ID_RE = /^\d{6,20}$/;

/** Product page path prefixes: `/item/<id>.html`, `/item/<id>`. */
const ITEM_PATH_RE = /^\/(?:item)\/(\d{6,20})(?:\.html)?(?:\/|$)/;

/** True for product page paths carrying a numeric item id segment. */
export function isAliExpressItemPath(pathname: string): boolean {
  return ITEM_PATH_RE.test(pathname);
}

/** Extracts the numeric item id from a product pathname. */
export function extractItemIdFromPathname(pathname: string): string | undefined {
  const match = ITEM_PATH_RE.exec(pathname);
  if (!match) return undefined;
  return match[1];
}

/** True for aliexpress.com and any of its subdomains. */
export function isAliExpressCom(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "aliexpress.com" || host.endsWith(".aliexpress.com");
}

/**
 * True for any AliExpress domain: `aliexpress.com` (+ subdomains such as
 * `www.`, `ru.`, `pt.`) and the country domains such as `aliexpress.co.uk`,
 * `aliexpress.de`, `aliexpress.us`.
 */
export function isAliExpressHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (isAliExpressCom(host)) return true;
  return /^(?:[a-z0-9-]+\.)*aliexpress\.(?:[a-z]{2,3})(?:\.[a-z]{2})?$/.test(host);
}

const CURRENCY_BY_TLD: Record<string, string> = {
  com: "USD",
  us: "USD",
  "co.uk": "GBP",
  de: "EUR",
  fr: "EUR",
  es: "EUR",
  it: "EUR",
  nl: "EUR",
  pt: "EUR",
  pl: "PLN",
  cz: "CZK",
  ru: "RUB",
  il: "ILS",
  mx: "MXN",
  br: "BRL",
  ar: "ARS",
  cl: "CLP",
  tr: "TRY",
  in: "INR",
  id: "IDR",
  sg: "SGD",
  th: "THB",
  jp: "JPY",
  kr: "KRW",
  au: "AUD",
  ca: "CAD",
  sa: "SAR",
  ae: "AED",
  eg: "EGP",
  ma: "MAD",
  za: "ZAR",
  nz: "NZD",
};

/** Deterministic currency for a supported AliExpress host (undefined when unknown). */
export function currencyForTld(hostname: string | undefined): string | undefined {
  if (!hostname) return undefined;
  const match = hostname.toLowerCase().match(/aliexpress\.([a-z]{2,3}(?:\.[a-z]{2})?)$/);
  if (!match) return undefined;
  return CURRENCY_BY_TLD[match[1]];
}

const BLOCKED_MARKERS = [
  "captcha",
  "verify you are human",
  "please verify you are human",
  "unusual traffic",
  "unusual activity",
  "access denied",
  "sorry, we were unable to process your request",
];

/** True when the HTML looks like AliExpress's anti-bot challenge page. */
export function looksBlocked(html: string): boolean {
  const lowered = html.toLowerCase();
  return BLOCKED_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Parses an AliExpress product page into the normalize-ready shape. Throws a
 * typed `ScraperError` when the page carries no parseable product data
 * (`NO_PRODUCT_DATA`) or appears to be an anti-bot challenge page (`BLOCKED`).
 */
export function parseAliExpressPage(html: string, hint: AliExpressParseHint = {}): AliExpressParsedProduct {
  if (looksBlocked(html)) {
    throw new ScraperError("BLOCKED", "AliExpress served an anti-bot check page; no product data available");
  }

  const modules = extractModules(html);
  const ld = extractJsonLd(html);
  const productLd = findProductLd(ld);
  const pageUrl = hint.url ?? canonicalUrlFromHtml(html);

  const itemId = extractItemIdFromPage(html, ld, modules) ?? hint.itemId;
  if (!itemId || !ITEM_ID_RE.test(itemId)) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress page is missing an item id");
  }

  const title =
    ldString(productLd, ["name"]) ??
    moduleString(modules, "titleModule", ["subject", "skuTitle"]) ??
    metaContent(html, 'property="og:title"') ??
    metaContent(html, 'name="title"') ??
    titleTag(html);
  if (!title) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress page is missing a product title");
  }

  const price = parsePrice(modules, productLd, html, pageUrl);
  if (!price) {
    throw new ScraperError("NO_PRODUCT_DATA", "AliExpress page is missing a price");
  }

  const description =
    ldString(productLd, ["description"]) ??
    metaContent(html, 'name="description"') ??
    metaContent(html, 'property="og:description"');

  const category = parseCategory(ld, modules, html);
  const rating = parseRating(modules, productLd);
  const availability = parseAvailability(html, productLd);

  const specs = parseSpecs(modules);
  const seller = parseSeller(modules, productLd);
  const brand = parseBrand(productLd, specs);

  const parsed: AliExpressParsedProduct = {
    itemId,
    title,
    price,
    images: parseImages(html, productLd, modules),
    attributes: attributesOf({ specs, seller, brand }),
    raw: { ...(productLd ?? {}), itemId, runParams: modules },
  };

  if (description) parsed.description = description;
  if (category) parsed.category = category;
  if (rating) parsed.rating = rating;
  if (availability !== undefined) parsed.availability = availability;
  if (seller) parsed.seller = seller;
  if (brand) parsed.brand = brand;

  return parsed;
}

/** Resolves the embedded runParams/RDS "module" map used by every extractor. */
type ModuleMap = Record<string, Record<string, unknown>>;

function extractModules(html: string): ModuleMap {
  const modules: ModuleMap = {};
  const runParams = extractRunParams(html);
  if (runParams) mergeModules(modules, runParams);
  for (const rdsData of extractRdsBlocks(html)) {
    mergeModules(modules, rdsData);
  }
  return modules;
}

function mergeModules(target: ModuleMap, source: Record<string, unknown>): void {
  const candidates: Array<Record<string, unknown>> = [source];
  const data = asObject(source["data"]);
  if (data) candidates.push(data);
  const module = asObject(source["module"]);
  if (module) candidates.push(module);
  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(candidate)) {
      if (!(key in target) && /Module$/.test(key)) {
        const record = asObject(value);
        if (record) target[key] = record;
      }
    }
  }
}

/**
 * Extracts the `window.runParams = {...}` JSON literal. Uses brace matching
 * (string-aware) so nested modules and `{`/`}` inside strings are handled.
 */
export function extractRunParams(html: string): Record<string, unknown> | undefined {
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRe)) {
    const body = match[1];
    const idx = body.indexOf("window.runParams");
    if (idx === -1) continue;
    const eq = body.indexOf("=", idx);
    if (eq === -1) continue;
    const open = body.indexOf("{", eq);
    if (open === -1) continue;
    const jsonText = extractBalanced(body, open);
    if (!jsonText) continue;
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      return asObject(parsed);
    } catch {
      // Not a runParams block we can use - keep scanning.
    }
  }
  return undefined;
}

/**
 * Extracts module payloads from `RDS.init({...})` calls. Each call's first
 * argument is a JSON literal (brace matched); its `data`/module keys are
 * merged into the module map.
 */
export function extractRdsBlocks(html: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const match of html.matchAll(/RDS\.init\s*\(/gi)) {
    const open = html.indexOf("{", match.index as number);
    if (open === -1) continue;
    const jsonText = extractBalanced(html, open);
    if (!jsonText) continue;
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (asObject(parsed)) blocks.push(parsed as Record<string, unknown>);
    } catch {
      // Malformed RDS block - skip.
    }
  }
  return blocks;
}

/** Extracts the balanced `{...}` JSON text starting at `start`. */
function extractBalanced(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function moduleValue(modules: ModuleMap, name: string, keys: readonly string[]): unknown {
  const record = modules[name];
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) return value[0];
      continue;
    }
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return undefined;
}

function moduleString(modules: ModuleMap, name: string, keys: readonly string[]): string | undefined {
  const value = moduleValue(modules, name, keys);
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function extractItemIdFromPage(
  html: string,
  ld: Array<Record<string, unknown>>,
  modules: ModuleMap,
): string | undefined {
  const canonical = canonicalUrlFromHtml(html);
  if (canonical) {
    const itemId = extractItemIdFromPathname(canonical.pathname);
    if (itemId) return itemId;
  }
  const ogUrl = metaContent(html, 'property="og:url"');
  if (ogUrl) {
    try {
      const itemId = extractItemIdFromPathname(new URL(ogUrl).pathname);
      if (itemId) return itemId;
    } catch {
      // Malformed og:url - continue.
    }
  }
  const actionId = moduleString(modules, "actionModule", ["itemId"]);
  if (actionId && ITEM_ID_RE.test(actionId)) return actionId;
  const productLd = findProductLd(ld);
  const sku = ldString(productLd, ["sku", "itemId"]);
  if (sku && ITEM_ID_RE.test(sku)) return sku;
  return undefined;
}

function parsePrice(
  modules: ModuleMap,
  productLd: Record<string, unknown> | undefined,
  html: string,
  url: URL | undefined,
): AliExpressPrice | undefined {
  const amount = priceAmount(modules, productLd, html);
  const currency = priceCurrency(modules, productLd, html, url);
  if (amount === undefined || !currency) return undefined;

  const price: AliExpressPrice = { amount, currency };
  const original = originalAmount(modules, productLd, html);
  if (original !== undefined && original > amount) price.originalAmount = original;
  return price;
}

function priceCurrency(
  modules: ModuleMap,
  productLd: Record<string, unknown> | undefined,
  html: string,
  url: URL | undefined,
): string | undefined {
  const offers = firstOffers(productLd);
  const ldCurrency = ldString(offers, ["priceCurrency"]);
  if (ldCurrency) return ldCurrency;

  const headerCurrency = moduleString(modules, "headerModule", ["currency"]);
  if (headerCurrency) return headerCurrency;

  const priceModule = modules["priceModule"];
  const priceModuleCurrency = moduleString(modules, "priceModule", ["currency"]);
  if (priceModuleCurrency) return priceModuleCurrency;
  const priceObject = priceModule ? asObject(priceModule["price"]) : undefined;
  const priceObjectCurrency = priceObject ? stringOf(priceObject["currency"]) : undefined;
  if (priceObjectCurrency) return priceObjectCurrency;

  const ogCurrency = metaContent(html, 'property="og:price:currency"');
  if (ogCurrency) return ogCurrency;

  return currencyForTld(url?.hostname);
}

function priceAmount(
  modules: ModuleMap,
  productLd: Record<string, unknown> | undefined,
  html: string,
): number | undefined {
  const discountPrice = toFiniteNumber(moduleValue(modules, "priceModule", ["discountPrice"]));
  if (discountPrice !== undefined) return discountPrice;

  const priceModule = modules["priceModule"];
  const priceObject = priceModule ? asObject(priceModule["price"]) : undefined;
  const priceValue = priceObject ? toFiniteNumber(priceObject["value"]) : undefined;
  if (priceValue !== undefined) return priceValue;

  const activityPrice = parsePriceText(moduleString(modules, "priceModule", ["formatedActivityPrice"]));
  if (activityPrice !== undefined) return activityPrice;

  const rangePrice = firstRangeValue(modules, "rangePrice");
  if (rangePrice !== undefined) return rangePrice;

  const offers = firstOffers(productLd);
  const ldPrice = toFiniteNumber(ldValue(offers, ["price", "lowPrice"]));
  if (ldPrice !== undefined) return ldPrice;

  const ogPrice = metaContent(html, 'property="og:price:amount"');
  const ogParsed = ogPrice ? toFiniteNumber(ogPrice) : undefined;
  if (ogParsed !== undefined) return ogParsed;

  const htmlPrice = firstPriceText(html);
  return htmlPrice ? parsePriceText(htmlPrice) : undefined;
}

function originalAmount(
  modules: ModuleMap,
  productLd: Record<string, unknown> | undefined,
  html: string,
): number | undefined {
  const formated = parsePriceText(moduleString(modules, "priceModule", ["formatedPrice"]));
  if (formated !== undefined) return formated;

  const rangeOriginal = firstRangeValue(modules, "rangeOriginalPrice");
  if (rangeOriginal !== undefined) return rangeOriginal;

  const offers = firstOffers(productLd);
  const ldHigh = toFiniteNumber(ldValue(offers, ["highPrice"]));
  if (ldHigh !== undefined) return ldHigh;

  const original = originalPriceText(html);
  return original ? parsePriceText(original) : undefined;
}

/** First numeric `value` from `skuModule.productPriceCalcInfo.<key>` entries. */
function firstRangeValue(modules: ModuleMap, key: string): number | undefined {
  const skuModule = modules["skuModule"];
  const calcInfo = skuModule ? asObject(skuModule["productPriceCalcInfo"]) : undefined;
  const entries = calcInfo ? calcInfo[key] : undefined;
  if (Array.isArray(entries) && entries.length > 0) {
    const first = asObject(entries[0]);
    const value = first ? toFiniteNumber(first["value"]) : undefined;
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseCategory(
  ld: Array<Record<string, unknown>>,
  modules: ModuleMap,
  html: string,
): AliExpressCategory | undefined {
  const names = breadcrumbNames(ld, modules, html);
  if (names.length === 0) return undefined;
  return { name: names[names.length - 1], path: names };
}

function breadcrumbNames(ld: Array<Record<string, unknown>>, modules: ModuleMap, html: string): string[] {
  const breadcrumb = findBreadcrumbLd(ld);
  if (breadcrumb) {
    const elements = Array.isArray(breadcrumb.itemListElement)
      ? (breadcrumb.itemListElement as unknown[])
          .map((entry) => asObject(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== undefined)
          .sort((a, b) => (toFiniteNumber(a.position) ?? 0) - (toFiniteNumber(b.position) ?? 0))
      : [];
    const names = elements.map((entry) => ldString(entry, ["name"])).filter((name): name is string => name !== undefined);
    if (names.length > 0) return names;
  }

  const breadcrumbModule = modules["breadcrumbModule"];
  if (breadcrumbModule) {
    const list = Array.isArray(breadcrumbModule["list"])
      ? breadcrumbModule["list"]
      : Array.isArray(breadcrumbModule["items"])
        ? breadcrumbModule["items"]
        : undefined;
    if (list) {
      const names: string[] = [];
      for (const entry of list) {
        const record = asObject(entry);
        const name = record ? stringOf(record["name"]) : undefined;
        if (name) names.push(name);
      }
      if (names.length > 0) return names;
    }
  }

  const wayfinding = html.match(/class="[^"]*breadcrumb[^"]*"[^>]*>[\s\S]*?<\/[a-z]+>/i);
  if (wayfinding) {
    const names: string[] = [];
    const linkRe = /<a\b[^>]*>([^<]+)<\/a>/g;
    for (const match of wayfinding[0].matchAll(linkRe)) {
      const name = match[1].trim();
      if (name) names.push(name);
    }
    if (names.length > 0) return names;
  }

  return [];
}

function parseRating(modules: ModuleMap, productLd: Record<string, unknown> | undefined): AliExpressRating | undefined {
  const feedback = asObject(modules["feedbackModule"]?.["feedbackRating"]);
  let average = feedback ? toFiniteNumber(feedback["averageStar"]) : undefined;
  let count = feedback ? toFiniteNumber(feedback["totalValidNum"]) : undefined;

  const aggregate = asObject(productLd?.aggregateRating);
  if (average === undefined) average = toFiniteNumber(ldValue(aggregate, ["ratingValue"]));
  if (count === undefined) count = toFiniteNumber(ldValue(aggregate, ["reviewCount"]));

  if (average === undefined && count === undefined) return undefined;
  const rating: AliExpressRating = {};
  if (average !== undefined) rating.average = average;
  if (count !== undefined) rating.count = count;
  return rating;
}

function parseAvailability(html: string, productLd: Record<string, unknown> | undefined): boolean | undefined {
  const offers = firstOffers(productLd);
  const availability = ldString(offers, ["availability"]);
  if (availability) {
    if (/instock/i.test(availability)) return true;
    if (/outofstock|soldout|unavailable/i.test(availability)) return false;
  }
  if (/sold out|out of stock|no longer available/i.test(html)) return false;
  return undefined;
}

function parseSpecs(modules: ModuleMap): Array<{ name: string; value: string }> {
  const props = modules["specsModule"]?.["props"];
  if (!Array.isArray(props)) return [];
  const specs: Array<{ name: string; value: string }> = [];
  for (const entry of props) {
    const record = asObject(entry);
    if (!record) continue;
    const name = stringOf(record["attrName"]) ?? stringOf(record["name"]);
    const rawValue = record["attrValue"] ?? record["value"];
    const value = Array.isArray(rawValue)
      ? rawValue
          .map((entryValue) => stringOf(entryValue))
          .filter((entryValue): entryValue is string => entryValue !== undefined)
          .join(", ")
      : stringOf(rawValue);
    if (name && value) specs.push({ name, value });
  }
  return specs;
}

function parseSeller(modules: ModuleMap, productLd: Record<string, unknown> | undefined): string | undefined {
  const store = moduleString(modules, "storeModule", ["storeName", "sellerName", "name"]);
  if (store) return store;
  const offers = firstOffers(productLd);
  const sellerRaw = ldValue(offers, ["seller"]);
  const seller =
    typeof sellerRaw === "string"
      ? sellerRaw.trim() || undefined
      : ldString(asObject(sellerRaw), ["name"]);
  return seller;
}

function parseBrand(
  productLd: Record<string, unknown> | undefined,
  specs: Array<{ name: string; value: string }>,
): string | undefined {
  for (const spec of specs) {
    if (/^brand$/i.test(spec.name)) return spec.value;
  }
  const brandRaw = ldValue(productLd, ["brand"]);
  const brand =
    typeof brandRaw === "string"
      ? brandRaw.trim() || undefined
      : ldString(asObject(brandRaw), ["name"]);
  return brand;
}

function attributesOf(entries: {
  specs: Array<{ name: string; value: string }>;
  seller?: string;
  brand?: string;
}): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const spec of entries.specs) {
    attributes[spec.name] = spec.value;
  }
  if (entries.seller) attributes.seller = entries.seller;
  if (entries.brand) attributes.brand = entries.brand;
  return attributes;
}

function parseImages(html: string, productLd: Record<string, unknown> | undefined, modules: ModuleMap): AliExpressImage[] {
  const images: AliExpressImage[] = [];
  const seen = new Set<string>();
  const push = (url: string): void => {
    const normalized = normalizeImageUrl(url);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    images.push({ url: normalized });
  };

  const imagePathList = modules["imageModule"]?.["imagePathList"];
  if (Array.isArray(imagePathList)) {
    for (const entry of imagePathList) {
      if (typeof entry === "string") push(entry);
    }
  }

  const ldImage = productLd?.image;
  if (typeof ldImage === "string") {
    push(ldImage);
  } else if (Array.isArray(ldImage)) {
    for (const entry of ldImage) if (typeof entry === "string") push(entry);
  } else if (asObject(ldImage)) {
    const url = ldString(ldImage as Record<string, unknown>, ["url", "contentUrl"]);
    if (url) push(url);
  }

  const ogImage = metaContent(html, 'property="og:image"');
  if (ogImage) push(ogImage);

  for (const match of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) {
    if (/alicdn\.com/.test(match[1])) push(match[1]);
  }

  return images;
}

/** AliExpress image paths are often protocol-relative (`//ae01.alicdn.com/...`). */
function normalizeImageUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("//")) return isHttpUrl(`https:${trimmed}`) ? `https:${trimmed}` : undefined;
  return isHttpUrl(trimmed) ? trimmed : undefined;
}

/** Extracts every `application/ld+json` block into objects (malformed ones are skipped). */
export function extractJsonLd(html: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRe)) {
    const content = match[1].trim();
    if (!content) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (asObject(entry)) blocks.push(entry as Record<string, unknown>);
      }
    } else if (asObject(parsed)) {
      blocks.push(parsed as Record<string, unknown>);
    }
  }
  return blocks;
}

/** The `Product` JSON-LD graph, if any. */
export function findProductLd(blocks: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return blocks.find((block) => isType(block, "Product") || isType(block, "https://schema.org/Product"));
}

function findBreadcrumbLd(blocks: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return blocks.find((block) => isType(block, "BreadcrumbList") || isType(block, "https://schema.org/BreadcrumbList"));
}

function canonicalUrlFromHtml(html: string): URL | undefined {
  const canonical = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i);
  if (!canonical) return undefined;
  const href = canonical[0].match(/href=["']([^"']+)["']/i)?.[1];
  if (!href) return undefined;
  try {
    return new URL(href, "https://www.aliexpress.com");
  } catch {
    return undefined;
  }
}

function firstOffers(productLd: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const offers = productLd?.offers;
  if (Array.isArray(offers)) return asObject(offers[0]);
  return asObject(offers);
}

function firstPriceText(html: string): string | undefined {
  const current = html.match(/class="[^"]*price[^"]*"[^>]*>\s*([^<]{1,40})</i);
  if (current) return current[1].trim();
  return undefined;
}

/** AliExpress strike-through/original price shown with a `originalText` marker. */
function originalPriceText(html: string): string | undefined {
  const match = html.match(/class="[^"]*original[^"]*"[^>]*>\s*([^<]{1,40})</i);
  return match?.[1].trim() ?? undefined;
}

function parsePriceText(text: string | undefined): number | undefined {
  if (!text) return undefined;
  let cleaned = text.replace(/[^0-9.,\-]/g, "");
  if (/,\d{1,2}$/.test(cleaned) && !cleaned.includes(".")) {
    cleaned = cleaned.replace(",", ".");
  }
  cleaned = cleaned.replace(/,/g, "");
  if (cleaned === "" || cleaned === "-") return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function metaContent(html: string, marker: string): string | undefined {
  const re = new RegExp(`<meta\\b[^>]*${marker}[^>]*>`, "i");
  const match = html.match(re);
  if (!match) return undefined;
  const content = match[0].match(/content=["']([^"']*)["']/i)?.[1];
  return content?.trim() || undefined;
}

function titleTag(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return undefined;
  const title = match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return title || undefined;
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function isType(record: Record<string, unknown> | undefined, type: string): boolean {
  if (!record) return false;
  const value = record["@type"];
  if (value === type) return true;
  return Array.isArray(value) && value.includes(type);
}

function ldValue(record: Record<string, unknown> | undefined, keys: readonly string[] | undefined): unknown {
  if (!record || !keys) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) return value[0];
      continue;
    }
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return undefined;
}

function ldString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  const value = ldValue(record, keys);
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").replace(/[^0-9.\-]/g, "");
    if (cleaned === "" || cleaned === "-") return undefined;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
