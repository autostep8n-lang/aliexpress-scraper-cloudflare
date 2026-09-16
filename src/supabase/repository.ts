import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";
import type { Product, ProductCategory } from "../products/types";
import type {
  CountryOpportunityObservationRow,
  CountryOpportunityPersistedRow,
} from "../country/types";
import type {
  GoogleTrendsObservationRow,
  GoogleTrendsPersistedRow,
  InstagramObservationRow,
  InstagramPersistedRow,
  RedditObservationRow,
  RedditPersistedRow,
  YouTubeObservationRow,
  YouTubePersistedRow,
} from "../market/types";
import { validateProduct } from "../products/validation";
import { getSupabaseClient } from "./client";
import type { ScoreRow } from "../scoring/types";
import { longestToken } from "../matching/normalize";
import { decideMerge, matchSignals, type MatchResult } from "../matching/match";
import {
  buildSignalsFromProduct,
  buildSignalsFromRow,
  deriveFingerprint,
  type ProductSignals,
} from "../matching/signals";

/**
 * Typed outcome of a repository operation. Never throws: every failure path is
 * represented explicitly so callers can branch without catching exceptions and
 * without ever mistaking a failure for success.
 *
 * - `created`: a new row was inserted
 * - `updated`: an existing row was updated (unique key collision on upsert)
 * - `found`: an existing row was read
 * - `not_found`: no matching row exists (read operations only)
 * - `credentials_missing`: Supabase is not configured (getSupabaseClient is null)
 * - `invalid`: the input failed structural validation
 * - `error`: the database rejected the operation
 */
export type RepositoryResult<T> =
  | { status: "created" | "updated" | "found"; data: T }
  | { status: "not_found" }
  | { status: "credentials_missing" }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string; code?: string };

export interface PersistedSourceRecord {
  id: string;
  slug: string;
  name: string;
  kind: string;
}

export interface PersistedProductRecord {
  id: string;
  dedup_key: string | null;
  canonical_url: string | null;
  title: string;
  description: string | null;
  brand: string | null;
  category_id: string | null;
  primary_image_url: string | null;
  images: unknown;
  attributes: unknown;
  availability_status: string;
  lifecycle_status: string;
  last_seen_at: string;
}

export interface PersistedObservationRecord {
  id: string;
  product_id: string;
  source_id: string;
  external_id: string;
  url: string;
  title: string | null;
  description: string | null;
  brand: string | null;
  category_id: string | null;
  image_urls: unknown;
  price: number;
  original_price: number | null;
  currency: string;
  shipping: unknown;
  rating_average: number | null;
  rating_count: number | null;
  available: boolean | null;
  attributes: unknown;
  raw: unknown;
  last_seen_at: string;
  last_scraped_at: string | null;
}

export interface PersistedScoreRecord {
  id: string;
  product_id: string;
  product_source_id: string | null;
  score_type: string;
  value: number;
  min_value: number | null;
  max_value: number | null;
  version: number;
  inputs: Record<string, unknown>;
  computed_at: string;
}

