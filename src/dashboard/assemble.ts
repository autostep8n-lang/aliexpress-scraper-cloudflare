import { explainDecision } from "../analyst";
import { isV1Country } from "../country";
import type { CountryOpportunityPersistedRow, CountryOpportunityResult, V1Country } from "../country/types";
import { scoreDecisionOpportunity } from "../decision";
import type { Env } from "../env";
import { LIFECYCLE_STATES, type LifecycleStatus } from "../lifecycle/types";
import { DEFAULT_OPPORTUNITY_THRESHOLDS, type OpportunityResult, type OpportunityTier } from "../opportunity/types";
import type { ScoreResult, ScoreSignal } from "../scoring/types";
import {
  listCountryOpportunityScoresForProducts,
  listProducts,
  listScoresForProducts,
  type PersistedProductRecord,
  type PersistedScoreRecord,
} from "../supabase/repository";
import {
  DEFAULT_PRODUCT_LIST_LIMIT,
  MAX_PRODUCT_LIST_LIMIT,
  type DiscoveryPage,
  type DiscoveryProduct,
  type ProductListQuery,
} from "./types";

export type ProductListQueryError = {
  ok: false;
  code: "INVALID_LIMIT" | "INVALID_OFFSET" | "INVALID_LIFECYCLE";
  message: string;
};

export type ParsedProductListQuery = { ok: true; query: ProductListQuery } | ProductListQueryError;

const LIFECYCLE_SET = new Set<string>(LIFECYCLE_STATES);
const DIRECTIONS = new Set(["up", "down", "flat", "unknown"]);

export function parseProductListQuery(params: URLSearchParams): ParsedProductListQuery {
  let limit = DEFAULT_PRODUCT_LIST_LIMIT;
  const limitRaw = params.get("limit");
  if (limitRaw !== null && limitRaw !== "") {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      return { ok: false, code: "INVALID_LIMIT", message: "Invalid 'limit' parameter" };
    }
    limit = Math.min(limit, MAX_PRODUCT_LIST_LIMIT);
  }

  let offset = 0;
  const offsetRaw = params.get("offset");
  if (offsetRaw !== null && offsetRaw !== "") {
    offset = Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0) {
      return { ok: false, code: "INVALID_OFFSET", message: "Invalid 'offset' parameter" };
    }
  }

  const lifecycleRaw = params.get("lifecycle")?.trim();
  let lifecycle: LifecycleStatus | undefined;
  if (lifecycleRaw) {
    if (!LIFECYCLE_SET.has(lifecycleRaw)) {
      return { ok: false, code: "INVALID_LIFECYCLE", message: "Invalid 'lifecycle' parameter" };
    }
    lifecycle = lifecycleRaw as LifecycleStatus;
  }

  const q = params.get("q")?.trim() || undefined;
  return { ok: true, query: { limit, offset, lifecycle, q } };
}

export type DiscoveryLoadResult =
  | { status: "ok"; data: DiscoveryPage }
  | { status: "credentials_missing" }
  | { status: "error"; message: string; code?: string };

export async function loadDiscoveryPage(env: Env, query: ProductListQuery): Promise<DiscoveryLoadResult> {
  const listed = await listProducts(env, query);
  if (listed.status === "credentials_missing") {
    return { status: "credentials_missing" };
  }
  if (listed.status === "error") {
    return { status: "error", message: listed.message, code: listed.code };
  }
  if (listed.status !== "found") {
    return { status: "error", message: "Unexpected repository outcome", code: "PRODUCT_LIST_FAILED" };
  }

  const productIds = listed.data.products.map((product) => product.id);
  const scores = await listScoresForProducts(env, productIds);
  if (scores.status === "credentials_missing") {
    return { status: "credentials_missing" };
  }
  if (scores.status === "error") {
    return { status: "error", message: scores.message, code: scores.code };
  }
  if (scores.status !== "found") {
    return { status: "error", message: "Unexpected repository outcome", code: "SCORE_LIST_FAILED" };
  }

  const countries = await listCountryOpportunityScoresForProducts(env, productIds);
  if (countries.status === "credentials_missing") {
    return { status: "credentials_missing" };
  }
  if (countries.status === "error") {
    return { status: "error", message: countries.message, code: countries.code };
  }
  if (countries.status !== "found") {
    return { status: "error", message: "Unexpected repository outcome", code: "COUNTRY_OPPORTUNITY_LIST_FAILED" };
  }

  return {
    status: "ok",
    data: assembleDiscoveryPage(listed.data.products, scores.data, countries.data, query, listed.data.total),
  };
}

