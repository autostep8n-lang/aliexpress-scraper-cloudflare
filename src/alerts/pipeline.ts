import type { CountryOpportunityPersistedRow } from "../country/types";
import type { Env } from "../env";
import { logError, logInfo } from "../logging";
import type { PersistedScoreRecord } from "../supabase/repository";
import {
  listActiveAlertsForProducts,
  listAlerts,
  listCountryOpportunityScoresForProducts,
  listProducts,
  listScoresForProducts,
  resolveAlerts,
  upsertAlerts,
  type AlertRow,
  type PersistedAlertRecord,
  type PersistedProductRecord,
} from "../supabase/repository";
import {
  alertRowKey,
  COUNTRY_OPPORTUNITY_SCORE_TYPE,
  evaluateAlerts,
  MARKET_OPPORTUNITY_SCORE_TYPE,
} from "./engine";
import type {
  AlertCandidate,
  CountryOpportunityAlertEvidence,
  LifecycleAlertEvidence,
  MarketOpportunityAlertEvidence,
} from "./types";

/** Products loaded per page. Mirrors the bounded scoring pipeline. */
export const ALERT_BATCH_SIZE = 50;
/** Upper bound on products evaluated per run. */
export const ALERT_MAX_PRODUCTS = 200;

export type AutomatedAlertsStatus = "ok" | "skipped" | "error";

export interface AutomatedAlertsSummary {
  status: AutomatedAlertsStatus;
  total: number;
  evaluated: number;
  created: number;
  resolved: number;
  unchanged: number;
  failed: number;
  durationMs: number;
  code?: string;
  message?: string;
  reasons?: Record<string, number>;
}

export interface AutomatedAlertsOptions {
  /** Page size; defaults to `ALERT_BATCH_SIZE`. */
  batchSize?: number;
  /** Maximum products to process; defaults to `ALERT_MAX_PRODUCTS`. */
  maxProducts?: number;
  /** Clock seam for deterministic tests; defaults to the wall clock. */
  now?: () => string;
}

/**
 * Automated alerts pipeline (P7.31).
 *
 * Pages the most-recently-seen persisted products in bounded batches and
 * evaluates alerts from data that is already persisted: the latest
 * `market_opportunity` score, every eligible `country_opportunity` score, and
 * the product's lifecycle state. Scores are never recomputed. Candidates are
 * upserted (refresh `last_seen_at`, preserve `first_seen_at`), then any active
 * alert whose condition has disappeared is marked resolved. A failure on one
 * step never invalidates the alerts already persisted for a page.
 */