export interface PersistedAlertRecord {
  id: string;
  product_id: string;
  alert_type: string;
  severity: string;
  status: string;
  dedup_key: string | null;
  title: string;
  summary: string;
  country: string | null;
  value: number | null;
  tier: string | null;
  inputs: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Upsert payload for `public.alerts`. `first_seen_at` is intentionally absent:
 * omitting it preserves the original value on conflict while the database
 * default applies on insert.
 */
export interface AlertRow {
  product_id: string;
  alert_type: string;
  severity: string;
  status: string;
  dedup_key: string;
  title: string;
  summary: string;
  country?: string | null;
  value?: number | null;
  tier?: string | null;
  inputs: Record<string, unknown>;
  last_seen_at?: string;
  resolved_at?: string | null;
}

export interface ProductListFilter {
  limit: number;
  offset: number;
  lifecycle?: string;
  q?: string;
}

export interface ProductListPage {
  products: PersistedProductRecord[];
  total: number;
}

/** The full result of ingesting one product observation. */
export interface PersistedProduct {
  source: PersistedSourceRecord;
  product: PersistedProductRecord;
  observation: PersistedObservationRecord;
}

export interface UpsertProductOptions {
  /** Original payload stored on `product_sources.raw`. Only stored when it is a plain object. */
  raw?: unknown;
}

type Ok<T> = { status: "ok"; data: T; created: boolean };
type StepResult<T> = Ok<T> | { status: "error"; message: string; code?: string };

const SOURCE_SELECT = "id, slug, name, kind";
const PRODUCT_SELECT =
  "id, dedup_key, canonical_url, title, description, brand, category_id, primary_image_url, images, attributes, availability_status, lifecycle_status, last_seen_at";
const OBSERVATION_SELECT =
  "id, product_id, source_id, external_id, url, title, description, brand, category_id, image_urls, price, original_price, currency, shipping, rating_average, rating_count, available, attributes, raw, last_seen_at, last_scraped_at";
const GOOGLE_TRENDS_SELECT =
  "id, source_id, keyword, geo, property, category, time_range, period_start, period_end, value, captured_at, metadata, created_at, updated_at";
const GOOGLE_TRENDS_SOURCE_SLUG = "google-trends";
const GOOGLE_TRENDS_CONFLICT = "source_id,keyword,geo,property,time_range,period_start";
const REDDIT_SELECT =
  "id, source_id, keyword, result_limit, sort, time_filter, mentions, total_score, total_comments, avg_score, subreddit_count, top_subreddit, captured_at, metadata, created_at, updated_at";
const REDDIT_SOURCE_SLUG = "reddit";
const REDDIT_CONFLICT = "source_id,keyword";
const YOUTUBE_SELECT =
  "id, source_id, keyword, result_limit, order_by, published_within, video_count, total_views, total_likes, total_comments, avg_views, channel_count, top_video_id, top_video_title, top_channel, captured_at, metadata, created_at, updated_at";
const YOUTUBE_SOURCE_SLUG = "youtube";
const YOUTUBE_CONFLICT = "source_id,keyword,order_by,published_within";
const INSTAGRAM_SELECT =
  "id, source_id, keyword, hashtag, result_limit, media_count, top_media_count, recent_media_count, total_likes, total_comments, total_engagement, avg_likes, avg_engagement, top_media_id, top_media_caption, captured_at, metadata, created_at, updated_at";
const INSTAGRAM_SOURCE_SLUG = "instagram";
const INSTAGRAM_CONFLICT = "source_id,keyword";
const COUNTRY_OPPORTUNITY_SELECT =
  "id, product_id, country, keyword, score_type, value, min_value, max_value, normalized, total_weight, tier, version, inputs, country_latest_value, country_change, country_direction, computed_at, created_at, updated_at";
const COUNTRY_OPPORTUNITY_CONFLICT = "product_id,country,score_type";
const SCORE_SELECT =
  "id, product_id, product_source_id, score_type, value, min_value, max_value, version, inputs, computed_at";
const SCORE_CONFLICT = "product_id,score_type,version";
const ALERT_SELECT =
  "id, product_id, alert_type, severity, status, dedup_key, title, summary, country, value, tier, inputs, first_seen_at, last_seen_at, resolved_at, created_at, updated_at";
const ALERT_CONFLICT = "product_id,alert_type,dedup_key";

/**
 * Ingests one already-normalized Phase 1 `Product` into the P0.2 schema.
 *
 * Flow: validate -> ensure source (idempotent) -> best-effort category ->
 * matching/deduplication -> upsert unified `products` row on `dedup_key` ->
 * upsert `product_sources` observation on `(source_id, external_id)`. A product
 * is never duplicated: the same dedup_key reuses the unified row, a cross-source
 * match reuses the matched product row, and the same (source, external_id)
 * reuses the observation row. Per-platform data stays on `product_sources`; the
 * unified `products` row only carries cross-platform fields.
 *
 * Supabase-js cannot run multi-statement transactions through PostgREST, so a
 * failure mid-flow leaves already-persisted steps in place and is reported as a
 * typed `error` with a precise `code`; callers decide whether to retry.
 */
export async function upsertProduct(
  env: Env,
  product: Product,
  opts: UpsertProductOptions = {},
): Promise<RepositoryResult<PersistedProduct>> {
  const validation = validateProduct(product);
  if (!validation.valid) {
    return { status: "invalid", message: validation.errors.join("; ") };
  }

  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  const source = await ensureSource(client, product.platform);
  if (source.status === "error") {
    return { status: "error", code: source.code, message: source.message };
  }

  const signals = buildSignalsFromProduct(product);
  const fingerprint = deriveFingerprint(signals.identifiers, signals.variantTokens);
  const dedupKey = fingerprint ?? deriveDedupKey(product);
  const categoryId = await resolveCategoryId(client, source.data.id, product.category);

  const match = await findBestMatch(client, signals, fingerprint);

  let productId: string;
  let productRecord: PersistedProductRecord;
  if (match.matched) {
    productId = match.row.id;
    productRecord = match.row;
    await touchProductRow(client, match.row.id, product.scrapedAt);
  } else {
    const productResult = await upsertProductRow(client, buildProductRow(product, dedupKey, categoryId));
    if (productResult.status === "error") {
      return { status: "error", code: productResult.code, message: productResult.message };
    }
    productId = productResult.data.id;
    productRecord = productResult.data;
  }

  const observationRow = buildObservationRow(product, source.data.id, productId, categoryId, opts.raw);
  const observationResult = await upsertObservationRow(client, observationRow);
  if (observationResult.status === "error") {
    return { status: "error", code: observationResult.code, message: observationResult.message };
  }

  const status: "created" | "updated" = match.matched || !observationResult.created ? "updated" : "created";
  return {
    status,
    data: {
      source: source.data,
      product: productRecord,
      observation: observationResult.data,
    },
  };
}

/**
 * Finds the canonical `products` row an incoming product should map to.
 *
 * Exact global identifiers (fingerprint stored on `dedup_key`) are resolved
 * through the unique index; everything else is narrowed with a title trigram
 * lookup (longest distinctive title token) so matching never scans the table.
 * Matching failures are non-fatal: any error here falls back to "no match" so
 * ingestion always proceeds.
 */
async function findBestMatch(
  client: SupabaseClient,
  signals: ProductSignals,
  fingerprint: string | null,
): Promise<{ matched: true; row: PersistedProductRecord } | { matched: false }> {
  if (fingerprint) {
    try {
      const { data, error } = await client
        .from("products")
        .select(PRODUCT_SELECT)
        .eq("dedup_key", fingerprint)
        .maybeSingle();
      if (!error && data) {
        return { matched: true, row: data };
      }
    } catch {
      // fall through to the fuzzy candidate search
    }
  }

  const anchor = longestToken(signals.titleTokens, 4);
  if (!anchor) return { matched: false };

  let candidates: PersistedProductRecord[];
  try {
    const { data, error } = await client
      .from("products")
      .select(PRODUCT_SELECT)
      .ilike("title", `%${anchor}%`)
      .limit(25);
    if (error || !Array.isArray(data)) return { matched: false };
    candidates = data as PersistedProductRecord[];
  } catch {
    return { matched: false };
  }

  if (fingerprint) {
    candidates = candidates.filter((row) => row.dedup_key !== fingerprint);
  }

  let best: { match: MatchResult; row: PersistedProductRecord } | null = null;
  for (const row of candidates) {
    const candidateSignals = buildSignalsFromRow(row);
    const match = matchSignals(signals, candidateSignals);
    if (match.blocked) continue;
    if (!decideMerge(signals, match)) continue;
    if (!best || match.score > best.match.score) best = { match, row };
  }

  if (best) return { matched: true, row: best.row };
  return { matched: false };
}

/** Best-effort refresh of the matched product row's freshness marker. */
async function touchProductRow(client: SupabaseClient, productId: string, lastSeenAt: string): Promise<void> {
  try {
    await client.from("products").update({ last_seen_at: lastSeenAt }).eq("id", productId).select("id");
  } catch {
    // non-fatal: the matched row already carries the canonical identity
  }
}

/**
 * Reads an existing observation by source slug + external id. Useful for
 * "have we seen this before" checks before a full ingest.
 */
export async function getObservation(
  env: Env,
  sourceSlug: string,
  externalId: string,
): Promise<RepositoryResult<PersistedObservationRecord>> {
  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  const source = await ensureSource(client, sourceSlug);
  if (source.status === "error") {
    return { status: "error", code: source.code, message: source.message };
  }

  try {
    const { data, error } = await client
      .from("product_sources")
      .select(OBSERVATION_SELECT)
      .eq("source_id", source.data.id)
      .eq("external_id", externalId)
      .maybeSingle();
    if (error) {
      return { status: "error", code: "observation_lookup_failed", message: errorMessage(error, "failed to look up observation") };
    }
    if (!data) {
      return { status: "not_found" };
    }
    return { status: "found", data };
  } catch (err) {
    return { status: "error", code: "observation_lookup_failed", message: toString(err) };
  }
}

/**
 * Read-only product discovery listing (P6.26).
 *
 * Filters by optional lifecycle and title substring, then pages by
 * `last_seen_at` descending. Never writes.
 */
export async function listProducts(
  env: Env,
  filter: ProductListFilter,
): Promise<RepositoryResult<ProductListPage>> {
  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  try {
    let query = client
      .from("products")
      .select(PRODUCT_SELECT, { count: "exact" })
      .order("last_seen_at", { ascending: false })
      .range(filter.offset, filter.offset + filter.limit - 1);
    if (filter.lifecycle) {
      query = query.eq("lifecycle_status", filter.lifecycle);
    }
    if (filter.q) {
      query = query.ilike("title", `%${escapeIlike(filter.q)}%`);
    }
    const { data, error, count } = await query;
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "product_list_failed",
        message: errorMessage(error, "failed to list products"),
      };
    }
    return {
      status: "found",
      data: {
        products: data as PersistedProductRecord[],
        total: typeof count === "number" ? count : data.length,
      },
    };
  } catch (err) {
    return { status: "error", code: "product_list_failed", message: toString(err) };
  }
}

