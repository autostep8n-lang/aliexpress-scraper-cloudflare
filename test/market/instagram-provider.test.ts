import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../../src/env";
import { normalizeInstagramQuery } from "../../src/market/instagram-engine";
import {
  buildHashtagSearchUrl,
  buildRecentMediaUrl,
  buildTopMediaUrl,
  getInstagramProvider,
  instagramModule,
  isInstagramHost,
  officialApiInstagramProvider,
} from "../../src/market/instagram";
import { MarketError } from "../../src/market/types";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const HASHTAG_SEARCH_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "instagram-hashtag-search.json"), "utf8"),
) as Record<string, unknown>;

const TOP_MEDIA_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "instagram-top-media.json"), "utf8"),
) as Record<string, unknown>;

const RECENT_MEDIA_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "instagram-recent-media.json"), "utf8"),
) as Record<string, unknown>;

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const ACCESS_TOKEN = "test-instagram-token";
const IG_USER_ID = "iguser";

function mockCtx(): ExecutionContext {
  return {
    waitUntil: (promise) => {
      void promise;
    },
    passThroughOnException: () => undefined,
  } as ExecutionContext;
}

const ctx = mockCtx();

const NORMALIZED = normalizeInstagramQuery({ keyword: "smart watch" });

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

interface InstagramRouterOptions {
  hashtagSearch?: Response;
  topMedia?: Response;
  recentMedia?: Response;
  hashtagSearchHandler?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
  topMediaHandler?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
  recentMediaHandler?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
}

function instagramRouter(server: MockPostgrest, opts: InstagramRouterOptions = {}): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
    if (url.hostname === "graph.facebook.com") {
      if (url.pathname.endsWith("/hashtag_search")) {
        if (opts.hashtagSearchHandler) return Promise.resolve(opts.hashtagSearchHandler(url, init));
        if (opts.hashtagSearch) return Promise.resolve(opts.hashtagSearch);
        return Promise.resolve(jsonResponse(HASHTAG_SEARCH_FIXTURE));
      }
      if (url.pathname.endsWith("/top_media")) {
        if (opts.topMediaHandler) return Promise.resolve(opts.topMediaHandler(url, init));
        if (opts.topMedia) return Promise.resolve(opts.topMedia);
        return Promise.resolve(jsonResponse(TOP_MEDIA_FIXTURE));
      }
      if (url.pathname.endsWith("/recent_media")) {
        if (opts.recentMediaHandler) return Promise.resolve(opts.recentMediaHandler(url, init));
        if (opts.recentMedia) return Promise.resolve(opts.recentMedia);
        return Promise.resolve(jsonResponse(RECENT_MEDIA_FIXTURE));
      }
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

/** A Graph API error payload. */
function graphErrorResponse(code: number, status = 400): Response {
  return jsonResponse(
    {
      error: {
        message: "Graph API error",
        type: "OAuthException",
        code,
        fbtrace_id: "ABC123",
      },
    },
    status,
  );
}

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: SECRET_KEY,
    INSTAGRAM_ACCESS_TOKEN: ACCESS_TOKEN,
    INSTAGRAM_IG_USER_ID: IG_USER_ID,
    ...overrides,
  } as Env;
}

describe("isInstagramHost", () => {
  it("accepts graph.facebook.com, case-insensitively", () => {
    expect(isInstagramHost("graph.facebook.com")).toBe(true);
    expect(isInstagramHost("GRAPH.FACEBOOK.COM")).toBe(true);
    expect(isInstagramHost("graph.facebook.com.evil.com")).toBe(false);
    expect(isInstagramHost("facebook.com")).toBe(false);
    expect(isInstagramHost("www.googleapis.com")).toBe(false);
    expect(isInstagramHost("example.com")).toBe(false);
  });
});

describe("getInstagramProvider", () => {
  it("resolves the official-api provider", () => {
    expect(getInstagramProvider().name).toBe("official-api");
  });
});

describe("buildHashtagSearchUrl", () => {
  it("builds the Graph API hashtag_search URL", () => {
    const url = buildHashtagSearchUrl(IG_USER_ID, "smartwatch", ACCESS_TOKEN);
    expect(url.hostname).toBe("graph.facebook.com");
    expect(url.pathname).toBe("/v26.0/iguser/hashtag_search");
    expect(url.searchParams.get("q")).toBe("smartwatch");
    expect(url.searchParams.get("access_token")).toBe(ACCESS_TOKEN);
  });
});

