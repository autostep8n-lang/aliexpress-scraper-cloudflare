import type { Env } from "../env";
import { findDiscovery } from "../discovery/registry";
import { ScraperError } from "../scrapers/types";
import type { RepositoryResult, PersistedProduct } from "../supabase/repository";
import { jsonError, jsonOk } from "../utils/http";

/**
 * GET /api/discover pipeline: discover products from a platform search/category
 * page, normalize each one, and persist them through the shared repository.
 *
 * Outcomes map to:
 * - 200 `{ status: "ok", discovered, persisted, created, updated, failed, products }`
 * - 400 `MISSING_QUERY` when neither `q` nor `category` is given
 * - 400 `INVALID_LIMIT` when `limit` is not a positive integer
 * - 501 `NO_DISCOVERY` when no discovery module is registered for the platform
 * - 502 with the discovery module's typed code (`BLOCKED`, `NO_PRODUCT_DATA`,
 *   `HTTP_ERROR`, ...) when the platform could not be reached
 * - 503 `SUPABASE_NOT_CONFIGURED` when Supabase bindings are missing
 */
export async function handleDiscover(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const query = params.get("q")?.trim() || undefined;
  const category = params.get("category")?.trim() || undefined;
  const region = params.get("region")?.trim()?.toUpperCase() || undefined;
  if (!query && !category) {
    return jsonError(400, "Missing required 'q' or 'category' parameter", "MISSING_QUERY", requestId);
  }

  let limit = DEFAULT_LIMIT;
  const limitRaw = params.get("limit");
  if (limitRaw) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      return jsonError(400, "Invalid 'limit' parameter", "INVALID_LIMIT", requestId);
    }
    limit = Math.min(limit, MAX_LIMIT);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return jsonError(503, "Supabase is not configured", "SUPABASE_NOT_CONFIGURED", requestId);
  }

  const discovery = findDiscovery("tiktok-shop");
  if (!discovery) {
    return jsonError(501, "No discovery module registered for tiktok-shop", "NO_DISCOVERY", requestId);
  }

  let result;
  try {
    result = await discovery.discover({ query, category, region, limit }, env, ctx);
  } catch (err) {
    if (err instanceof ScraperError) {
      return jsonError(502, err.message, err.code, requestId);
    }
    throw err;
  }

  return jsonOk({
    status: "ok",
    platform: result.platform,
    query: result.query ?? null,
    category: result.category ?? null,
    region: result.region ?? null,
    requested: result.requested,
    discovered: result.discovered,
    persisted: result.persisted,
    created: result.created,
    updated: result.updated,
    failed: result.failed,
    products: result.products.map((entry) => ({
      url: entry.product?.url ?? null,
      title: entry.product?.title ?? null,
      externalId: entry.product?.externalId ?? null,
      price: entry.product?.price ?? null,
      persisted: summarizePersisted(entry.persisted),
    })),
  });
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function summarizePersisted(persisted: RepositoryResult<PersistedProduct>): Record<string, unknown> {
  switch (persisted.status) {
    case "created":
    case "updated":
      return {
        status: persisted.status,
        source: persisted.data.source,
        product: persisted.data.product,
        observation: persisted.data.observation,
      };
    case "invalid":
      return { status: persisted.status, message: persisted.message };
    case "error":
      return { status: persisted.status, message: persisted.message, code: persisted.code };
    case "credentials_missing":
    case "not_found":
    case "found":
      return { status: persisted.status };
  }
}
