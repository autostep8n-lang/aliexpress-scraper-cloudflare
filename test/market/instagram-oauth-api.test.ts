import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { routeRequest } from "../../src/router";

const APP_ID = "test-app-id";
const APP_SECRET = "test-app-secret";
const AUTH_CODE = "test-auth-code";
const STATE = "fixed-oauth-state";
const SHORT_TOKEN = "short-lived-token";
const LONG_TOKEN = "long-lived-token";
const USER_ID = "17841400000000000";
const WORKER_ORIGIN = "https://aliexpress-scraper-cloudflare.auto-step8n.workers.dev";
const CALLBACK_PATH = "/api/market/instagram/oauth/callback";
const START_PATH = "/api/market/instagram/oauth";
const REDIRECT_URI = `${WORKER_ORIGIN}${CALLBACK_PATH}`;

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

function oauthFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL((input as Request).url);
    if (url.hostname === "api.instagram.com" && url.pathname === "/oauth/access_token") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.get("code") !== AUTH_CODE) {
        return jsonResponse(
          { error_type: "OAuthException", code: 400, error_message: "Matching code was not found or was already used" },
          400,
        );
      }
      return jsonResponse({ access_token: SHORT_TOKEN, user_id: USER_ID });
    }
    if (url.hostname === "graph.instagram.com" && url.pathname === "/access_token") {
      return jsonResponse({ access_token: LONG_TOKEN, token_type: "bearer", expires_in: 5184000 });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  }) as typeof fetch;
}

async function get(path: string, env: Env = oauthEnv(), init: RequestInit = {}): Promise<Response> {
  return routeRequest(new Request(`${WORKER_ORIGIN}${path}`, { method: "GET", ...init }), env, ctx);
}

describe("GET /api/market/instagram/oauth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("redirects to Instagram authorize with the production callback URL", async () => {
    const res = await get(START_PATH);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    const url = new URL(location);
    expect(url.hostname).toBe("www.instagram.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers.get("set-cookie")).toContain("ig_oauth_state=");
  });

  it("returns 503 INSTAGRAM_OAUTH_NOT_CONFIGURED when app credentials are missing", async () => {
    const res = await get(START_PATH, {} as Env);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "INSTAGRAM_OAUTH_NOT_CONFIGURED" });
  });
});

describe("GET /api/market/instagram/oauth/callback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exchanges a valid code and returns the long-lived token metadata", async () => {
    vi.stubGlobal("fetch", oauthFetch());
    const res = await get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${STATE}`, oauthEnv(), {
      headers: { cookie: `ig_oauth_state=${STATE}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.provider).toBe("instagram-business-login");
    expect(body.path).toBe(CALLBACK_PATH);
    expect(body.userId).toBe(USER_ID);
    expect(body.tokenType).toBe("bearer");
    expect(body.expiresIn).toBe(5184000);
    expect(body.accessToken).toBe(LONG_TOKEN);
  });

  it("returns 400 MISSING_CODE when the code is absent", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    const res = await get(`${CALLBACK_PATH}?state=${STATE}`, oauthEnv(), {
      headers: { cookie: `ig_oauth_state=${STATE}` },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "MISSING_CODE" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("returns 400 INVALID_CODE when Meta rejects the authorization code", async () => {
    vi.stubGlobal("fetch", oauthFetch());
    const res = await get(`${CALLBACK_PATH}?code=already-used&state=${STATE}`, oauthEnv(), {
      headers: { cookie: `ig_oauth_state=${STATE}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("INVALID_CODE");
    expect(body.error).not.toContain("already-used");
  });

  it("returns 403 OAUTH_DENIED on Meta access_denied", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    const res = await get(`${CALLBACK_PATH}?error=access_denied&error_reason=user_denied`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "OAUTH_DENIED" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("returns 502 AUTH_ERROR on other Meta oauth error query params", async () => {
    const res = await get(`${CALLBACK_PATH}?error=server_error`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "AUTH_ERROR" });
  });

  it("returns 502 HTTP_ERROR when the token endpoint is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const res = await get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${STATE}`, oauthEnv(), {
      headers: { cookie: `ig_oauth_state=${STATE}` },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("HTTP_ERROR");
    expect(body.error).not.toContain(AUTH_CODE);
    expect(body.error).not.toContain(APP_SECRET);
  });

  it("returns 400 INVALID_PAYLOAD when Meta returns malformed token JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));
    const res = await get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${STATE}`, oauthEnv(), {
      headers: { cookie: `ig_oauth_state=${STATE}` },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_PAYLOAD" });
  });

  it("returns 503 INSTAGRAM_OAUTH_NOT_CONFIGURED when app credentials are missing", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    const res = await get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${STATE}`, {} as Env, {
      headers: { cookie: `ig_oauth_state=${STATE}` },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "INSTAGRAM_OAUTH_NOT_CONFIGURED" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("returns 400 INVALID_STATE when the state cookie does not match", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    const res = await get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${STATE}`, oauthEnv(), {
      headers: { cookie: "ig_oauth_state=other-state" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_STATE" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("rejects non-GET with 405", async () => {
    const res = await routeRequest(
      new Request(`${WORKER_ORIGIN}${CALLBACK_PATH}`, { method: "POST" }),
      oauthEnv(),
      ctx,
    );
    expect(res.status).toBe(405);
  });

  it("does not log the access token, app secret, or authorization code", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", oauthFetch());
    await get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${STATE}`, oauthEnv(), {
      headers: { cookie: `ig_oauth_state=${STATE}` },
    });
    const dumped = [...errorSpy.mock.calls, ...logSpy.mock.calls].map((args) => JSON.stringify(args)).join("\n");
    expect(dumped).not.toContain(LONG_TOKEN);
    expect(dumped).not.toContain(SHORT_TOKEN);
    expect(dumped).not.toContain(APP_SECRET);
    expect(dumped).not.toContain(AUTH_CODE);
  });
});