describe("buildTopMediaUrl", () => {
  it("builds the Graph API top_media URL with the media fields and limit", () => {
    const url = buildTopMediaUrl("17841401234567890", 10, ACCESS_TOKEN);
    expect(url.pathname).toBe("/v26.0/17841401234567890/top_media");
    expect(url.searchParams.get("fields")).toContain("id");
    expect(url.searchParams.get("fields")).toContain("like_count");
    expect(url.searchParams.get("fields")).toContain("media_url");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("access_token")).toBe(ACCESS_TOKEN);
  });
});

describe("buildRecentMediaUrl", () => {
  it("builds the Graph API recent_media URL with the media fields and limit", () => {
    const url = buildRecentMediaUrl("17841401234567890", 25, ACCESS_TOKEN);
    expect(url.pathname).toBe("/v26.0/17841401234567890/recent_media");
    expect(url.searchParams.get("fields")).toContain("timestamp");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("access_token")).toBe(ACCESS_TOKEN);
  });
});

describe("officialApiInstagramProvider.fetchSignals", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches hashtag_search then top_media and recent_media and returns a parsed aggregate signal", async () => {
    server = createMockPostgrest();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      instagramRouter(server, {
        hashtagSearchHandler: (url) => {
          seen.push("hashtag_search");
          expect(url.pathname).toBe("/v26.0/iguser/hashtag_search");
          expect(url.searchParams.get("q")).toBe("smartwatch");
          return jsonResponse(HASHTAG_SEARCH_FIXTURE);
        },
        topMediaHandler: (url) => {
          seen.push("top_media");
          expect(url.pathname).toBe("/v26.0/17841401234567890/top_media");
          return jsonResponse(TOP_MEDIA_FIXTURE);
        },
        recentMediaHandler: (url) => {
          seen.push("recent_media");
          expect(url.pathname).toBe("/v26.0/17841401234567890/recent_media");
          return jsonResponse(RECENT_MEDIA_FIXTURE);
        },
      }),
    );

    const signals = await officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx);

    expect(seen).toEqual(["hashtag_search", "top_media", "recent_media"]);
    expect(signals).toHaveLength(1);
    expect(signals[0].keyword).toBe("smart watch");
    expect(signals[0].hashtag).toBe("smartwatch");
    expect(signals[0].mediaCount).toBe(6);
    expect(signals[0].totalEngagement).toBe(5739);
    expect(signals[0].capturedAt).toBeTruthy();
  });

  it("skips the media calls when the hashtag cannot be resolved", async () => {
    server = createMockPostgrest();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      instagramRouter(server, {
        hashtagSearchHandler: () => {
          seen.push("hashtag_search");
          return jsonResponse({ data: [] });
        },
        topMediaHandler: () => {
          seen.push("top_media");
          return jsonResponse(TOP_MEDIA_FIXTURE);
        },
      }),
    );

    const signals = await officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx);

    expect(seen).toEqual(["hashtag_search"]);
    expect(signals[0].mediaCount).toBe(0);
    expect(signals[0].topMedia).toEqual([]);
  });

  it("throws INSTAGRAM_NOT_CONFIGURED before any network call when the token is missing", async () => {
    server = createMockPostgrest();
    const fetchMock = vi.fn(instagramRouter(server));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv({ INSTAGRAM_ACCESS_TOKEN: undefined }), ctx),
    ).rejects.toMatchObject({
      code: "INSTAGRAM_NOT_CONFIGURED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws INSTAGRAM_NOT_CONFIGURED before any network call when the ig user id is missing", async () => {
    server = createMockPostgrest();
    const fetchMock = vi.fn(instagramRouter(server));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv({ INSTAGRAM_IG_USER_ID: undefined }), ctx),
    ).rejects.toMatchObject({
      code: "INSTAGRAM_NOT_CONFIGURED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an invalid-token Graph error (code 190) on hashtag_search to AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearch: graphErrorResponse(190) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("maps an expired-session Graph error (code 102) to AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearch: graphErrorResponse(102) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("maps the 30-hashtag/7-day Graph limit (code 613) to RATE_LIMITED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearch: graphErrorResponse(613) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("maps the app request-limit Graph error (code 4) to RATE_LIMITED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearch: graphErrorResponse(4) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("maps a 613 Graph error on the top_media call to RATE_LIMITED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { topMedia: graphErrorResponse(613) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("maps a 429 on the hashtag_search call to RATE_LIMITED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearch: new Response("slow down", { status: 429 }) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("maps a 401 on the hashtag_search call to AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearch: new Response("unauthorized", { status: 401 }) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("maps a 403 on the hashtag_search call to AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearch: new Response("forbidden", { status: 403 }) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("maps a 400 invalid-parameter Graph error (code 100) to HTTP_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearch: graphErrorResponse(100) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "HTTP_ERROR",
    });
  });

  it("rejects redirects that leave graph.facebook.com with REDIRECT_UNTRUSTED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearch: redirectResponse("https://evil.example.com/phish") }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "REDIRECT_UNTRUSTED",
    });
  });

  it("rejects redirects without a location header with REDIRECT_NO_LOCATION", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearch: new Response(null, { status: 302 }) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "REDIRECT_NO_LOCATION",
    });
  });

  it("rejects redirect loops with TOO_MANY_REDIRECTS", async () => {
    server = createMockPostgrest();
    let hops = 0;
    const handler = (): Response => redirectResponse(`https://graph.facebook.com/v26.0/iguser/hashtag_search?hop=${++hops}`);
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearchHandler: handler }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "TOO_MANY_REDIRECTS",
    });
  });

  it("maps fetch timeouts to TIMEOUT", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("maps network failures to HTTP_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "HTTP_ERROR",
    });
  });

  it("rejects malformed hashtag_search JSON with INVALID_PAYLOAD", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearch: new Response("this is not json", { status: 200 }) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
  });

  it("rejects oversized responses with RESPONSE_TOO_LARGE", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      instagramRouter(server, {
        hashtagSearch: new Response("x", { status: 200, headers: { "content-length": "900000" } }),
      }),
    );

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("serves cached signals without re-fetching when SCRAPE_CACHE is present", async () => {
    server = createMockPostgrest();
    let hashtagSearchCalls = 0;
    vi.stubGlobal(
      "fetch",
      instagramRouter(server, {
        hashtagSearchHandler: () => {
          hashtagSearchCalls += 1;
          return jsonResponse(HASHTAG_SEARCH_FIXTURE);
        },
      }),
    );
    const kv = new MemoryKV();
    const env = configuredEnv({ SCRAPE_CACHE: kv as unknown as KVNamespace });

    const first = await officialApiInstagramProvider.fetchSignals(NORMALIZED, env, ctx);
    const second = await officialApiInstagramProvider.fetchSignals(NORMALIZED, env, ctx);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(hashtagSearchCalls).toBe(1);
  });
});

