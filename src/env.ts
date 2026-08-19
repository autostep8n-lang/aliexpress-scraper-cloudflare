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
   * render TikTok Shop product pages that TikTok answers with a challenge
   * page when fetched directly from Worker datacenter IPs. Declared in
   * `wrangler.toml` under `[browser]`; optional at runtime so the Worker
   * keeps degrading to a typed `BLOCKED` error when the binding is absent.
   */
  BROWSER?: BrowserRun;
}
