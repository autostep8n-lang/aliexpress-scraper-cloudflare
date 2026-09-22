import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import {
  ALIEXPRESS_OAUTH_CALLBACK_PATH,
  DS_TOKEN_KV_KEY,
  buildAliExpressAuthorizeUrl,
  buildAliExpressOAuthCallbackUrl,
  exchangeAliExpressAuthorizationCode,
  loadPersistedAliExpressToken,
  parseAliExpressOAuthCallbackParams,
  parseTokenCreatePayload,
  persistAliExpressToken,
  refreshAliExpressToken,
  resolveAliExpressAccessToken,
} from "../../src/scrapers/aliexpress-oauth";
import { DS_TOKEN_CREATE_PATH, DS_TOKEN_REFRESH_PATH, dsHmacSign } from "../../src/scrapers/aliexpress-sign";
import { ScraperError } from "../../src/scrapers/types";

const APP_KEY = "test-app-key";
const APP_SECRET = "test-app-secret";
const AUTH_CODE = "test-auth-code";
const ACCESS_TOKEN = "ds-access-token";
const REFRESH_TOKEN = "ds-refresh-token";
const NEW_ACCESS = "ds-access-token-2";
const NEW_REFRESH = "ds-refresh-token-2";
const REDIRECT_URI = "https://aliexpress-scraper-cloudflare.auto-step8n.workers.dev/api/aliexpress/oauth/callback";

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

function oauthEnv(kv?: MemoryKV): Env {
  return {
    ALIEXPRESS_OPENAPI_KEY: APP_KEY,
    ALIEXPRESS_OPENAPI_SECRET: APP_SECRET,
    ...(kv ? { SCRAPE_CACHE: kv as unknown as KVNamespace } : {}),
  } as Env;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildAliExpressOAuthCallbackUrl / authorize URL", () => {
  it("is origin plus /api/aliexpress/oauth/callback", () => {
    expect(buildAliExpressOAuthCallbackUrl("https://aliexpress-scraper-cloudflare.auto-step8n.workers.dev/anything")).toBe(
      REDIRECT_URI,
    );
    expect(ALIEXPRESS_OAUTH_CALLBACK_PATH).toBe("/api/aliexpress/oauth/callback");
  });

  it("builds authorize URL without inventing scope or state", () => {
    const url = buildAliExpressAuthorizeUrl({ appKey: APP_KEY, redirectUri: REDIRECT_URI });
    expect(url.hostname).toBe("api-sg.aliexpress.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("force_auth")).toBe("true");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("client_id")).toBe(APP_KEY);
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.has("state")).toBe(false);
  });
});

describe("parseAliExpressOAuthCallbackParams", () => {
  it("reads code", () => {
    const url = new URL("https://worker.example/api/aliexpress/oauth/callback?code=thecode");
    expect(parseAliExpressOAuthCallbackParams(url)).toEqual({
      code: "thecode",
      error: undefined,
      errorDescription: undefined,
    });
  });

  it("reads error fields", () => {
    const url = new URL(
      "https://worker.example/api/aliexpress/oauth/callback?error=access_denied&error_description=user+denied",
    );
    expect(parseAliExpressOAuthCallbackParams(url)).toMatchObject({
      error: "access_denied",
      errorDescription: "user denied",
    });
  });
});

describe("parseTokenCreatePayload", () => {
  it("maps access_token, refresh_token, and TTLs", () => {
    const now = Date.UTC(2026, 8, 20, 0, 0, 0);
    const token = parseTokenCreatePayload(
      {
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 36000,
        refresh_expires_in: 2592000,
        user_id: "123456",
        seller_id: "789",
      },
      now,
    );
    expect(token.accessToken).toBe(ACCESS_TOKEN);
    expect(token.refreshToken).toBe(REFRESH_TOKEN);
    expect(token.expiresAt).toBe(now + 36000 * 1000);
    expect(token.refreshExpiresAt).toBe(now + 2592000 * 1000);
    expect(token.userId).toBe("123456");
    expect(token.sellerId).toBe("789");
  });

  it("throws INVALID_PAYLOAD when tokens are missing", () => {
    try {
      parseTokenCreatePayload({ expires_in: 10 });
      throw new Error("expected INVALID_PAYLOAD");
    } catch (err) {
      expect((err as ScraperError).code).toBe("INVALID_PAYLOAD");
    }
  });
});