describe("instagramModule.collect", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("collects, persists and reports the market collect result", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server));

    const result = await instagramModule.collect({ keyword: "smart watch" }, configuredEnv(), ctx);

    expect(result.source).toBe("instagram");
    expect(result.provider).toBe("official-api");
    expect(result.keyword).toBe("smart watch");
    expect(result.geo).toBe("WORLD");
    expect(result.timeRange).toBe("any");
    expect(result.property).toBe("media");
    expect(result.category).toBeNull();
    expect(result.requested).toBe(1);
    expect(result.persisted).toBe(1);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.signals).toHaveLength(1);

    const source = server.store.sources.find((row) => row.slug === "instagram");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("api");
    expect(server.store.instagram_signals).toHaveLength(1);
    expect(server.store.instagram_signals[0].source_id).toBe(source?.id);
  });

  it("returns SUPABASE_NOT_CONFIGURED when Supabase is missing", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server));

    await expect(
      instagramModule.collect(
        { keyword: "phone" },
        { INSTAGRAM_ACCESS_TOKEN: ACCESS_TOKEN, INSTAGRAM_IG_USER_ID: IG_USER_ID } as Env,
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "SUPABASE_NOT_CONFIGURED",
    });
  });

  it("propagates provider errors as typed MarketError", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { hashtagSearch: new Response("slow down", { status: 429 }) }));

    const error = await instagramModule.collect({ keyword: "phone" }, configuredEnv(), ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    expect((error as MarketError).code).toBe("RATE_LIMITED");
  });

  it("propagates missing-credential errors as INSTAGRAM_NOT_CONFIGURED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server));

    const error = await instagramModule
      .collect({ keyword: "phone" }, configuredEnv({ INSTAGRAM_ACCESS_TOKEN: undefined }), ctx)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    expect((error as MarketError).code).toBe("INSTAGRAM_NOT_CONFIGURED");
  });

  it("propagates validation errors from the query", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server));

    const error = await instagramModule.collect({ limit: 0 }, configuredEnv(), ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    expect((error as MarketError).code).toBe("INVALID_KEYWORD");
  });
});
