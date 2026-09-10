import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { MarketError } from "../../src/market/types";
import {
  INSTAGRAM_OAUTH_CALLBACK_PATH,
  buildInstagramAuthorizeUrl,
  buildOAuthCallbackUrl,
  createOAuthState,
  exchangeInstagramAuthorizationCode,
  hasInstagramOAuthCredentials,
  isInstagramOAuthHost,
  isValidCallbackState,
  parseInstagramOAuthCallbackParams,
  parseLongLivedTokenPayload,
  parseShortLivedTokenPayload,
  quoteJsonIntegerField,
  timingSafeEqual,
  verifyOAuthState,
} from "../../src/market/instagram-oauth";

const APP_ID = "test-app-id";
const APP_SECRET = "test-app-secret";
const AUTH_CODE = "test-auth-code";
const SHORT_TOKEN = "short-lived-token";
const LONG_TOKEN = "long-lived-token";
const USER_ID = "17841400000000000";
const LARGE_USER_ID = "28689534960681881";
const REDIRECT_URI = "https://aliexpress-scraper-cloudflare.auto-step8n.workers.dev/api/market/instagram/oauth/callback";

function oauthEnv(overrides: Partial<Env> = {}): Env {
  return {
    INSTAGRAM_APP_ID: APP_ID,
    INSTAGRAM_APP_SECRET: APP_SECRET,
    ...overrides,
  } as Env;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("isInstagramOAuthHost", () => {
  it("accepts api.instagram.com and graph.instagram.com only", () => {
    expect(isInstagramOAuthHost("api.instagram.com")).toBe(true);
    expect(isInstagramOAuthHost("graph.instagram.com")).toBe(true);
    expect(isInstagramOAuthHost("GRAPH.INSTAGRAM.COM")).toBe(true);
    expect(isInstagramOAuthHost("graph.facebook.com")).toBe(false);
    expect(isInstagramOAuthHost("www.instagram.com")).toBe(false);
    expect(isInstagramOAuthHost("api.instagram.com.evil.com")).toBe(false);
  });
});

describe("buildOAuthCallbackUrl", () => {
  it("is origin plus /api/market/instagram/oauth/callback", () => {
    expect(buildOAuthCallbackUrl("https://aliexpress-scraper-cloudflare.auto-step8n.workers.dev/anything")).toBe(
      REDIRECT_URI,
    );
    expect(INSTAGRAM_OAUTH_CALLBACK_PATH).toBe("/api/market/instagram/oauth/callback");
  });
});

describe("buildInstagramAuthorizeUrl", () => {
  it("builds the Instagram Business Login authorize URL", () => {
    const url = buildInstagramAuthorizeUrl({
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      state: "abc123",
    });
    expect(url.hostname).toBe("www.instagram.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("instagram_business_basic");
    expect(url.searchParams.get("state")).toBe("abc123");
  });
});

describe("parseInstagramOAuthCallbackParams", () => {
  it("reads code and state", () => {
    const url = new URL("https://worker.example/api/market/instagram/oauth/callback?code=thecode&state=s1");
    expect(parseInstagramOAuthCallbackParams(url)).toEqual({
      code: "thecode",
      state: "s1",
      error: undefined,
      errorReason: undefined,
      errorDescription: undefined,
    });
  });

  it("reads Meta error fields", () => {
    const url = new URL(
      "https://worker.example/api/market/instagram/oauth/callback?error=access_denied&error_reason=user_denied&error_description=Permissions+error",
    );
    expect(parseInstagramOAuthCallbackParams(url)).toMatchObject({
      error: "access_denied",
      errorReason: "user_denied",
      errorDescription: "Permissions error",
    });
  });
});

describe("parseShortLivedTokenPayload / parseLongLivedTokenPayload", () => {
  it("maps a short-lived token object", () => {
    expect(parseShortLivedTokenPayload({ access_token: SHORT_TOKEN, user_id: USER_ID })).toEqual({
      accessToken: SHORT_TOKEN,
      userId: USER_ID,
    });
  });

  it("maps a data-array short-lived token", () => {
    expect(
      parseShortLivedTokenPayload({ data: [{ access_token: SHORT_TOKEN, user_id: 12345 }] }),
    ).toEqual({ accessToken: SHORT_TOKEN, userId: "12345" });
  });

  it("preserves a 17-digit Instagram user_id exactly as a string", () => {
    expect(parseShortLivedTokenPayload({ access_token: SHORT_TOKEN, user_id: LARGE_USER_ID })).toEqual({
      accessToken: SHORT_TOKEN,
      userId: LARGE_USER_ID,
    });
    expect(parseShortLivedTokenPayload({ access_token: SHORT_TOKEN, user_id: LARGE_USER_ID }).userId).toBe(
      "28689534960681881",
    );
  });

  it("quotes an unquoted JSON user_id so JSON.parse cannot round it", () => {
    const raw = `{"access_token":"${SHORT_TOKEN}","user_id":28689534960681881}`;
    expect(String(JSON.parse(raw).user_id)).not.toBe(LARGE_USER_ID);
    const quoted = quoteJsonIntegerField(raw, "user_id");
    expect(quoted).toContain('"user_id":"28689534960681881"');
    expect(JSON.parse(quoted).user_id).toBe(LARGE_USER_ID);
    expect(parseShortLivedTokenPayload(JSON.parse(quoted))).toEqual({
      accessToken: SHORT_TOKEN,
      userId: LARGE_USER_ID,
    });
  });

  it("rejects an already-rounded unsafe numeric user_id", () => {
    expect(() =>
      parseShortLivedTokenPayload({ access_token: SHORT_TOKEN, user_id: 28689534960681881 }),
    ).toThrow(MarketError);
  });

  it("rejects a short-lived payload without access_token", () => {
    expect(() => parseShortLivedTokenPayload({ user_id: USER_ID })).toThrow(MarketError);
    try {
      parseShortLivedTokenPayload({ user_id: USER_ID });
    } catch (err) {
      expect((err as MarketError).code).toBe("INVALID_PAYLOAD");
    }
  });

  it("maps a long-lived token object", () => {
    expect(parseLongLivedTokenPayload({ access_token: LONG_TOKEN, token_type: "bearer", expires_in: 5184000 })).toEqual({
      accessToken: LONG_TOKEN,
      tokenType: "bearer",
      expiresIn: 5184000,
    });
  });

  it("rejects a long-lived payload without access_token", () => {
    try {
      parseLongLivedTokenPayload({ token_type: "bearer" });
      throw new Error("expected INVALID_PAYLOAD");
    } catch (err) {
      expect((err as MarketError).code).toBe("INVALID_PAYLOAD");
    }
  });
});

describe("createOAuthState / verifyOAuthState / isValidCallbackState", () => {
  const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

  it("accepts a freshly signed state without a cookie", async () => {
    const state = await createOAuthState(APP_SECRET, NOW);
    expect(state).toMatch(/^[0-9a-f]{32}\.[0-9]+\.[0-9a-f]{64}$/);
    expect(await verifyOAuthState(APP_SECRET, state, NOW)).toBe(true);
    expect(await isValidCallbackState({ secret: APP_SECRET, state, now: NOW })).toBe(true);
  });

  it("accepts a matching cookie as extra binding", async () => {
    const state = await createOAuthState(APP_SECRET, NOW);
    expect(await isValidCallbackState({ secret: APP_SECRET, state, cookieState: state, now: NOW })).toBe(true);
  });

  it("rejects a missing, unsigned, or Meta-dashboard callback with no state", async () => {
    expect(await isValidCallbackState({ secret: APP_SECRET, now: NOW })).toBe(false);
    expect(await isValidCallbackState({ secret: APP_SECRET, state: "", now: NOW })).toBe(false);
    expect(await isValidCallbackState({ secret: APP_SECRET, state: "abc123", now: NOW })).toBe(false);
  });

  it("rejects a tampered or wrong-secret signature", async () => {
    const state = await createOAuthState(APP_SECRET, NOW);
    const [nonce, issuedAt, mac] = state.split(".");
    const flipped = `${nonce}.${issuedAt}.${mac.slice(0, -1)}${mac.endsWith("a") ? "b" : "a"}`;
    expect(await verifyOAuthState(APP_SECRET, flipped, NOW)).toBe(false);
    expect(await verifyOAuthState("other-secret", state, NOW)).toBe(false);
  });

  it("rejects expired state after 10 minutes", async () => {
    const state = await createOAuthState(APP_SECRET, NOW);
    expect(await verifyOAuthState(APP_SECRET, state, NOW + 601_000)).toBe(false);
    expect(await verifyOAuthState(APP_SECRET, state, NOW + 599_000)).toBe(true);
  });

  it("rejects a cookie that does not match the signed query state", async () => {
    const state = await createOAuthState(APP_SECRET, NOW);
    const other = await createOAuthState(APP_SECRET, NOW);
    expect(await isValidCallbackState({ secret: APP_SECRET, state, cookieState: other, now: NOW })).toBe(false);
  });
});

describe("timingSafeEqual / hasInstagramOAuthCredentials", () => {
  it("compares equal strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("ab", "abc")).toBe(false);
  });

  it("is false without both app credentials", () => {
    expect(hasInstagramOAuthCredentials({} as Env)).toBe(false);
    expect(hasInstagramOAuthCredentials({ INSTAGRAM_APP_ID: APP_ID } as Env)).toBe(false);
    expect(hasInstagramOAuthCredentials(oauthEnv())).toBe(true);
  });
});

describe("exchangeInstagramAuthorizationCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exchanges the code then upgrades to a long-lived token", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL((input as Request).url);
      if (url.hostname === "api.instagram.com" && url.pathname === "/oauth/access_token") {
        expect(init?.method).toBe("POST");
        const body = new URLSearchParams(String(init?.body ?? ""));
        expect(body.get("client_id")).toBe(APP_ID);
        expect(body.get("client_secret")).toBe(APP_SECRET);
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
        expect(body.get("code")).toBe(AUTH_CODE);
        return jsonResponse({ access_token: SHORT_TOKEN, user_id: USER_ID });
      }
      if (url.hostname === "graph.instagram.com" && url.pathname === "/access_token") {
        expect(url.searchParams.get("grant_type")).toBe("ig_exchange_token");
        expect(url.searchParams.get("client_secret")).toBe(APP_SECRET);
        expect(url.searchParams.get("access_token")).toBe(SHORT_TOKEN);
        return jsonResponse({ access_token: LONG_TOKEN, token_type: "bearer", expires_in: 5184000 });
      }
      throw new Error(`unexpected host ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const token = await exchangeInstagramAuthorizationCode(oauthEnv(), AUTH_CODE, REDIRECT_URI);
    expect(token).toEqual({
      accessToken: LONG_TOKEN,
      userId: USER_ID,
      tokenType: "bearer",
      expiresIn: 5184000,
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("preserves an unquoted 17-digit user_id from the token endpoint", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL((input as Request).url);
      if (url.hostname === "api.instagram.com" && url.pathname === "/oauth/access_token") {
        return new Response(`{"access_token":"${SHORT_TOKEN}","user_id":28689534960681881}`, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.hostname === "graph.instagram.com" && url.pathname === "/access_token") {
        return jsonResponse({ access_token: LONG_TOKEN, token_type: "bearer", expires_in: 5184000 });
      }
      throw new Error(`unexpected host ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchStub);

    const token = await exchangeInstagramAuthorizationCode(oauthEnv(), AUTH_CODE, REDIRECT_URI);
    expect(token.userId).toBe(LARGE_USER_ID);
    expect(token.userId).toBe("28689534960681881");
  });

  it("throws INSTAGRAM_OAUTH_NOT_CONFIGURED when app credentials are missing", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    try {
      await exchangeInstagramAuthorizationCode({} as Env, AUTH_CODE, REDIRECT_URI);
      throw new Error("expected INSTAGRAM_OAUTH_NOT_CONFIGURED");
    } catch (err) {
      expect((err as MarketError).code).toBe("INSTAGRAM_OAUTH_NOT_CONFIGURED");
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("throws MISSING_CODE when the code is blank", async () => {
    try {
      await exchangeInstagramAuthorizationCode(oauthEnv(), "  ", REDIRECT_URI);
      throw new Error("expected MISSING_CODE");
    } catch (err) {
      expect((err as MarketError).code).toBe("MISSING_CODE");
    }
  });

  it("maps a Meta invalid-code payload to INVALID_CODE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error_type: "OAuthException", code: 400, error_message: "Matching code was not found or was already used" },
          400,
        ),
      ),
    );
    try {
      await exchangeInstagramAuthorizationCode(oauthEnv(), AUTH_CODE, REDIRECT_URI);
      throw new Error("expected INVALID_CODE");
    } catch (err) {
      expect((err as MarketError).code).toBe("INVALID_CODE");
      expect((err as Error).message).not.toContain(AUTH_CODE);
      expect((err as Error).message).not.toContain(APP_SECRET);
    }
  });

  it("maps a Meta OAuthException to AUTH_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { message: "Invalid client secret", type: "OAuthException", code: 190 } }, 400),
      ),
    );
    try {
      await exchangeInstagramAuthorizationCode(oauthEnv(), AUTH_CODE, REDIRECT_URI);
      throw new Error("expected AUTH_ERROR");
    } catch (err) {
      expect((err as MarketError).code).toBe("AUTH_ERROR");
      expect((err as Error).message).not.toContain(APP_SECRET);
    }
  });

  it("maps a network failure to HTTP_ERROR without leaking the code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    try {
      await exchangeInstagramAuthorizationCode(oauthEnv(), AUTH_CODE, REDIRECT_URI);
      throw new Error("expected HTTP_ERROR");
    } catch (err) {
      expect((err as MarketError).code).toBe("HTTP_ERROR");
      expect((err as Error).message).not.toContain(AUTH_CODE);
    }
  });

  it("maps malformed token JSON to INVALID_PAYLOAD", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>nope</html>", { status: 200 })));
    try {
      await exchangeInstagramAuthorizationCode(oauthEnv(), AUTH_CODE, REDIRECT_URI);
      throw new Error("expected INVALID_PAYLOAD");
    } catch (err) {
      expect((err as MarketError).code).toBe("INVALID_PAYLOAD");
    }
  });
});
