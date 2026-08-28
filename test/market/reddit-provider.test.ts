import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../../src/env";
import { normalizeRedditQuery } from "../../src/market/reddit-engine";
import {
  acquireAccessToken,
  buildSearchUrl,
  getRedditProvider,
  isRedditHost,
  officialApiRedditProvider,
  redditModule,
} from "../../src/market/reddit";
import { MarketError } from "../../src/market/types";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SEARCH_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "reddit-search.json"), "utf8"),
) as Record<string, unknown>;

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const TOKEN = "test-access-token";

function mockCtx(): ExecutionContext {
  return {
    waitUntil: (promise) => {
      void promise;
    },
    passThroughOnException: () => undefined,
  } as ExecutionContext;
}

const ctx = mockCtx();

const NORMALIZED = normalizeRedditQuery({ keyword: "smart watch" });

/** Minimal in-memory KVNamespace substitute for SCRAPE_CACHE. */
class MemoryKV {
  private readonly store = new Map<string, { value: string; ttl?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    return entry ? entry.value : null;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, ttl: opts?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface RedditRouterOptions {
  token?: Response;
  search?: Response;
  tokenHandler?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
  searchHandler?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
}

function redditRouter(server: MockPostgrest, opts: RedditRouterOptions = {}): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
    if (url.hostname === "www.reddit.com" && url.pathname === "/api/v1/access_token") {
      if (opts.tokenHandler) return Promise.resolve(opts.tokenHandler(url, init));
      if (opts.token) return Promise.resolve(opts.token);
      return Promise.resolve(
        jsonResponse({ access_token: TOKEN, token_type: "bearer", expires_in: 3600 }),
      );
    }
    if (url.hostname === "oauth.reddit.com" && url.pathname === "/search") {
      if (opts.searchHandler) return Promise.resolve(opts.searchHandler(url, init));
      if (opts.search) return Promise.resolve(opts.search);
      return Promise.resolve(jsonResponse(SEARCH_FIXTURE));
    }
    return server.fetch(input, init);
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: SECRET_KEY,
    REDDIT_CLIENT_ID: CLIENT_ID,
    REDDIT_CLIENT_SECRET: CLIENT_SECRET,
    ...overrides,
  } as Env;
}

describe("isRedditHost", () => {
  it("accepts www.reddit.com and oauth.reddit.com, case-insensitively", () => {
    expect(isRedditHost("www.reddit.com")).toBe(true);
    expect(isRedditHost("OAuth.Reddit.com")).toBe(true);
    expect(isRedditHost("oauth.reddit.com")).toBe(true);
    expect(isRedditHost("reddit.com")).toBe(false);
    expect(isRedditHost("api.reddit.com")).toBe(false);
    expect(isRedditHost("oauth.reddit.com.evil.com")).toBe(false);
    expect(isRedditHost("example.com")).toBe(false);
  });
});

describe("getRedditProvider", () => {
  it("resolves the official-api provider", () => {
    expect(getRedditProvider().name).toBe("official-api");
  });
});

describe("buildSearchUrl", () => {
  it("builds the oauth.reddit.com search URL with all normalized parameters", () => {
    const url = buildSearchUrl(NORMALIZED);
    expect(url.hostname).toBe("oauth.reddit.com");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("smart watch");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("sort")).toBe("relevance");
    expect(url.searchParams.get("t")).toBe("all");
    expect(url.searchParams.get("raw_json")).toBe("1");
  });

  it("propagates limit, sort and timeFilter", () => {
    const query = normalizeRedditQuery({ keyword: "phone", limit: 10, sort: "top", timeFilter: "week" });
    const url = buildSearchUrl(query);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("sort")).toBe("top");
    expect(url.searchParams.get("t")).toBe("week");
  });
});