export function assembleDiscoveryPage(
  products: PersistedProductRecord[],
  scores: PersistedScoreRecord[],
  countryScores: CountryOpportunityPersistedRow[],
  query: ProductListQuery,
  total: number,
): DiscoveryPage {
  return {
    status: "ok",
    products: assembleDiscoveryProducts(products, scores, countryScores),
    page: { limit: query.limit, offset: query.offset, total },
  };
}

export function assembleDiscoveryProducts(
  products: PersistedProductRecord[],
  scores: PersistedScoreRecord[],
  countryScores: CountryOpportunityPersistedRow[],
): DiscoveryProduct[] {
  const scoresByProduct = latestScoresByProduct(scores);
  const countriesByProduct = groupCountryScores(countryScores);
  return products.map((product) => {
    const productScores = scoresByProduct.get(product.id);
    const marketOpportunity = reconstructMarketOpportunity(productScores);
    const countryOpportunities = reconstructCountryOpportunities(product.id, countriesByProduct.get(product.id) ?? []);
    const decision = scoreDecisionOpportunity({
      productId: product.id,
      ...(marketOpportunity ? { marketOpportunity } : {}),
      ...(countryOpportunities.length > 0 ? { countryOpportunities } : {}),
    });
    const analyst = explainDecision(decision);
    return {
      id: product.id,
      title: product.title,
      brand: product.brand,
      primaryImageUrl: product.primary_image_url,
      canonicalUrl: product.canonical_url,
      availabilityStatus: product.availability_status,
      lifecycleStatus: product.lifecycle_status,
      lastSeenAt: product.last_seen_at,
      decision: {
        score: analyst.score,
        selectedCountry: analyst.selectedCountry,
        summary: analyst.summary,
        caveats: analyst.caveats,
        provider: analyst.provider,
      },
    };
  });
}

function latestScoresByProduct(scores: PersistedScoreRecord[]): Map<string, Map<string, PersistedScoreRecord>> {
  const byProduct = new Map<string, Map<string, PersistedScoreRecord>>();
  for (const row of scores) {
    const types = byProduct.get(row.product_id) ?? new Map<string, PersistedScoreRecord>();
    const existing = types.get(row.score_type);
    if (!existing || compareComputedAt(row.computed_at, existing.computed_at) > 0) {
      types.set(row.score_type, row);
    }
    byProduct.set(row.product_id, types);
  }
  return byProduct;
}

function groupCountryScores(rows: CountryOpportunityPersistedRow[]): Map<string, CountryOpportunityPersistedRow[]> {
  const grouped = new Map<string, CountryOpportunityPersistedRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.product_id) ?? [];
    list.push(row);
    grouped.set(row.product_id, list);
  }
  return grouped;
}

function reconstructMarketOpportunity(scores: Map<string, PersistedScoreRecord> | undefined): OpportunityResult | undefined {
  if (!scores) return undefined;
  const marketRow = scores.get("market_opportunity");
  if (!marketRow) return undefined;
  const score = scoreFromPersisted(marketRow);
  if (!score || score.scoreType !== "market_opportunity") return undefined;
  const competitionRow = scores.get("competition");
  const competition = competitionRow ? scoreFromPersisted(competitionRow) : emptyCompetition();
  return {
    competition: competition ?? emptyCompetition(),
    score,
    tier: deriveTier(score),
  };
}