const PRODUCT_ID_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read-only product lookup by primary key (P6.28). Never writes.
 */
export async function getProductById(env: Env, productId: string): Promise<RepositoryResult<PersistedProductRecord>> {
  if (!PRODUCT_ID_UUID.test(productId)) {
    return { status: "not_found" };
  }

  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  try {
    const { data, error } = await client.from("products").select(PRODUCT_SELECT).eq("id", productId).maybeSingle();
    if (error) {
      return {
        status: "error",
        code: "product_lookup_failed",
        message: errorMessage(error, "failed to look up product"),
      };
    }
    if (!data) {
      return { status: "not_found" };
    }
    return { status: "found", data: data as PersistedProductRecord };
  } catch (err) {
    return { status: "error", code: "product_lookup_failed", message: toString(err) };
  }
}

/**
 * Read-only latest `scores` rows for the given product ids (P6.26).
 * Never writes. Callers pick the newest `computed_at` per score_type.
 */
export async function listScoresForProducts(
  env: Env,
  productIds: string[],
): Promise<RepositoryResult<PersistedScoreRecord[]>> {
  if (productIds.length === 0) {
    return { status: "found", data: [] };
  }
  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  try {
    const { data, error } = await client
      .from("scores")
      .select(SCORE_SELECT)
      .in("product_id", productIds)
      .order("computed_at", { ascending: false });
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "score_list_failed",
        message: errorMessage(error, "failed to list scores"),
      };
    }
    return { status: "found", data: data as PersistedScoreRecord[] };
  } catch (err) {
    return { status: "error", code: "score_list_failed", message: toString(err) };
  }
}

/**
 * Read-only country opportunity snapshots for the given product ids (P6.26).
 * Never writes.
 */
export async function listCountryOpportunityScoresForProducts(
  env: Env,
  productIds: string[],
): Promise<RepositoryResult<CountryOpportunityPersistedRow[]>> {
  if (productIds.length === 0) {
    return { status: "found", data: [] };
  }
  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  try {
    const { data, error } = await client
      .from("country_opportunity_scores")
      .select(COUNTRY_OPPORTUNITY_SELECT)
      .in("product_id", productIds);
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "country_opportunity_list_failed",
        message: errorMessage(error, "failed to list country opportunity scores"),
      };
    }
    return { status: "found", data: data as CountryOpportunityPersistedRow[] };
  } catch (err) {
    return { status: "error", code: "country_opportunity_list_failed", message: toString(err) };
  }
}