describe("acquireAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws REDDIT_NOT_CONFIGURED when credentials are missing", async () => {
    const server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);

    await expect(acquireAccessToken({} as Env)).rejects.toMatchObject({ code: "REDDIT_NOT_CONFIGURED" });
    expect(server.requests).toHaveLength(0);
  });

  it("exchanges client credentials for a bearer token", async () => {
    const server = createMockPostgrest();
    let basicHeader: string | undefined;
    let userAgent: string | undefined;
    let requestBody: string | undefined;
    vi.stubGlobal(
      "fetch",
      redditRouter(server, {
        tokenHandler: (_url, init) => {
          const headers = init?.headers as Record<string, string> | Headers | undefined;
          basicHeader = headers instanceof Headers ? headers.get("authorization") ?? undefined : headers?.authorization;
          userAgent = headers instanceof Headers ? headers.get("user-agent") ?? undefined : headers?.["user-agent"];
          requestBody = init?.body as string | undefined;
          return jsonResponse({ access_token: TOKEN, token_type: "bearer", expires_in: 3600 });
        },
      }),
    );

    const token = await acquireAccessToken(configuredEnv());

    expect(token).toBe(TOKEN);
    expect(basicHeader).toBe(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
    expect(requestBody).toBe("grant_type=client_credentials");
    expect(userAgent).toBeTruthy();
  });

  it("uses REDDIT_USER_AGENT when provided", async () => {
    const server = createMockPostgrest();
    let userAgent: string | undefined;
    vi.stubGlobal(
      "fetch",
      redditRouter(server, {
        tokenHandler: (_url, init) => {
          const headers = init?.headers as Record<string, string> | Headers | undefined;
          userAgent = headers instanceof Headers ? headers.get("user-agent") ?? undefined : headers?.["user-agent"];
          return jsonResponse({ access_token: TOKEN });
        },
      }),
    );

    await acquireAccessToken(configuredEnv({ REDDIT_USER_AGENT: "custom/1.0 (test)" }));
    expect(userAgent).toBe("custom/1.0 (test)");
  });

  it("maps 401 to AUTH_ERROR", async () => {
    const server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server, { token: new Response("unauthorized", { status: 401 }) }));

    await expect(acquireAccessToken(configuredEnv())).rejects.toMatchObject({ code: "AUTH_ERROR" });
  });

  it("maps 429 to RATE_LIMITED", async () => {
    const server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server, { token: new Response("slow down", { status: 429 }) }));

    await expect(acquireAccessToken(configuredEnv())).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("rejects a token response without access_token with INVALID_PAYLOAD", async () => {
    const server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server, { token: jsonResponse({ error: "invalid_grant" }) }));

    await expect(acquireAccessToken(configuredEnv())).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });
});

describe("officialApiRedditProvider.fetchSignals", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("bootstraps a token and returns a parsed aggregate signal", async () => {
    server = createMockPostgrest();
    const seen: Array<{ method: string; path: string; authorization?: string }> = [];
    vi.stubGlobal(
      "fetch",
      redditRouter(server, {
        tokenHandler: (_url, init) => {
          const headers = init?.headers as Record<string, string> | Headers | undefined;
          seen.push({
            method: "POST",
            path: "/api/v1/access_token",
            authorization: headers instanceof Headers ? headers.get("authorization") ?? undefined : headers?.authorization,
          });
          return jsonResponse({ access_token: TOKEN, token_type: "bearer", expires_in: 3600 });
        },
        searchHandler: (url, init) => {
          const headers = init?.headers as Record<string, string> | Headers | undefined;
          seen.push({
            method: "GET",
            path: url.pathname,
            authorization: headers instanceof Headers ? headers.get("authorization") ?? undefined : headers?.authorization,
          });
          expect(url.searchParams.get("q")).toBe("smart watch");
          return jsonResponse(SEARCH_FIXTURE);
        },
      }),
    );

    const signals = await officialApiRedditProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx);

    expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "POST /api/v1/access_token",
      "GET /search",
    ]);
    expect(seen[0].authorization).toBe(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
    expect(seen[1].authorization).toBe(`bearer ${TOKEN}`);
    expect(signals).toHaveLength(1);
    expect(signals[0].keyword).toBe("smart watch");
    expect(signals[0].mentions).toBe(4);
    expect(signals[0].capturedAt).toBeTruthy();
  });

  it("throws REDDIT_NOT_CONFIGURED before any network call when credentials are missing", async () => {
    server = createMockPostgrest();
    const fetchMock = vi.fn(redditRouter(server));
    vi.stubGlobal("fetch", fetchMock);

    await expect(officialApiRedditProvider.fetchSignals(NORMALIZED, {} as Env, ctx)).rejects.toMatchObject({
      code: "REDDIT_NOT_CONFIGURED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a 401 on the search call to AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server, { search: new Response("unauthorized", { status: 401 }) }));

    await expect(officialApiRedditProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("maps a 429 on the search call to RATE_LIMITED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server, { search: new Response("slow down", { status: 429 }) }));

    await expect(officialApiRedditProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("treats a redirect toward the login page as AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      redditRouter(server, { search: redirectResponse("https://www.reddit.com/login?next=/search") }),
    );

    await expect(officialApiRedditProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("rejects redirects that leave reddit.com with REDIRECT_UNTRUSTED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server, { search: redirectResponse("https://evil.example.com/phish") }));

    await expect(officialApiRedditProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "REDIRECT_UNTRUSTED",
    });
  });

  it("rejects redirects without a location header with REDIRECT_NO_LOCATION", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server, { search: new Response(null, { status: 302 }) }));

    await expect(officialApiRedditProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "REDIRECT_NO_LOCATION",
    });
  });

  it("rejects redirect loops with TOO_MANY_REDIRECTS", async () => {
    server = createMockPostgrest();
    let hops = 0;
    const handler = (): Response => redirectResponse(`https://oauth.reddit.com/search?hop=${++hops}`);
    vi.stubGlobal("fetch", redditRouter(server, { searchHandler: handler }));

    await expect(officialApiRedditProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "TOO_MANY_REDIRECTS",
    });
  });

  it("maps fetch timeouts to TIMEOUT", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    );

    await expect(officialApiRedditProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("maps network failures to HTTP_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    await expect(officialApiRedditProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "HTTP_ERROR",
    });
  });

  it("rejects malformed search JSON with INVALID_PAYLOAD", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server, { search: new Response("this is not json", { status: 200 }) }));

    await expect(officialApiRedditProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
  });

  it("rejects oversized responses with RESPONSE_TOO_LARGE", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      redditRouter(server, {
        search: new Response("x", { status: 200, headers: { "content-length": "900000" } }),
      }),
    );

    await expect(officialApiRedditProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("serves cached signals without re-fetching when SCRAPE_CACHE is present", async () => {
    server = createMockPostgrest();
    let searchCalls = 0;
    vi.stubGlobal(
      "fetch",
      redditRouter(server, {
        searchHandler: () => {
          searchCalls += 1;
          return jsonResponse(SEARCH_FIXTURE);
        },
      }),
    );
    const kv = new MemoryKV();
    const env = configuredEnv({ SCRAPE_CACHE: kv as unknown as KVNamespace });

    const first = await officialApiRedditProvider.fetchSignals(NORMALIZED, env, ctx);
    const second = await officialApiRedditProvider.fetchSignals(NORMALIZED, env, ctx);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(searchCalls).toBe(1);
  });
});

