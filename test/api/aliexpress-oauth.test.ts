import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { DS_TOKEN_KV_KEY } from "../../src/scrapers/aliexpress-oauth";
import { routeRequest } from "../../src/router";

const APP_KEY = "test-app-key";
const APP_SECRET = "test-app-secret";
const AUTH_CODE = "test-auth-code";
const ACCESS_TOKEN = "ds-access-token";
const REFRESH_TOKEN = "ds-refresh-token";
const WORKER_ORIGIN = "https://aliexpress-scraper-cloudflare.auto-step8n.workers.dev";
const CALLBACK_PATH = "/api/aliexpress/oauth/callback";
const START_PATH = "/api/aliexpress/oauth";
const REDIRECT_URI = `${WORKER_ORIGIN}${CALLBACK_PATH}`;

class MemoryKV {
  readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function mockCtx(): ExecutionContext {
  return {
    waitUntil: (promise) => {
      void promise;
    },
    passThroughOnException: () => undefined,
  } as ExecutionContext;
}

const ctx = mockCtx();

function oauthEnv(overrides: Partial<Env> = {}): Env {
  return {
    ALIEXPRESS_OPENAPI_KEY: APP_KEY,
    ALIEXPRESS_OPENAPI_SECRET: APP_SECRET,
    SCRAPE_CACHE: new MemoryKV() as unknown as KVNamespace,
    ...overrides,
  } as Env;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function get(path: string, env: Env = oauthEnv(), init: RequestInit = {}): Promise<Response> {
  return routeRequest(new Request(`${WORKER_ORIGIN}${path}`, { method: "GET", ...init }), env, ctx);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/aliexpress/oauth", () => {
  it("redirects to AliExpress authorize with the production callback URL", async () => {
    const res = await get(START_PATH);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    const url = new URL(location);
    expect(url.hostname).toBe("api-sg.aliexpress.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(APP_KEY);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("force_auth")).toBe("true");
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.has("state")).toBe(false);
  });

  it("returns 503 ALIEXPRESS_OAUTH_NOT_CONFIGURED when app credentials are missing", async () => {
    const res = await get(START_PATH, {} as Env);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "ALIEXPRESS_OAUTH_NOT_CONFIGURED" });
  });
});

describe("GET /api/aliexpress/oauth/callback", () => {
  it("exchanges code, persists tokens, and never returns the token", async () => {
    const kv = new MemoryKV();
    const env = oauthEnv({ SCRAPE_CACHE: kv as unknown as KVNamespace });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_in: 36000,
          refresh_expires_in: 2592000,
          user_id: "99",
        }),
      ),
    );

    const res = await get(`${CALLBACK_PATH}?code=${AUTH_CODE}`, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.provider).toBe("aliexpress-dropshipping");
    expect(body.userId).toBe("99");
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(body)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(body)).not.toContain(AUTH_CODE);
    expect(kv.store.has(DS_TOKEN_KV_KEY)).toBe(true);
    expect(kv.store.get(DS_TOKEN_KV_KEY)).toContain(ACCESS_TOKEN);
  });

  it("returns 400 MISSING_CODE without code", async () => {
    const res = await get(CALLBACK_PATH);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "MISSING_CODE" });
  });

  it("returns 403 OAUTH_DENIED on access_denied", async () => {
    const res = await get(`${CALLBACK_PATH}?error=access_denied`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "OAUTH_DENIED" });
  });

  it("returns 503 TOKEN_STORE_UNAVAILABLE without SCRAPE_CACHE", async () => {
    const env = {
      ALIEXPRESS_OPENAPI_KEY: APP_KEY,
      ALIEXPRESS_OPENAPI_SECRET: APP_SECRET,
    } as Env;
    const res = await get(`${CALLBACK_PATH}?code=${AUTH_CODE}`, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "TOKEN_STORE_UNAVAILABLE" });
  });
});