/**
 * Read-only observations for the given product ids (P7.30). Never writes.
 * Callers pick the most recent row per product when they need current values.
 */
export async function listObservationsForProducts(
  env: Env,
  productIds: string[],
): Promise<RepositoryResult<PersistedObservationRecord[]>> {
  if (productIds.length === 0) {
    return { status: "found", data: [] };
  }
  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  try {
    const { data, error } = await client
      .from("product_sources")
      .select(OBSERVATION_SELECT)
      .in("product_id", productIds)
      .order("last_seen_at", { ascending: false });
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "observation_list_failed",
        message: errorMessage(error, "failed to list product observations"),
      };
    }
    return { status: "found", data: data as PersistedObservationRecord[] };
  } catch (err) {
    return { status: "error", code: "observation_list_failed", message: toString(err) };
  }
}

function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

/**
 * Bulk-upserts Google Trends observations (P3.1 market intelligence).
 *
 * Rows carry `source_id: null`; the source row for `google-trends` (kind
 * `api`) is resolved idempotently and backfilled. Deduplication is on
 * `(source_id, keyword, geo, property, time_range, period_start)`: a re-collect
 * of the same bucket replaces the value rather than appending a duplicate.
 *
 * Because PostgREST reports a single status for a bulk upsert (201 if any row
 * was inserted, 200 if all were updated), `created`/`updated` describe the
 * overall outcome; callers that need per-row counts would need an extra
 * round-trip. Never throws.
 */
export async function upsertGoogleTrends(
  env: Env,
  rows: GoogleTrendsObservationRow[],
): Promise<RepositoryResult<GoogleTrendsPersistedRow[]>> {
  if (rows.length === 0) {
    return { status: "updated", data: [] };
  }

  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  const source = await ensureGoogleTrendsSource(client);
  if (source.status === "error") {
    return { status: "error", code: source.code, message: source.message };
  }

  const payload = rows.map((row) => ({ ...row, source_id: source.data.id }));

  try {
    const { data, error, status } = await client
      .from("google_trends")
      .upsert(payload, { onConflict: GOOGLE_TRENDS_CONFLICT })
      .select(GOOGLE_TRENDS_SELECT);
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "google_trends_upsert_failed",
        message: errorMessage(error, "failed to upsert google trends observations"),
      };
    }
    return {
      status: status === 201 ? "created" : "updated",
      data: data as GoogleTrendsPersistedRow[],
    };
  } catch (err) {
    return { status: "error", code: "google_trends_upsert_failed", message: toString(err) };
  }
}

/**
 * Resolves the `google-trends` source row (kind `api`). Reads first; creates
 * idempotently via an upsert keyed on the unique `slug` so concurrent calls
 * never conflict. Separate from `ensureSource` because market-intelligence
 * sources are `api`-kind, not `platform`-kind.
 */
async function ensureGoogleTrendsSource(client: SupabaseClient): Promise<StepResult<PersistedSourceRecord>> {
  try {
    const { data, error } = await client
      .from("sources")
      .select(SOURCE_SELECT)
      .eq("slug", GOOGLE_TRENDS_SOURCE_SLUG)
      .maybeSingle();
    if (error) {
      return { status: "error", code: "source_lookup_failed", message: errorMessage(error, "failed to look up source") };
    }
    if (data) {
      return { status: "ok", data, created: false };
    }
  } catch (err) {
    return { status: "error", code: "source_lookup_failed", message: toString(err) };
  }

  try {
    const { data, error, status } = await client
      .from("sources")
      .upsert({ slug: GOOGLE_TRENDS_SOURCE_SLUG, name: "Google Trends", kind: "api" }, { onConflict: "slug" })
      .select(SOURCE_SELECT)
      .maybeSingle();
    if (error || !data) {
      return { status: "error", code: "source_create_failed", message: errorMessage(error, "failed to create source") };
    }
    return { status: "ok", data, created: status === 201 };
  } catch (err) {
    return { status: "error", code: "source_create_failed", message: toString(err) };
  }
}

/**
 * Bulk-upserts Reddit market-intelligence signals (P3.2).
 *
 * Rows carry `source_id: null`; the source row for `reddit` (kind `api`) is
 * resolved idempotently and backfilled. Deduplication is on
 * `(source_id, keyword)`: a re-collect of the same keyword replaces the
 * snapshot rather than appending a duplicate (one snapshot per keyword).
 *
 * Because PostgREST reports a single status for a bulk upsert (201 if any row
 * was inserted, 200 if all were updated), `created`/`updated` describe the
 * overall outcome; callers that need per-row counts would need an extra
 * round-trip. Never throws.
 */
export async function upsertRedditSignals(
  env: Env,
  rows: RedditObservationRow[],
): Promise<RepositoryResult<RedditPersistedRow[]>> {
  if (rows.length === 0) {
    return { status: "updated", data: [] };
  }

  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  const source = await ensureRedditSource(client);
  if (source.status === "error") {
    return { status: "error", code: source.code, message: source.message };
  }

  const payload = rows.map((row) => ({ ...row, source_id: source.data.id }));

  try {
    const { data, error, status } = await client
      .from("reddit_signals")
      .upsert(payload, { onConflict: REDDIT_CONFLICT })
      .select(REDDIT_SELECT);
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "reddit_signals_upsert_failed",
        message: errorMessage(error, "failed to upsert reddit signals"),
      };
    }
    return {
      status: status === 201 ? "created" : "updated",
      data: data as RedditPersistedRow[],
    };
  } catch (err) {
    return { status: "error", code: "reddit_signals_upsert_failed", message: toString(err) };
  }
}

