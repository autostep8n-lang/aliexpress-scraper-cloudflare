import type { Env } from "../env";

/**
 * Platforms that will be supported by scraper modules. Concrete modules
 * (TikTok Shop, Amazon) are implemented under `src/scrapers/`; the rest
 * (AliExpress, YouTube, Instagram, etc.) still need to implement the contract
 * below.
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

/**
 * Error thrown by a scraper module when the source could not be scraped or
 * parsed. Carries a stable machine-readable `code` so callers can branch on
 * the failure without parsing message text.
 */
export class ScraperError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScraperError";
  }
}
