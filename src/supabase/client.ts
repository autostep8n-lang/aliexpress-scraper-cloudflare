import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";

const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Lazily builds a Supabase client from the configured bindings.
 * Returns null when credentials are missing so callers can degrade
 * gracefully (see /health). Credentials are never hardcoded.
 */
export function getSupabaseClient(env: Env): SupabaseClient | null {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    return null;
  }
  return createClient(url, key);
}

export interface SupabaseConnectionCheck {
  configured: boolean;
  connected: boolean;
  status: number | null;
  detail: string;
}

/**
 * Verifies the Worker can reach Supabase with the configured credentials.
 *
 * Performs a lightweight authenticated probe against the PostgREST root
 * endpoint: a 2xx response means the project is reachable and the secret
 * key is accepted. Only safe, non-secret values are returned - credentials
 * are never logged or echoed back.
 */
export async function checkSupabaseConnection(env: Env): Promise<SupabaseConnectionCheck> {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    return {
      configured: false,
      connected: false,
      status: null,
      detail: "supabase not configured",
    };
  }

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    return {
      configured: true,
      connected: res.ok,
      status: res.status,
      detail: res.ok ? "supabase reachable" : "supabase rejected request",
    };
  } catch {
    return {
      configured: true,
      connected: false,
      status: null,
      detail: "supabase request failed",
    };
  }
}