/**
 * Resolves the `reddit` source row (kind `api`). Reads first; creates
 * idempotently via an upsert keyed on the unique `slug` so concurrent calls
 * never conflict. Separate from `ensureSource` because market-intelligence
 * sources are `api`-kind, not `platform`-kind.
 */
async function ensureRedditSource(client: SupabaseClient): Promise<StepResult<PersistedSourceRecord>> {
  try {
    const { data, error } = await client
      .from("sources")
      .select(SOURCE_SELECT)
      .eq("slug", REDDIT_SOURCE_SLUG)
      .maybeSingle();
    if (error) {
      return { status: "error", code: "source_lookup_failed", message: errorMessage(error, "failed to look up source") };
    }
    if (data) {
      return { status: "ok", data, created: false };
    }
  } catch (err) {
    return { status: "error", code: "source_lookup_failed", message: toString(err) };
  }

  try {
    const { data, error, status } = await client
      .from("sources")
      .upsert({ slug: REDDIT_SOURCE_SLUG, name: "Reddit", kind: "api" }, { onConflict: "slug" })
      .select(SOURCE_SELECT)
      .maybeSingle();
    if (error || !data) {
      return { status: "error", code: "source_create_failed", message: errorMessage(error, "failed to create source") };
    }
    return { status: "ok", data, created: status === 201 };
  } catch (err) {
    return { status: "error", code: "source_create_failed", message: toString(err) };
  }
}

/**
 * Bulk-upserts YouTube market-intelligence signals (P3.3).
 *
 * Rows carry `source_id: null`; the source row for `youtube` is resolved
 * idempotently and backfilled. Unlike Reddit/Google Trends, the `youtube`
 * source already exists as a `platform`-kind row seeded by migration
 * 20260817000009, so the read-first lookup normally just reuses it (no new row
 * is created). Deduplication is on
 * `(source_id, keyword, order_by, published_within)`: a re-collect of the same
 * keyword with the same sort/recency replaces the snapshot rather than
 * appending a duplicate (one snapshot per keyword per sort/recency).
 *
 * Because PostgREST reports a single status for a bulk upsert (201 if any row
 * was inserted, 200 if all were updated), `created`/`updated` describe the
 * overall outcome; callers that need per-row counts would need an extra
 * round-trip. Never throws.
 */
export async function upsertYouTubeSignals(
  env: Env,
  rows: YouTubeObservationRow[],
): Promise<RepositoryResult<YouTubePersistedRow[]>> {
  if (rows.length === 0) {
    return { status: "updated", data: [] };
  }

  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  const source = await ensureYouTubeSource(client);
  if (source.status === "error") {
    return { status: "error", code: source.code, message: source.message };
  }

  const payload = rows.map((row) => ({ ...row, source_id: source.data.id }));

  try {
    const { data, error, status } = await client
      .from("youtube_signals")
      .upsert(payload, { onConflict: YOUTUBE_CONFLICT })
      .select(YOUTUBE_SELECT);
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "youtube_signals_upsert_failed",
        message: errorMessage(error, "failed to upsert youtube signals"),
      };
    }
    return {
      status: status === 201 ? "created" : "updated",
      data: data as YouTubePersistedRow[],
    };
  } catch (err) {
    return { status: "error", code: "youtube_signals_upsert_failed", message: toString(err) };
  }
}

/**
 * Resolves the `youtube` source row. The `youtube` source is seeded as a
 * `platform`-kind row by migration 20260817000009, so this normally reads and
 * reuses it. When it is missing (fresh environments, tests) it is created
 * idempotently via an upsert keyed on the unique `slug` so concurrent calls
 * never conflict. Separate from `ensureSource` because market-intelligence
 * sources follow the Reddit/Google Trends read-then-create contract.
 */
async function ensureYouTubeSource(client: SupabaseClient): Promise<StepResult<PersistedSourceRecord>> {
  try {
    const { data, error } = await client
      .from("sources")
      .select(SOURCE_SELECT)
      .eq("slug", YOUTUBE_SOURCE_SLUG)
      .maybeSingle();
    if (error) {
      return { status: "error", code: "source_lookup_failed", message: errorMessage(error, "failed to look up source") };
    }
    if (data) {
      return { status: "ok", data, created: false };
    }
  } catch (err) {
    return { status: "error", code: "source_lookup_failed", message: toString(err) };
  }

  try {
    const { data, error, status } = await client
      .from("sources")
      .upsert({ slug: YOUTUBE_SOURCE_SLUG, name: "YouTube", kind: "api" }, { onConflict: "slug" })
      .select(SOURCE_SELECT)
      .maybeSingle();
    if (error || !data) {
      return { status: "error", code: "source_create_failed", message: errorMessage(error, "failed to create source") };
    }
    return { status: "ok", data, created: status === 201 };
  } catch (err) {
    return { status: "error", code: "source_create_failed", message: toString(err) };
  }
}