export async function runAutomatedAlerts(
  env: Env,
  options: AutomatedAlertsOptions = {},
): Promise<AutomatedAlertsSummary> {
  const startedAt = Date.now();
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? ALERT_BATCH_SIZE));
  const maxProducts = Math.max(0, Math.floor(options.maxProducts ?? ALERT_MAX_PRODUCTS));
  const now = options.now ?? (() => new Date().toISOString());

  let total = 0;
  let evaluated = 0;
  let created = 0;
  let resolved = 0;
  let unchanged = 0;
  let failed = 0;
  const reasons: Record<string, number> = {};
  const bump = (code: string): void => {
    reasons[code] = (reasons[code] ?? 0) + 1;
  };

  const finish = (
    status: AutomatedAlertsStatus,
    extra: { code?: string; message?: string } = {},
  ): AutomatedAlertsSummary => {
    const summary: AutomatedAlertsSummary = {
      status,
      total,
      evaluated,
      created,
      resolved,
      unchanged,
      failed,
      durationMs: Date.now() - startedAt,
      ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
      ...extra,
    };
    const fields: Record<string, unknown> = {
      total: summary.total,
      evaluated: summary.evaluated,
      created: summary.created,
      resolved: summary.resolved,
      unchanged: summary.unchanged,
      failed: summary.failed,
      durationMs: summary.durationMs,
    };
    if (summary.code) fields.code = summary.code;
    if (summary.message) fields.message = summary.message;
    if (summary.reasons) fields.reasons = summary.reasons;
    if (status === "ok") {
      logInfo("scheduled.alerts", fields);
    } else {
      logError("scheduled.alerts", fields);
    }
    return summary;
  };

  let offset = 0;
  while (offset < maxProducts) {
    const limit = Math.min(batchSize, maxProducts - offset);
    const page = await listProducts(env, { limit, offset });
    if (page.status === "credentials_missing") {
      return finish("skipped", { code: "SUPABASE_NOT_CONFIGURED", message: "Supabase is not configured" });
    }
    if (page.status === "error") {
      return finish("error", { code: page.code ?? "PRODUCT_LIST_FAILED", message: page.message });
    }
    if (page.status !== "found") {
      return finish("error", { code: "PRODUCT_LIST_FAILED", message: "Unexpected repository outcome" });
    }

    const products = page.data.products;
    if (products.length === 0) break;
    total += products.length;

    const ids = products.map((product) => product.id);
    const scores = await listScoresForProducts(env, ids);
    if (scores.status === "credentials_missing") {
      return finish("skipped", { code: "SUPABASE_NOT_CONFIGURED", message: "Supabase is not configured" });
    }
    if (scores.status !== "found") {
      failed += products.length;
      bump("ALERT_SCORE_LIST_FAILED");
      offset += products.length;
      if (products.length < limit) break;
      continue;
    }

    const countries = await listCountryOpportunityScoresForProducts(env, ids);
    if (countries.status === "credentials_missing") {
      return finish("skipped", { code: "SUPABASE_NOT_CONFIGURED", message: "Supabase is not configured" });
    }
    if (countries.status !== "found") {
      failed += products.length;
      bump("ALERT_COUNTRY_LIST_FAILED");
      offset += products.length;
      if (products.length < limit) break;
      continue;
    }

    let candidates: AlertCandidate[];
    try {
      candidates = evaluateAlerts({
        marketOpportunities: latestMarketOpportunities(scores.data),
        countryOpportunities: countryOpportunityEvidence(countries.data),
        lifecycles: lifecycleEvidence(products),
      });
    } catch {
      failed += products.length;
      bump("ALERT_EVALUATION_FAILED");
      offset += products.length;
      if (products.length < limit) break;
      continue;
    }

    evaluated += products.length;
    const evaluatedAt = now();

    if (candidates.length > 0) {
      const rows = candidates.map((candidate) => toAlertRow(candidate, evaluatedAt));
      const write = await upsertAlerts(env, rows);
      if (write.status === "created" || write.status === "updated") {
        created += rows.length;
      } else if (write.status === "credentials_missing") {
        return finish("skipped", { code: "SUPABASE_NOT_CONFIGURED", message: "Supabase is not configured" });
      } else {
        failed += rows.length;
        bump(write.status === "invalid" ? "INVALID_ALERT_ROW" : "ALERTS_UPSERT_FAILED");
      }
    }

    const active = await listActiveAlertsForProducts(env, ids);
    if (active.status === "found") {
      const expected = new Set(candidates.map((candidate) => alertRowKey({ product_id: candidate.productId, alert_type: candidate.alertType, dedup_key: candidate.dedupKey })));
      const stale = active.data.filter(
        (alert) => !expected.has(alertRowKey(alert)),
      );
      unchanged += active.data.length - stale.length;
      if (stale.length > 0) {
        const resolution = await resolveAlerts(env, stale.map((alert) => alert.id), evaluatedAt);
        if (resolution.status === "updated") {
          resolved += resolution.data.length;
        } else if (resolution.status === "credentials_missing") {
          return finish("skipped", { code: "SUPABASE_NOT_CONFIGURED", message: "Supabase is not configured" });
        } else {
          bump("ALERTS_RESOLVE_FAILED");
        }
      }
    } else if (active.status === "credentials_missing") {
      return finish("skipped", { code: "SUPABASE_NOT_CONFIGURED", message: "Supabase is not configured" });
    } else {
      bump("ALERT_LIST_FAILED");
    }

    offset += products.length;
    if (products.length < limit) break;
  }

  return finish("ok");
}

