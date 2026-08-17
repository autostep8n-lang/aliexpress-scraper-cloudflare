import { checkSupabaseConnection } from "./supabase/client";
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
      supabaseConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY),
      cacheConfigured: Boolean(env.SCRAPE_CACHE),
      assetsConfigured: Boolean(env.SCRAPE_ASSETS),
    },
  });
}

/**
 * Live Supabase connectivity check. Performs a real round-trip against
 * Supabase and reports only safe status fields - credentials are never
 * returned or echoed in the response.
 */
export async function handleSupabaseHealth(env: Env): Promise<Response> {
  const check = await checkSupabaseConnection(env);
  return Response.json({
    status: check.connected ? "ok" : "degraded",
    service: "product-intelligence-platform",
    timestamp: new Date().toISOString(),
    supabase: check,
  });
}
