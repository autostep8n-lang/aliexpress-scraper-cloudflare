import type { Env } from "../env";
import { ProductNormalizationError, normalizeProduct } from "../products/normalize";
import { findScraper } from "../scrapers/registry";
import { ScraperError } from "../scrapers/types";
import { upsertProduct } from "../supabase/repository";
import { jsonError, jsonOk } from "../utils/http";
import { parseHttpUrl } from "../utils/url";

/**
 * GET /api/scrape pipeline: parse the `url` parameter, resolve a scraper
 * module, scrape + normalize the product, and persist it through the shared
 * repository (never via a self-HTTP call).
 *
 * Outcomes map to:
 * - 200 `{ status: "updated", ... }` when an existing observation was reused
 * - 201 `{ status: "created", ... }` when a new product + observation was stored
 * - 400 `MISSING_URL` / `INVALID_URL` for a bad `url` parameter
 * - 501 `NO_SCRAPER` when no enabled module supports the URL
 * - 502 with the scraper's typed code (`HTTP_ERROR`, `BLOCKED`,
 *   `NO_PRODUCT_DATA`, `NOT_PRODUCT_PAGE`, ...) or `INVALID_PRODUCT_DATA`
 * - 503 `SUPABASE_NOT_CONFIGURED` when Supabase bindings are missing
 * - 502 with the repository's typed step code when the database rejects the write
 */
export async function handleScrape(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const target = new URL(request.url).searchParams.get("url");
  if (!target) {
    return jsonError(400, "Missing required 'url' query parameter", "MISSING_URL", requestId);
  }

  const parsed = parseHttpUrl(target);
  if (!parsed) {
    return jsonError(400, "Invalid 'url' query parameter", "INVALID_URL", requestId);
  }

  const scraper = findScraper(parsed);
  if (!scraper) {
    return jsonError(501, `No scraper registered for ${parsed.hostname} yet`, "NO_SCRAPER", requestId);
  }

  let result;
  try {
    result = await scraper.scrape(parsed, env, ctx);
  } catch (err) {
    if (err instanceof ScraperError) {
      return jsonError(502, err.message, err.code, requestId);
    }
    throw err;
  }

  if (typeof result.data !== "object" || result.data === null || Array.isArray(result.data)) {
    return jsonError(502, "Scraper returned no product data", "INVALID_PRODUCT_DATA", requestId);
  }

  let product;
  try {
    product = normalizeProduct({
      raw: result.data,
      platform: result.platform,
      url: result.url,
      scrapedAt: result.scrapedAt,
    });
  } catch (err) {
    const message =
      err instanceof ProductNormalizationError ? err.message : "scraped product data could not be normalized";
    return jsonError(502, message, "INVALID_PRODUCT_DATA", requestId);
  }

  const persisted = await upsertProduct(env, product, { raw: result.data });

  switch (persisted.status) {
    case "credentials_missing":
      return jsonError(503, "Supabase is not configured", "SUPABASE_NOT_CONFIGURED", requestId);
    case "invalid":
      return jsonError(400, persisted.message, "INVALID_PRODUCT", requestId);
    case "error":
      return jsonError(502, persisted.message, persisted.code ?? "INGEST_FAILED", requestId);
    case "created":
    case "updated":
      return jsonOk(
        {
          status: persisted.status,
          platform: product.platform,
          url: product.url,
          title: product.title,
          scrapedAt: product.scrapedAt,
          source: persisted.data.source,
          product: persisted.data.product,
          observation: persisted.data.observation,
        },
        persisted.status === "created" ? 201 : 200,
      );
    case "found":
    case "not_found":
      return jsonError(502, "Unexpected repository outcome", "INGEST_FAILED", requestId);
  }
}