/**
 * Bulk-upserts Instagram market-intelligence signals (P3.4).
 *
 * Rows carry `source_id: null`; the source row for `instagram` is resolved
 * idempotently and backfilled. Like `youtube`, the `instagram` source already
 * exists as a `platform`-kind row seeded by migration 20260817000009, so the
 * read-first lookup normally just reuses it (no new row is created).
 * Deduplication is on `(source_id, keyword)`: a re-collect of the same keyword
 * replaces the snapshot rather than appending a duplicate (one snapshot per
 * keyword).
 *
 * Because PostgREST reports a single status for a bulk upsert (201 if any row
 * was inserted, 200 if all were updated), `created`/`updated` describe the
 * overall outcome; callers that need per-row counts would need an extra
 * round-trip. Never throws.
 */
export async function upsertInstagramSignals(
  env: Env,
  rows: InstagramObservationRow[],
): Promise<RepositoryResult<InstagramPersistedRow[]>> {
  if (rows.length === 0) {
    return { status: "updated", data: [] };
  }

  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  const source = await ensureInstagramSource(client);
  if (source.status === "error") {
    return { status: "error", code: source.code, message: source.message };
  }

  const payload = rows.map((row) => ({ ...row, source_id: source.data.id }));

  try {
    const { data, error, status } = await client
      .from("instagram_signals")
      .upsert(payload, { onConflict: INSTAGRAM_CONFLICT })
      .select(INSTAGRAM_SELECT);
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "instagram_signals_upsert_failed",
        message: errorMessage(error, "failed to upsert instagram signals"),
      };
    }
    return {
      status: status === 201 ? "created" : "updated",
      data: data as InstagramPersistedRow[],
    };
  } catch (err) {
    return { status: "error", code: "instagram_signals_upsert_failed", message: toString(err) };
  }
}

/**
 * Resolves the `instagram` source row. The `instagram` source is seeded as a
 * `platform`-kind row by migration 20260817000009, so this normally reads and
 * reuses it. When it is missing (fresh environments, tests) it is created
 * idempotently via an upsert keyed on the unique `slug` so concurrent calls
 * never conflict. Separate from `ensureSource` because market-intelligence
 * sources follow the Reddit/Google Trends read-then-create contract.
 */
async function ensureInstagramSource(client: SupabaseClient): Promise<StepResult<PersistedSourceRecord>> {
  try {
    const { data, error } = await client
      .from("sources")
      .select(SOURCE_SELECT)
      .eq("slug", INSTAGRAM_SOURCE_SLUG)
      .maybeSingle();
    if (error) {
      return { status: "error", code: "source_lookup_failed", message: errorMessage(error, "failed to look up source") };
    }
    if (data) {
      return { status: "ok", data, created: false };
    }
  } catch (err) {
    return { status: "error", code: "source_lookup_failed", message: toString(err) };
  }

  try {
    const { data, error, status } = await client
      .from("sources")
      .upsert({ slug: INSTAGRAM_SOURCE_SLUG, name: "Instagram", kind: "api" }, { onConflict: "slug" })
      .select(SOURCE_SELECT)
      .maybeSingle();
    if (error || !data) {
      return { status: "error", code: "source_create_failed", message: errorMessage(error, "failed to create source") };
    }
    return { status: "ok", data, created: status === 201 };
  } catch (err) {
    return { status: "error", code: "source_create_failed", message: toString(err) };
  }
}

/**
 * Bulk-upserts country opportunity scores (P4.23).
 *
 * Deduplication is on `(product_id, country, score_type)`: a re-score of the
 * same product x country replaces the snapshot rather than appending a
 * duplicate. No source row is required; scores are product-scoped, not
 * market-signal-scoped. Never throws.
 */
export async function upsertCountryOpportunityScores(
  env: Env,
  rows: CountryOpportunityObservationRow[],
): Promise<RepositoryResult<CountryOpportunityPersistedRow[]>> {
  if (rows.length === 0) {
    return { status: "updated", data: [] };
  }

  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  try {
    const { data, error, status } = await client
      .from("country_opportunity_scores")
      .upsert(rows, { onConflict: COUNTRY_OPPORTUNITY_CONFLICT })
      .select(COUNTRY_OPPORTUNITY_SELECT);
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "country_opportunity_upsert_failed",
        message: errorMessage(error, "failed to upsert country opportunity scores"),
      };
    }
    return {
      status: status === 201 ? "created" : "updated",
      data: data as CountryOpportunityPersistedRow[],
    };
  } catch (err) {
    return { status: "error", code: "country_opportunity_upsert_failed", message: toString(err) };
  }
}

/**
 * Bulk-upserts generic computed scores (P7.30).
 *
 * Deduplication is on `(product_id, score_type, version)`: re-running the
 * pipeline replaces the row (value, inputs, computed_at) instead of appending
 * duplicate history. No source row is required; these scores are product-scoped.
 * A row without a `product_id` cannot satisfy the NOT NULL column, so it is
 * rejected as `invalid` rather than sent to PostgREST. Never throws.
 */
export async function upsertScores(
  env: Env,
  rows: ScoreRow[],
): Promise<RepositoryResult<PersistedScoreRecord[]>> {
  if (rows.length === 0) {
    return { status: "updated", data: [] };
  }

  const invalid = rows.find((row) => typeof row.product_id !== "string" || row.product_id.length === 0);
  if (invalid) {
    return { status: "invalid", message: "score rows require a non-empty product_id" };
  }

  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  try {
    const { data, error, status } = await client
      .from("scores")
      .upsert(rows, { onConflict: SCORE_CONFLICT })
      .select(SCORE_SELECT);
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "scores_upsert_failed",
        message: errorMessage(error, "failed to upsert scores"),
      };
    }
    return {
      status: status === 201 ? "created" : "updated",
      data: data as PersistedScoreRecord[],
    };
  } catch (err) {
    return { status: "error", code: "scores_upsert_failed", message: toString(err) };
  }
}

