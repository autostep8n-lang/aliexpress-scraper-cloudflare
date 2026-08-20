import type { Env } from "../env";
import type { Product } from "../products/types";
import type { PersistedProduct, RepositoryResult } from "../supabase/repository";

/**
 * Platforms that support product discovery (searching for many products at
 * once, as opposed to scraping a single known URL). Concrete modules live in
 * the same folder as this contract.
 */
export type DiscoveryPlatform = "tiktok-shop";

/** Inputs to a discovery run. `limit` must already be normalized by the caller. */
export interface DiscoveryQuery {
  /** Free-text search term, e.g. "wireless earbuds". Mutually optional with `category`. */
  query?: string;
  /** TikTok Shop category id to browse. Mutually optional with `query`. */
  category?: string;
  /** Optional region/country code, e.g. "US". */
  region?: string;
  /** Maximum number of products to discover and persist. */
  limit: number;
}

/** The outcome of discovering and persisting a single product. */
export interface DiscoveredProduct {
  /** The normalized product that was (or would be) persisted, when normalization succeeded. */
  product?: Product;
  /** TikTok-specific raw payload stored on `product_sources.raw`. */
  raw: Record<string, unknown>;
  /** Typed repository outcome for this product. */
  persisted: RepositoryResult<PersistedProduct>;
}

/** Typed result of a discovery run. Never throws for per-product failures. */
export interface DiscoveryResult {
  platform: DiscoveryPlatform;
  query?: string;
  category?: string;
  region?: string;
  /** Number of products the caller asked for (capped). */
  requested: number;
  /** Number of unique products discovered (before the limit). */
  discovered: number;
  /** Number of products successfully persisted (created + updated). */
  persisted: number;
  /** Number of products inserted for the first time. */
  created: number;
  /** Number of existing products refreshed. */
  updated: number;
  /** Number of products that could not be normalized or persisted. */
  failed: number;
  /** Detailed per-product outcomes, in discovery order, up to `limit`. */
  products: DiscoveredProduct[];
}

/** Contract every discovery module must implement. */
export interface DiscoveryModule {
  readonly platform: DiscoveryPlatform;
  discover(query: DiscoveryQuery, env: Env, ctx: ExecutionContext): Promise<DiscoveryResult>;
}