/** The latest `market_opportunity` score per product (rows arrive newest first). */
export function latestMarketOpportunities(
  rows: readonly PersistedScoreRecord[],
): MarketOpportunityAlertEvidence[] {
  const seen = new Set<string>();
  const evidence: MarketOpportunityAlertEvidence[] = [];
  for (const row of rows) {
    if (row.score_type !== MARKET_OPPORTUNITY_SCORE_TYPE) continue;
    if (seen.has(row.product_id)) continue;
    seen.add(row.product_id);
    evidence.push({
      productId: row.product_id,
      scoreType: row.score_type,
      value: row.value,
      totalWeight: totalWeightFromInputs(row.inputs),
    });
  }
  return evidence;
}

/** One evidence row per persisted country opportunity score. */
export function countryOpportunityEvidence(
  rows: readonly CountryOpportunityPersistedRow[],
): CountryOpportunityAlertEvidence[] {
  const evidence: CountryOpportunityAlertEvidence[] = [];
  for (const row of rows) {
    if (row.score_type !== COUNTRY_OPPORTUNITY_SCORE_TYPE) continue;
    evidence.push({
      productId: row.product_id,
      country: row.country,
      scoreType: row.score_type,
      value: row.value,
      totalWeight: typeof row.total_weight === "number" ? row.total_weight : Number.NaN,
      tier: row.tier,
    });
  }
  return evidence;
}

/** Lifecycle evidence from the persisted `products.lifecycle_status` column. */
export function lifecycleEvidence(products: readonly PersistedProductRecord[]): LifecycleAlertEvidence[] {
  return products.map((product) => ({
    productId: product.id,
    lifecycleStatus: product.lifecycle_status,
  }));
}

/** Read-only page of active alerts for `GET /api/alerts` (most recent first). */
export async function loadAlertsPage(
  env: Env,
  filter: { limit: number; offset: number },
): Promise<
  | { status: "ok"; data: { alerts: PersistedAlertRecord[]; page: { limit: number; offset: number; count: number } } }
  | { status: "credentials_missing" }
  | { status: "error"; message: string; code?: string }
> {
  const result = await listAlerts(env, filter);
  if (result.status === "credentials_missing") {
    return { status: "credentials_missing" };
  }
  if (result.status !== "found") {
    if (result.status === "error") {
      return { status: "error", message: result.message, code: result.code };
    }
    return { status: "error", message: "Unexpected repository outcome", code: "alert_list_failed" };
  }
  return {
    status: "ok",
    data: { alerts: result.data, page: { limit: filter.limit, offset: filter.offset, count: result.data.length } },
  };
}

function toAlertRow(candidate: AlertCandidate, evaluatedAt: string): AlertRow {
  return {
    product_id: candidate.productId,
    alert_type: candidate.alertType,
    severity: candidate.severity,
    status: "active",
    dedup_key: candidate.dedupKey,
    title: candidate.title,
    message: candidate.message,
    evidence: candidate.evidence,
    last_seen_at: evaluatedAt,
    resolved_at: null,
  };
}

/**
 * The `scores` table stores the weighted breakdown in `inputs.signals` but has
 * no `total_weight` column, so the effective weight is read back from the
 * persisted signals (`present === true`) rather than recomputing the score. A
 * malformed breakdown yields NaN so the engine skips the row; a well-formed
 * all-absent breakdown yields 0 and is likewise skipped by the `> 0` rule.
 */
function totalWeightFromInputs(inputs: Record<string, unknown>): number {
  const signals = inputs?.signals;
  if (!Array.isArray(signals)) return Number.NaN;
  let total = 0;
  for (const signal of signals) {
    if (!signal || typeof signal !== "object") continue;
    const entry = signal as { present?: unknown; weight?: unknown };
    if (entry.present !== true) continue;
    if (typeof entry.weight !== "number" || !Number.isFinite(entry.weight)) return Number.NaN;
    total += entry.weight;
  }
  return total;
}