/**
 * Bulk-upserts alerts (P7.31).
 *
 * Deduplication is on `(product_id, alert_type, dedup_key)`: re-evaluating a
 * still-true condition refreshes the row instead of appending duplicates.
 * Callers pass `status: "active"` and `resolved_at: null` so a previously
 * resolved condition that reappears is reactivated. `first_seen_at` is never
 * sent, so the original first-observation timestamp survives the conflict.
 * A row without a `product_id` or `dedup_key` cannot satisfy the NOT NULL /
 * unique columns, so it is rejected as `invalid` rather than sent to
 * PostgREST. Never throws.
 */
export async function upsertAlerts(
  env: Env,
  rows: AlertRow[],
): Promise<RepositoryResult<PersistedAlertRecord[]>> {
  if (rows.length === 0) {
    return { status: "updated", data: [] };
  }

  const invalid = rows.find(
    (row) =>
      typeof row.product_id !== "string" ||
      row.product_id.length === 0 ||
      typeof row.dedup_key !== "string" ||
      row.dedup_key.length === 0,
  );
  if (invalid) {
    return { status: "invalid", message: "alert rows require a non-empty product_id and dedup_key" };
  }

  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  try {
    const { data, error, status } = await client
      .from("alerts")
      .upsert(rows, { onConflict: ALERT_CONFLICT })
      .select(ALERT_SELECT);
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "alerts_upsert_failed",
        message: errorMessage(error, "failed to upsert alerts"),
      };
    }
    return {
      status: status === 201 ? "created" : "updated",
      data: data as PersistedAlertRecord[],
    };
  } catch (err) {
    return { status: "error", code: "alerts_upsert_failed", message: toString(err) };
  }
}

/**
 * Read-only active alerts for the given product ids (P7.31). Used by the
 * pipeline to resolve alerts whose condition has disappeared. Never writes.
 */
export async function listActiveAlertsForProducts(
  env: Env,
  productIds: string[],
): Promise<RepositoryResult<PersistedAlertRecord[]>> {
  if (productIds.length === 0) {
    return { status: "found", data: [] };
  }
  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  try {
    const { data, error } = await client
      .from("alerts")
      .select(ALERT_SELECT)
      .in("product_id", productIds)
      .eq("status", "active");
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "alert_list_failed",
        message: errorMessage(error, "failed to list active alerts"),
      };
    }
    return { status: "found", data: data as PersistedAlertRecord[] };
  } catch (err) {
    return { status: "error", code: "alert_list_failed", message: toString(err) };
  }
}

/**
 * Marks alerts as resolved with an explicit timestamp (P7.31). Only used for
 * alerts whose condition no longer holds; the evaluated-at time is passed in
 * by the caller so resolution stays deterministic and testable. Never throws.
 */
export async function resolveAlerts(
  env: Env,
  alertIds: string[],
  resolvedAt: string,
): Promise<RepositoryResult<PersistedAlertRecord[]>> {
  if (alertIds.length === 0) {
    return { status: "updated", data: [] };
  }
  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  try {
    const { data, error } = await client
      .from("alerts")
      .update({ status: "resolved", resolved_at: resolvedAt })
      .in("id", alertIds)
      .select(ALERT_SELECT);
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "alerts_resolve_failed",
        message: errorMessage(error, "failed to resolve alerts"),
      };
    }
    return { status: "updated", data: data as PersistedAlertRecord[] };
  } catch (err) {
    return { status: "error", code: "alerts_resolve_failed", message: toString(err) };
  }
}

/**
 * Read-only page of alerts, most recently seen first (P7.31). The public feed
 * only ever reads; alerts are produced by the scheduled pipeline. `status`
 * defaults to `active` but a caller may explicitly request `resolved` rows.
 */
export async function listAlerts(
  env: Env,
  filter: { limit: number; offset: number; status?: string },
): Promise<RepositoryResult<PersistedAlertRecord[]>> {
  const client = getSupabaseClient(env);
  if (!client) {
    return { status: "credentials_missing" };
  }

  try {
    const { data, error } = await client
      .from("alerts")
      .select(ALERT_SELECT)
      .eq("status", filter.status ?? "active")
      .order("last_seen_at", { ascending: false })
      .range(filter.offset, filter.offset + filter.limit - 1);
    if (error || !Array.isArray(data)) {
      return {
        status: "error",
        code: "alert_list_failed",
        message: errorMessage(error, "failed to list alerts"),
      };
    }
    return { status: "found", data: data as PersistedAlertRecord[] };
  } catch (err) {
    return { status: "error", code: "alert_list_failed", message: toString(err) };
  }
}

/**
 * Resolves the source row for a platform slug. Reads first (no write on the
 * common path); when the source is missing it is created idempotently via an
 * upsert keyed on the unique `slug`, so concurrent callers never conflict.
 */
async function ensureSource(client: SupabaseClient, slug: string): Promise<StepResult<PersistedSourceRecord>> {
  try {
    const { data, error } = await client.from("sources").select(SOURCE_SELECT).eq("slug", slug).maybeSingle();
    if (error) {
      return { status: "error", code: "source_lookup_failed", message: errorMessage(error, "failed to look up source") };
    }
    if (data) {
      return { status: "ok", data, created: false };
    }
  } catch (err) {
    return { status: "error", code: "source_lookup_failed", message: toString(err) };
  }

  try {
    const { data, error, status } = await client
      .from("sources")
      .upsert({ slug, name: displayName(slug), kind: "platform" }, { onConflict: "slug" })
      .select(SOURCE_SELECT)
      .maybeSingle();
    if (error || !data) {
      return { status: "error", code: "source_create_failed", message: errorMessage(error, "failed to create source") };
    }
    return { status: "ok", data, created: status === 201 };
  } catch (err) {
    return { status: "error", code: "source_create_failed", message: toString(err) };
  }
}

