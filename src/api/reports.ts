import type { Env } from "../env";
import { isReportType, loadReportById, loadReportsPage } from "../reports";
import { jsonError, jsonOk } from "../utils/http";

/** Default page size for the reports archive. */
export const DEFAULT_REPORT_LIMIT = 20;
/** Upper bound on `limit` so a single request cannot stream the whole archive. */
export const MAX_REPORT_LIMIT = 50;

/**
 * GET /api/reports — read-only report archive (P7.32).
 *
 * Query params:
 * - `limit` (optional)  page size (1..50); default 20
 * - `offset` (optional) zero-based offset; default 0
 * - `type` (optional)  report family, currently only `daily_digest`
 *
 * Outcomes map to:
 * - 200 `{ status: "ok", reports, page }`
 * - 400 `INVALID_LIMIT` / `INVALID_OFFSET` / `INVALID_TYPE`
 * - 503 `SUPABASE_NOT_CONFIGURED` when Supabase bindings are missing
 * - 502 with the repository's typed code when the read fails
 *
 * Read-only by design: reports are produced by the scheduled pipeline, never by
 * this endpoint.
 */
export async function handleReportList(request: Request, env: Env, requestId: string): Promise<Response> {
  const params = new URL(request.url).searchParams;

  let limit = DEFAULT_REPORT_LIMIT;
  const limitRaw = params.get("limit");
  if (limitRaw !== null && limitRaw !== "") {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      return jsonError(400, "Invalid 'limit' parameter", "INVALID_LIMIT", requestId);
    }
    limit = Math.min(limit, MAX_REPORT_LIMIT);
  }

  let offset = 0;
  const offsetRaw = params.get("offset");
  if (offsetRaw !== null && offsetRaw !== "") {
    offset = Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0) {
      return jsonError(400, "Invalid 'offset' parameter", "INVALID_OFFSET", requestId);
    }
  }

  let reportType: string | undefined;
  const typeRaw = params.get("type");
  if (typeRaw !== null && typeRaw !== "") {
    if (!isReportType(typeRaw)) {
      return jsonError(400, "Invalid 'type' parameter", "INVALID_TYPE", requestId);
    }
    reportType = typeRaw;
  }

  const loaded = await loadReportsPage(env, { limit, offset, reportType });
  if (loaded.status === "credentials_missing") {
    return jsonError(503, "Supabase is not configured", "SUPABASE_NOT_CONFIGURED", requestId);
  }
  if (loaded.status === "error") {
    return jsonError(502, loaded.message, loaded.code ?? "REPORT_LIST_FAILED", requestId);
  }
  return jsonOk({ status: "ok", reports: loaded.data.reports, page: loaded.data.page });
}

/**
 * GET /api/reports/:id — single report by primary key (P7.32).
 *
 * Outcomes map to:
 * - 200 `{ status: "ok", report }`
 * - 404 `REPORT_NOT_FOUND` (unknown or malformed id; malformed ids never query)
 * - 503 `SUPABASE_NOT_CONFIGURED` when Supabase bindings are missing
 * - 502 with the repository's typed code when the read fails
 */
export async function handleReportDetail(env: Env, requestId: string, reportId: string): Promise<Response> {
  const loaded = await loadReportById(env, reportId);
  if (loaded.status === "not_found") {
    return jsonError(404, "Report not found", "REPORT_NOT_FOUND", requestId);
  }
  if (loaded.status === "credentials_missing") {
    return jsonError(503, "Supabase is not configured", "SUPABASE_NOT_CONFIGURED", requestId);
  }
  if (loaded.status === "error") {
    return jsonError(502, loaded.message, loaded.code ?? "REPORT_LOOKUP_FAILED", requestId);
  }
  return jsonOk({ status: "ok", report: loaded.data });
}