describe("redditModule.collect", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("collects, persists and reports the market collect result", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server));

    const result = await redditModule.collect({ keyword: "smart watch" }, configuredEnv(), ctx);

    expect(result.source).toBe("reddit");
    expect(result.provider).toBe("official-api");
    expect(result.keyword).toBe("smart watch");
    expect(result.geo).toBe("WORLD");
    expect(result.timeRange).toBe("all");
    expect(result.property).toBe("posts");
    expect(result.category).toBeNull();
    expect(result.requested).toBe(1);
    expect(result.persisted).toBe(1);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.signals).toHaveLength(1);

    const source = server.store.sources.find((row) => row.slug === "reddit");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("api");
    expect(server.store.reddit_signals).toHaveLength(1);
    expect(server.store.reddit_signals[0].source_id).toBe(source?.id);
  });

  it("returns SUPABASE_NOT_CONFIGURED when Supabase is missing", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server));

    await expect(redditModule.collect({ keyword: "phone" }, { REDDIT_CLIENT_ID: CLIENT_ID, REDDIT_CLIENT_SECRET: CLIENT_SECRET } as Env, ctx)).rejects.toMatchObject({
      code: "SUPABASE_NOT_CONFIGURED",
    });
  });

  it("propagates provider errors as typed MarketError", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server, { search: new Response("slow down", { status: 429 }) }));

    const error = await redditModule.collect({ keyword: "phone" }, configuredEnv(), ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    expect((error as MarketError).code).toBe("RATE_LIMITED");
  });

  it("propagates missing-credential errors as REDDIT_NOT_CONFIGURED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server));

    const error = await redditModule.collect({ keyword: "phone" }, configuredEnv({ REDDIT_CLIENT_ID: undefined, REDDIT_CLIENT_SECRET: undefined }), ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    expect((error as MarketError).code).toBe("REDDIT_NOT_CONFIGURED");
  });

  it("propagates validation errors from the query", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", redditRouter(server));

    const error = await redditModule.collect({ sort: "rising" }, configuredEnv(), ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    expect((error as MarketError).code).toBe("INVALID_KEYWORD");
  });
});
