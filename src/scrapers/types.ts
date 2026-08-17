import type { Env } from "../env";

/**
 * Platforms that will be supported by scraper modules. Concrete modules
 * (AliExpress, TikTok Shop, Amazon, etc.) are intentionally NOT implemented
 * yet - this type is the contract they will implement.
 */
export type ScraperPlatform =
  | "aliexpress"
  | "tiktok-shop"
  | "amazon"
  | "youtube"
  | "instagram"
  | "facebook"
  | "alibaba";

/** Normalized output shape produced by every scraper module. */
export interface ScraperResult {
  platform: ScraperPlatform;
  url: string;
  title?: string;
  scrapedAt: string;
  /** Platform-specific fields (price, ratings, description, ...). */
  data?: Record<string, unknown>;
}

/** Contract every scraper module must implement. */
export interface ScraperModule {
  readonly platform: ScraperPlatform;
  readonly enabled: boolean;
  supports(url: URL): boolean;
  scrape(url: URL, env: Env, ctx: ExecutionContext): Promise<ScraperResult>;
}
