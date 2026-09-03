import { loadOpportunitiesPage, parseProductListQuery } from "../dashboard/assemble";
import type { Env } from "../env";
import { jsonError, jsonOk } from "../utils/http";

/**
 * GET /api/opportunities — ranked top opportunities (P6.27).
 *
 * Reads the 200 most recently seen matching products, computes compact
 * P5.24 / P5.25 fields on-read, excludes unknown/zero-weight scores,
 * then ranks in memory. Never writes scores or analyst results.
 *
 * Outcomes map to:
 * - 200 `{ status: "ok", products, page }`
 * - 400 `INVALID_LIMIT` / `INVALID_OFFSET` / `INVALID_LIFECYCLE`
 * - 503 `SUPABASE_NOT_CONFIGURED`
 * - 502 with the repository's typed step code when a read fails
 */
export async function handleOpportunityList(request: Request, env: Env, requestId: string): Promise<Response> {
  const parsed = parseProductListQuery(new URL(request.url).searchParams);
  if (!parsed.ok) {
    return jsonError(400, parsed.message, parsed.code, requestId);
  }

  const assembled = await loadOpportunitiesPage(env, parsed.query);
  if (assembled.status === "credentials_missing") {
    return jsonError(503, "Supabase is not configured", "SUPABASE_NOT_CONFIGURED", requestId);
  }
  if (assembled.status === "error") {
    return jsonError(502, assembled.message, assembled.code ?? "PRODUCT_LIST_FAILED", requestId);
  }
  return jsonOk(assembled.data);
}
