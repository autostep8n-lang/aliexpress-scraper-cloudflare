import type { Env } from "../env";
import { logInfo } from "../logging";
import { normalizeProduct } from "../products/normalize";
import type { Product } from "../products/types";
import {
  dsCountryCode,
  dsCurrencyForCountry,
  searchAliExpressDsText,
  type DsSearchProduct,
} from "../scrapers/aliexpress-ds-search";
import { fetchAliExpressProductOpenApi } from "../scrapers/aliexpress-openapi";
import { hasOpenApiCredentials } from "../scrapers/aliexpress-openapi-credentials";
import { ScraperError } from "../scrapers/types";
import { upsertProduct } from "../supabase/repository";
import type { DiscoveryModule, DiscoveryQuery, DiscoveryResult, DiscoveredProduct } from "./types";

/**
 * AliExpress Dropshipping discovery.
 *
 * Searches via official `aliexpress.ds.text.search`, enriches each `itemId`
 * with official `aliexpress.ds.product.get`, then persists through
 * `normalizeProduct` + `upsertProduct`. One product failure does not abort
 * the run. Repeat runs refresh by `(source, external_id)`.
 */

export const aliexpressDiscovery: DiscoveryModule = {
  platform: "aliexpress",

  async discover(query: DiscoveryQuery, env: Env, _ctx: ExecutionContext): Promise<DiscoveryResult> {
    if (!hasOpenApiCredentials(env)) {
      throw new ScraperError(
        "PROVIDER_CREDENTIALS_MISSING",
        "AliExpress Open Platform is not configured; set ALIEXPRESS_OPENAPI_KEY and ALIEXPRESS_OPENAPI_SECRET to enable it",
      );
    }

    const countryCode = dsCountryCode(query.region);
    const search = await searchAliExpressDsText(env, {
      keyWord: query.query,
      categoryId: query.category,
      countryCode,
      currency: dsCurrencyForCountry(countryCode),
      pageSize: query.limit,
      pageIndex: 1,
    });

    const products = search.products.slice(0, query.limit);
    const discovered: DiscoveredProduct[] = [];
    let created = 0;
    let updated = 0;
    let failed = 0;

    for (const item of products) {
      const outcome = await persistSearchProduct(item, env, countryCode);
      switch (outcome.persisted.status) {
        case "created":
          created++;
          break;
        case "updated":
          updated++;
          break;
        default:
          failed++;
          break;
      }
      discovered.push(outcome);
    }

    return {
      platform: "aliexpress",
      query: query.query,
      category: query.category,
      region: query.region,
      requested: query.limit,
      discovered: products.length,
      persisted: created + updated,
      created,
      updated,
      failed,
      products: discovered,
    };
  },
};

async function persistSearchProduct(
  item: DsSearchProduct,
  env: Env,
  shipToCountry: string,
): Promise<DiscoveredProduct> {
  const productUrl = new URL(`https://www.aliexpress.com/item/${item.itemId}.html`);
  let parsed;
  try {
    parsed = await fetchAliExpressProductOpenApi(env, item.itemId, productUrl, { shipToCountry });
  } catch (err) {
    if (err instanceof ScraperError) {
      logInfo("aliexpress.discovery.enrichment_failed", { code: err.code, message: err.message });
    } else {
      logInfo("aliexpress.discovery.enrichment_failed", { code: "UNKNOWN" });
    }
    return {
      raw: { ...item.raw, externalId: item.itemId, source: "aliexpress" },
      persisted: { status: "invalid", message: "discovered product could not be enriched" },
    };
  }

  const raw: Record<string, unknown> = {
    ...parsed.raw,
    ...item.raw,
    externalId: parsed.itemId,
    title: parsed.title,
    price: parsed.price,
    images: parsed.images,
    attributes: parsed.attributes,
    source: "aliexpress",
  };
  if (parsed.description) raw.description = parsed.description;
  if (parsed.category) raw.category = parsed.category;
  if (parsed.rating) raw.rating = parsed.rating;
  if (parsed.availability !== undefined) raw.available = parsed.availability;

  let product: Product;
  try {
    product = normalizeProduct({
      raw,
      platform: "aliexpress",
      url: productUrl.href,
      scrapedAt: new Date().toISOString(),
    });
  } catch {
    return {
      raw,
      persisted: { status: "invalid", message: "discovered product could not be normalized" },
    };
  }

  const persisted = await upsertProduct(env, product, { raw });
  return { product, raw, persisted };
}