/**
 * Best-effort category resolution. Returns a category id when the product
 * carries a category name, otherwise null. Failures are non-fatal: a category
 * that cannot be stored must not block ingestion of the product itself.
 */
async function resolveCategoryId(
  client: SupabaseClient,
  sourceId: string,
  category: ProductCategory | undefined,
): Promise<string | null> {
  const name = category?.name?.trim();
  if (!name) {
    return null;
  }
  const externalId = category?.id?.trim() || slugify(name);
  try {
    const { data, error } = await client
      .from("product_categories")
      .upsert(
        { source_id: sourceId, external_id: externalId, name, slug: slugify(name), path: category?.path ?? [] },
        { onConflict: "source_id,external_id" },
      )
      .select("id")
      .maybeSingle();
    if (error || !data) {
      return null;
    }
    return data.id;
  } catch {
    return null;
  }
}

async function upsertProductRow(
  client: SupabaseClient,
  row: Record<string, unknown>,
): Promise<StepResult<PersistedProductRecord>> {
  try {
    const { data, error, status } = await client
      .from("products")
      .upsert(row, { onConflict: "dedup_key" })
      .select(PRODUCT_SELECT)
      .maybeSingle();
    if (error || !data) {
      return { status: "error", code: "product_upsert_failed", message: errorMessage(error, "failed to upsert product") };
    }
    return { status: "ok", data, created: status === 201 };
  } catch (err) {
    return { status: "error", code: "product_upsert_failed", message: toString(err) };
  }
}

async function upsertObservationRow(
  client: SupabaseClient,
  row: Record<string, unknown>,
): Promise<StepResult<PersistedObservationRecord>> {
  try {
    const { data, error, status } = await client
      .from("product_sources")
      .upsert(row, { onConflict: "source_id,external_id" })
      .select(OBSERVATION_SELECT)
      .maybeSingle();
    if (error || !data) {
      return {
        status: "error",
        code: "observation_upsert_failed",
        message: errorMessage(error, "failed to upsert product observation"),
      };
    }
    return { status: "ok", data, created: status === 201 };
  } catch (err) {
    return { status: "error", code: "observation_upsert_failed", message: toString(err) };
  }
}

function buildProductRow(product: Product, dedupKey: string, categoryId: string | null): Record<string, unknown> {
  const images = normalizeImages(product.images);
  const brand = deriveBrand(product);
  return {
    dedup_key: dedupKey,
    canonical_url: product.url,
    title: product.title,
    description: product.description ?? null,
    brand,
    category_id: categoryId,
    primary_image_url: images[0]?.url ?? null,
    images,
    attributes: product.attributes ?? {},
    availability_status: availabilityStatus(product.available),
    last_seen_at: product.scrapedAt,
  };
}

function buildObservationRow(
  product: Product,
  sourceId: string,
  productId: string,
  categoryId: string | null,
  raw: unknown,
): Record<string, unknown> {
  return {
    product_id: productId,
    source_id: sourceId,
    external_id: product.externalId,
    external_parent_id: null,
    url: product.url,
    title: product.title,
    description: product.description ?? null,
    brand: deriveBrand(product),
    category_id: categoryId,
    image_urls: normalizeImages(product.images),
    price: product.price.amount,
    original_price: product.price.originalAmount ?? null,
    currency: product.price.currency,
    shipping: product.shipping ?? {},
    rating_average: product.rating?.average ?? null,
    rating_count: product.rating?.count ?? null,
    available: product.available ?? null,
    attributes: product.attributes ?? {},
    raw: isPlainObject(raw) ? raw : null,
    last_seen_at: product.scrapedAt,
    last_scraped_at: product.scrapedAt,
  };
}

function deriveDedupKey(product: Product): string {
  return `${product.platform}:${product.externalId}`;
}

function deriveBrand(product: Product): string | null {
  const brand = product.attributes?.brand;
  return typeof brand === "string" && brand.trim() ? brand.trim() : null;
}

function normalizeImages(images: Product["images"]): Array<{ url: string; alt?: string }> {
  return (images ?? []).map((image) => ({ url: image.url, ...(image.alt ? { alt: image.alt } : {}) }));
}

function availabilityStatus(available: boolean | undefined): "in_stock" | "out_of_stock" | "unknown" {
  if (available === true) return "in_stock";
  if (available === false) return "out_of_stock";
  return "unknown";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayName(slug: string): string {
  const known: Record<string, string> = {
    aliexpress: "AliExpress",
    "tiktok-shop": "TikTok Shop",
    amazon: "Amazon",
    youtube: "YouTube",
    instagram: "Instagram",
    facebook: "Facebook",
    alibaba: "Alibaba",
    manual: "Manual Entry",
  };
  if (known[slug]) return known[slug];
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function errorMessage(
  error: { message?: string; details?: string; hint?: string; code?: string } | null,
  fallback: string,
): string {
  if (!error) return fallback;
  const parts = [error.message, error.details, error.hint].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.join(" ") || fallback;
}

function toString(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
