import { scoreAndPersistMvpCountryOpportunity } from "../country/pipeline";
import { loadDiscoveryPage, loadProductDetail, parseProductId, parseProductListQuery } from "../dashboard/assemble";
import type { Env } from "../env";
import type { Product } from "../products/types";
import { isProduct, validateProduct } from "../products/validation";
import { upsertProduct } from "../supabase/repository";
import { jsonError, jsonOk } from "../utils/http";

export interface ProductIngestBody {
  product: Product;
  raw?: unknown;
}

/**
 * GET /api/products — read-only product discovery list (P6.26).
 *
 * Lists persisted products by last_seen_at desc, then computes compact P5.24
 * and P5.25 fields on-read. Never writes scores or analyst results.
 *
 * Outcomes map to:
 * - 200 `{ status: "ok", products, page }`
 * - 400 `INVALID_LIMIT` / `INVALID_OFFSET` / `INVALID_LIFECYCLE`
 * - 503 `SUPABASE_NOT_CONFIGURED`
 * - 502 with the repository's typed step code when a read fails
 */
export async function handleProductList(request: Request, env: Env, requestId: string): Promise<Response> {
  const parsed = parseProductListQuery(new URL(request.url).searchParams);
  if (!parsed.ok) {
    return jsonError(400, parsed.message, parsed.code, requestId);
  }

  const assembled = await loadDiscoveryPage(env, parsed.query);
  if (assembled.status === "credentials_missing") {
    return jsonError(503, "Supabase is not configured", "SUPABASE_NOT_CONFIGURED", requestId);
  }
  if (assembled.status === "error") {
    return jsonError(502, assembled.message, assembled.code ?? "PRODUCT_LIST_FAILED", requestId);
  }
  return jsonOk(assembled.data);
}

/**
 * GET /api/products/:id — read-only product detail / analysis (P6.28).
 *
 * Loads one persisted product, then computes the full P5.24 / P5.25 analyst
 * result on-read, including evidence. Never writes scores or analyst results.
 *
 * Outcomes map to:
 * - 200 `{ status: "ok", product, decision }`
 * - 404 `NOT_FOUND` / `INVALID_PRODUCT` when the id is missing or unknown
 * - 503 `SUPABASE_NOT_CONFIGURED`
 * - 502 with the repository's typed step code when a read fails
 */
export async function handleProductDetail(env: Env, requestId: string, productId: string): Promise<Response> {
  const parsedId = parseProductId(productId);
  if (!parsedId) {
    return jsonError(404, "Product not found", "NOT_FOUND", requestId);
  }

  const assembled = await loadProductDetail(env, parsedId);
  if (assembled.status === "credentials_missing") {
    return jsonError(503, "Supabase is not configured", "SUPABASE_NOT_CONFIGURED", requestId);
  }
  if (assembled.status === "not_found") {
    return jsonError(404, "Product not found", "NOT_FOUND", requestId);
  }
  if (assembled.status === "error") {
    return jsonError(502, assembled.message, assembled.code ?? "PRODUCT_LOOKUP_FAILED", requestId);
  }
  return jsonOk(assembled.data);
}

/**
 * Minimal POST product ingestion endpoint.
 *
 * Accepts an already-normalized Phase 1 `Product` (plus an optional `raw`
 * payload) and persists it through the repository. Outcomes map to:
 *
 * - 201 `{ status: "created", ... }` when a new product + observation was stored
 * - 200 `{ status: "updated", ... }` when an existing product/observation was reused
 * - 400 `INVALID_JSON` / `INVALID_PRODUCT` for malformed or invalid input
 * - 503 `SUPABASE_NOT_CONFIGURED` when Supabase bindings are missing
 * - 502 with the repository's typed step code when the database rejects the write
 */
export async function handleProductIngest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Request body must be valid JSON", "INVALID_JSON", requestId);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonError(400, "Request body must be an object with a 'product' field", "INVALID_PRODUCT", requestId);
  }

  const { product, raw } = body as { product?: unknown; raw?: unknown };

  if (!isProduct(product)) {
    const validation = validateProduct(product);
    return jsonError(400, `Invalid product: ${validation.errors.join("; ")}`, "INVALID_PRODUCT", requestId);
  }

  const result = await upsertProduct(env, product, { raw });

  switch (result.status) {
    case "credentials_missing":
      return jsonError(503, "Supabase is not configured", "SUPABASE_NOT_CONFIGURED", requestId);
    case "invalid":
      return jsonError(400, result.message, "INVALID_PRODUCT", requestId);
    case "error":
      return jsonError(502, result.message, result.code ?? "INGEST_FAILED", requestId);
    case "created":
    case "updated":
      try {
        await scoreAndPersistMvpCountryOpportunity(env, ctx, {
          productId: result.data.product.id,
          title: result.data.product.title,
        });
      } catch {}
      return jsonOk(
        {
          status: result.status,
          source: result.data.source,
          product: result.data.product,
          observation: result.data.observation,
        },
        result.status === "created" ? 201 : 200,
      );
    case "found":
      return jsonOk({ status: "found", ...result.data });
    case "not_found":
      return jsonError(404, "Product not found", "NOT_FOUND", requestId);
  }
}