describe("token persistence", () => {
  it("round-trips tokens through SCRAPE_CACHE without exposing them in errors", async () => {
    const kv = new MemoryKV();
    const env = oauthEnv(kv);
    await persistAliExpressToken(env, {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: 1_800_000_000_000,
      refreshExpiresAt: 1_900_000_000_000,
      userId: "1",
    });
    const loaded = await loadPersistedAliExpressToken(env);
    expect(loaded?.accessToken).toBe(ACCESS_TOKEN);
    expect(loaded?.refreshToken).toBe(REFRESH_TOKEN);
    expect(kv.store.has(DS_TOKEN_KV_KEY)).toBe(true);
    expect(JSON.stringify(loaded)).toContain(ACCESS_TOKEN);
  });

  it("throws TOKEN_STORE_UNAVAILABLE when KV is unbound", async () => {
    try {
      await persistAliExpressToken(oauthEnv(), {
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresAt: Date.now() + 1000,
        refreshExpiresAt: null,
      });
      throw new Error("expected TOKEN_STORE_UNAVAILABLE");
    } catch (err) {
      expect((err as ScraperError).code).toBe("TOKEN_STORE_UNAVAILABLE");
    }
  });
});

describe("exchangeAliExpressAuthorizationCode", () => {
  it("posts HMAC-SHA256 signed system params with api_path and code", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      expect(href).toBe("https://api-sg.aliexpress.com/rest/auth/token/create");
      const params = new URLSearchParams(String(init?.body ?? ""));
      expect(params.get("code")).toBe(AUTH_CODE);
      expect(params.get("app_key")).toBe(APP_KEY);
      expect(params.get("sign_method")).toBe("sha256");
      const unsigned = Object.fromEntries([...params.entries()].filter(([key]) => key !== "sign"));
      expect(params.get("sign")).toBe(await dsHmacSign(APP_SECRET, unsigned, DS_TOKEN_CREATE_PATH));
      return jsonResponse({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 36000,
        refresh_expires_in: 2592000,
        user_id: "42",
      });
    });
    vi.stubGlobal("fetch", fetchStub);
    const token = await exchangeAliExpressAuthorizationCode(oauthEnv(), AUTH_CODE);
    expect(token.accessToken).toBe(ACCESS_TOKEN);
    expect(token.refreshToken).toBe(REFRESH_TOKEN);
    expect(token.userId).toBe("42");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("maps InvalidCode to INVALID_CODE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error_response: { code: "InvalidCode", msg: "The code is invalid" } })),
    );
    try {
      await exchangeAliExpressAuthorizationCode(oauthEnv(), AUTH_CODE);
      throw new Error("expected INVALID_CODE");
    } catch (err) {
      expect((err as ScraperError).code).toBe("INVALID_CODE");
      expect((err as ScraperError).message).not.toContain(AUTH_CODE);
      expect((err as ScraperError).message).not.toContain(APP_SECRET);
    }
  });
});

describe("refreshAliExpressToken / resolveAliExpressAccessToken", () => {
  it("refreshes when access token is expired and persists the rotated refresh token", async () => {
    const kv = new MemoryKV();
    const env = oauthEnv(kv);
    await persistAliExpressToken(env, {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() + 86400_000,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        expect(href).toBe("https://api-sg.aliexpress.com/rest/auth/token/refresh");
        const params = new URLSearchParams(String(init?.body ?? ""));
        expect(params.get("refresh_token")).toBe(REFRESH_TOKEN);
        const unsigned = Object.fromEntries([...params.entries()].filter(([key]) => key !== "sign"));
        expect(params.get("sign")).toBe(await dsHmacSign(APP_SECRET, unsigned, DS_TOKEN_REFRESH_PATH));
        return jsonResponse({
          access_token: NEW_ACCESS,
          refresh_token: NEW_REFRESH,
          expires_in: 36000,
          refresh_expires_in: 2592000,
        });
      }),
    );

    const resolved = await resolveAliExpressAccessToken(env);
    expect(resolved).toBe(NEW_ACCESS);
    const stored = await loadPersistedAliExpressToken(env);
    expect(stored?.accessToken).toBe(NEW_ACCESS);
    expect(stored?.refreshToken).toBe(NEW_REFRESH);
  });

  it("returns the stored access token when it is still valid", async () => {
    const kv = new MemoryKV();
    const env = oauthEnv(kv);
    await persistAliExpressToken(env, {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Date.now() + 3600_000,
      refreshExpiresAt: Date.now() + 86400_000,
    });
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    expect(await resolveAliExpressAccessToken(env)).toBe(ACCESS_TOKEN);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refreshAliExpressToken posts to /auth/token/refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          access_token: NEW_ACCESS,
          refresh_token: NEW_REFRESH,
          expires_in: 10,
          refresh_expires_in: 20,
        }),
      ),
    );
    const token = await refreshAliExpressToken(oauthEnv(), REFRESH_TOKEN);
    expect(token.accessToken).toBe(NEW_ACCESS);
    expect(token.refreshToken).toBe(NEW_REFRESH);
  });
});
