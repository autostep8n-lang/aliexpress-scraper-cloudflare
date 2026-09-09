import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { INSTAGRAM_ME_SMOKE_PATH } from "../../src/api/instagram-me";
import { routeRequest } from "../../src/router";

const ACCESS_TOKEN = "ig-live-smoke-token-do-not-leak";
const USER_ID = "28689534960681880";
const USERNAME = "sherif_378";
const WORKER_ORIGIN = "https://aliexpress-scraper-cloudflare.auto-step8n.workers.dev";

function mockCtx(): ExecutionContext {
  return {
    waitUntil: (promise) => {
      void promise;
    },
    passThroughOnException: () => undefined,
  } as ExecutionContext;
}

const ctx = mockCtx();

function envWithToken(overrides: Partial<Env> = {}): Env {
  return {
    INSTAGRAM_ACCESS_TOKEN: ACCESS_TOKEN,
    INSTAGRAM_IG_USER_ID: USER_ID,
    ...overrides,
  } as Env;
}

async function get(path: string, env: Env = envWithToken(), init: RequestInit = {}): Promise<Response> {
  return routeRequest(new Request(`${WORKER_ORIGIN}${path}`, { method: "GET", ...init }), env, ctx);
}

describe("GET /api/tmp/instagram-me", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns sanitized id and username from graph.instagram.com/me", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL((input as Request).url);
      expect(url.hostname).toBe("graph.instagram.com");
      expect(url.pathname).toBe("/me");
      expect(url.searchParams.get("fields")).toBe("id,username");
      expect(url.searchParams.get("access_token")).toBe(ACCESS_TOKEN);
      return new Response(JSON.stringify({ id: USER_ID, username: USERNAME }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchStub);

    const res = await get(INSTAGRAM_ME_SMOKE_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      temporary: true,
      path: INSTAGRAM_ME_SMOKE_PATH,
      graphStatus: 200,
      id: USER_ID,
      username: USERNAME,
    });
    expect(JSON.stringify(body)).not.toContain(ACCESS_TOKEN);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("returns 503 INSTAGRAM_NOT_CONFIGURED without calling Graph when the token is missing", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    const res = await get(INSTAGRAM_ME_SMOKE_PATH, {} as Env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("INSTAGRAM_NOT_CONFIGURED");
    expect(body.error).not.toContain(ACCESS_TOKEN);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("returns sanitized AUTH_ERROR when Graph rejects the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await get(INSTAGRAM_ME_SMOKE_PATH);
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("AUTH_ERROR");
    expect(body.graphStatus).toBe(400);
    expect(body.temporary).toBe(true);
    expect(JSON.stringify(body)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(body)).not.toContain("Invalid OAuth access token");
  });

  it("does not log the access token", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: USER_ID, username: USERNAME }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await get(INSTAGRAM_ME_SMOKE_PATH);
    const dumped = [...errorSpy.mock.calls, ...logSpy.mock.calls].map((args) => JSON.stringify(args)).join("\n");
    expect(dumped).not.toContain(ACCESS_TOKEN);
  });

  it("rejects non-GET with 405", async () => {
    const res = await routeRequest(
      new Request(`${WORKER_ORIGIN}${INSTAGRAM_ME_SMOKE_PATH}`, { method: "POST" }),
      envWithToken(),
      ctx,
    );
    expect(res.status).toBe(405);
  });
});
