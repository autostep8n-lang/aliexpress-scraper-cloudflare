import type { Env } from "./env";

/**
 * Health check endpoint. Reports service status and whether optional
 * bindings are configured (without ever exposing their values).
 */
export function handleHealth(env: Env): Response {
  return Response.json({
    status: "ok",
    service: "product-intelligence-platform",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    config: {
      supabaseConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
      cacheConfigured: Boolean(env.SCRAPE_CACHE),
      assetsConfigured: Boolean(env.SCRAPE_ASSETS),
    },
  });
}
