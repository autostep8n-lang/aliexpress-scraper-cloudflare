import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";

/**
 * Lazily builds a Supabase client from the configured bindings.
 * Returns null when credentials are missing so callers can degrade
 * gracefully (see /health). Credentials are never hardcoded.
 */
export function getSupabaseClient(env: Env): SupabaseClient | null {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return null;
  }
  return createClient(url, key);
}
