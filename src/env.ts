/**
 * Bindings available to the Worker at runtime.
 *
 * Values are provided by Wrangler (`[vars]`), the Cloudflare Dashboard, or
 * `wrangler secret put`. All fields are optional so the Worker deploys and
 * runs without any bindings configured.
 */
export interface Env {
  /** Supabase project URL. Set via Dashboard / `[vars]` / `.dev.vars`. */
  SUPABASE_URL?: string;
  /** Supabase secret (service-role) key. Set as a secret, never committed. */
  SUPABASE_SECRET_KEY?: string;
  /** Optional KV namespace for caching scraped results. */
  SCRAPE_CACHE?: KVNamespace;
  /** Optional R2 bucket for storing raw assets. */
  SCRAPE_ASSETS?: R2Bucket;
  /**
   * Optional Cloudflare Browser Run (Browser Rendering) binding. Used to
   * render pages that answer a challenge when fetched directly from Worker
   * datacenter IPs. Declared in `wrangler.toml` under `[browser]`; optional at
   * runtime so the Worker keeps degrading to a typed error when the binding
   * is absent. Note: AliExpress's anti-bot also punishes Browser Run, so the
   * AliExpress scraper tries the no-browser providers first.
   */
  BROWSER?: BrowserRun;
  /**
   * Optional AliExpress Open Platform (open.aliexpress.com) app credentials.
   * When set, the AliExpress scraper prefers the official `aliexpress.ds.product.get`
   * API - the production-grade, anti-bot-free provider. Set as secrets, never
   * committed. See `src/scrapers/aliexpress-openapi.ts`.
   */
  ALIEXPRESS_OPENAPI_KEY?: string;
  ALIEXPRESS_OPENAPI_SECRET?: string;
  /**
   * Optional Google Trends provider selector (non-secret). Defaults to
   * `"internal-api"` (the Cloudflare-native provider that talks to Google's
   * undocumented internal endpoints). Set to an approved provider name only
   * when such a provider is registered. See `src/market/google-trends.ts`.
   */
  GOOGLE_TRENDS_PROVIDER?: string;
  /**
   * Optional Reddit OAuth2 app-only credentials (www.reddit.com/prefs/apps,
   * "script" type). When set, the Reddit market-intelligence module collects
   * via the official `oauth.reddit.com` API. Without them the provider
   * degrades with a typed `REDDIT_NOT_CONFIGURED` error. Set as secrets,
   * never committed. See `src/market/reddit.ts`.
   */
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  /**
   * Optional descriptive Reddit API user agent (Reddit requires a unique,
   * descriptive `User-Agent`). Defaults to a project-specific string.
   */
  REDDIT_USER_AGENT?: string;
}
