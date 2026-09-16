import type { Env } from "../env";
import { loadAlertsPage } from "../alerts";
import { jsonError, jsonOk } from "../utils/http";

/** Default page size for the alerts feed. */
export const DEFAULT_ALERT_LIMIT = 20;
/** Upper bound on `limit` so a single request cannot stream the whole feed. */
export const MAX_ALERT_LIMIT = 100;

/**
 * GET /api/alerts — read-only active alert feed (P7.31).
 *
 * Query params:
 * - `limit` (optional)  page size (1..100); default 20
 * - `offset` (optional) zero-based offset; default 0
 *
 * Outcomes map to:
 * - 200 `{ status: "ok", alerts, page }`
 * - 400 `INVALID_LIMIT` / `INVALID_OFFSET`
 * - 503 `SUPABASE_NOT_CONFIGURED` when Supabase bindings are missing
 * - 502 with the repository's typed code when the read fails
 *
 * Read-only by design: alerts are produced by the scheduled pipeline, never by
 * this endpoint.
 */
export async function handleAlertList(request: Request, env: Env, requestId: string): Promise<Response> {
  const params = new URL(request.url).searchParams;

  let limit = DEFAULT_ALERT_LIMIT;
  const limitRaw = params.get("limit");
  if (limitRaw !== null && limitRaw !== "") {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      return jsonError(400, "Invalid 'limit' parameter", "INVALID_LIMIT", requestId);
    }
    limit = Math.min(limit, MAX_ALERT_LIMIT);
  }

  let offset = 0;
  const offsetRaw = params.get("offset");
  if (offsetRaw !== null && offsetRaw !== "") {
    offset = Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0) {
      return jsonError(400, "Invalid 'offset' parameter", "INVALID_OFFSET", requestId);
    }
  }

  const loaded = await loadAlertsPage(env, { limit, offset });
  if (loaded.status === "credentials_missing") {
    return jsonError(503, "Supabase is not configured", "SUPABASE_NOT_CONFIGURED", requestId);
  }
  if (loaded.status === "error") {
    return jsonError(502, loaded.message, loaded.code ?? "ALERT_LIST_FAILED", requestId);
  }
  return jsonOk({ status: "ok", alerts: loaded.data.alerts, page: loaded.data.page });
}