function reconstructCountryOpportunities(
  productId: string,
  rows: CountryOpportunityPersistedRow[],
): CountryOpportunityResult[] {
  const results: CountryOpportunityResult[] = [];
  for (const row of rows) {
    if (row.product_id !== productId) continue;
    if (row.score_type !== "country_opportunity") continue;
    if (!isV1Country(row.country)) continue;
    const keyword = typeof row.keyword === "string" ? row.keyword.trim() : "";
    if (!keyword) continue;
    const score = countryScoreFromRow(row);
    if (!score) continue;
    results.push({
      productId,
      country: row.country as V1Country,
      keyword,
      countryIntelligence: {
        keyword,
        country: row.country as V1Country,
        observationCount: 0,
        latestValue: toFiniteNumber(row.country_latest_value),
        firstValue: null,
        change: toFiniteNumber(row.country_change),
        direction: DIRECTIONS.has(String(row.country_direction)) ? (row.country_direction as "up" | "down" | "flat" | "unknown") : "unknown",
        spanMs: null,
        peakValue: null,
        capturedAt: row.computed_at ?? null,
      },
      score,
      tier: row.tier === "high" || row.tier === "medium" || row.tier === "low" || row.tier === "unknown" ? row.tier : deriveTier(score),
    });
  }
  return results;
}

function countryScoreFromRow(row: CountryOpportunityPersistedRow): ScoreResult | null {
  const value = toFiniteNumber(row.value);
  if (value === null) return null;
  const inputs = isPlainObject(row.inputs) ? row.inputs : {};
  const signals = readSignals(inputs.signals);
  const present = signals.filter((signal) => signal.present);
  const totalWeight =
    toFiniteNumber(row.total_weight) ?? present.reduce((sum, signal) => sum + signal.weight, 0);
  const normalized = toFiniteNumber(row.normalized) ?? readNormalized(inputs);
  return {
    scoreType: row.score_type,
    version: toFiniteNumber(row.version) ?? 1,
    value,
    minValue: toFiniteNumber(row.min_value) ?? 0,
    maxValue: toFiniteNumber(row.max_value) ?? 100,
    normalized: normalized ?? 0,
    totalWeight,
    signals,
    inputs,
  };
}

function scoreFromPersisted(row: PersistedScoreRecord): ScoreResult | null {
  const value = toFiniteNumber(row.value);
  if (value === null) return null;
  const inputs = isPlainObject(row.inputs) ? row.inputs : {};
  const signals = readSignals(inputs.signals);
  const present = signals.filter((signal) => signal.present);
  const totalWeight = present.reduce((sum, signal) => sum + signal.weight, 0);
  return {
    scoreType: row.score_type,
    version: toFiniteNumber(row.version) ?? 1,
    value,
    minValue: toFiniteNumber(row.min_value) ?? 0,
    maxValue: toFiniteNumber(row.max_value) ?? 100,
    normalized: readNormalized(inputs),
    totalWeight,
    signals,
    inputs,
  };
}

function emptyCompetition(): ScoreResult {
  return {
    scoreType: "competition",
    version: 1,
    value: 0,
    minValue: 0,
    maxValue: 100,
    normalized: 0,
    totalWeight: 0,
    signals: [],
    inputs: {},
  };
}

function deriveTier(score: ScoreResult): OpportunityTier {
  if (score.totalWeight === 0) return "unknown";
  if (score.value >= DEFAULT_OPPORTUNITY_THRESHOLDS.high) return "high";
  if (score.value >= DEFAULT_OPPORTUNITY_THRESHOLDS.medium) return "medium";
  return "low";
}

function readSignals(value: unknown): ScoreSignal[] {
  if (!Array.isArray(value)) return [];
  const signals: ScoreSignal[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.key !== "string" || typeof entry.label !== "string") continue;
    const weight = toFiniteNumber(entry.weight);
    const signalValue = toFiniteNumber(entry.value);
    const contribution = toFiniteNumber(entry.contribution);
    if (weight === null || signalValue === null || contribution === null) continue;
    if (typeof entry.present !== "boolean") continue;
    const signal: ScoreSignal = {
      key: entry.key,
      label: entry.label,
      weight,
      value: signalValue,
      present: entry.present,
      contribution,
    };
    if (typeof entry.detail === "string") signal.detail = entry.detail;
    signals.push(signal);
  }
  return signals;
}

function readNormalized(inputs: Record<string, unknown>): number {
  return toFiniteNumber(inputs.normalized) ?? 0;
}

function compareComputedAt(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
