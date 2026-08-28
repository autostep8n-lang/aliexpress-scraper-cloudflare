import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../../src/env";
import { normalizeYouTubeQuery } from "../../src/market/youtube-engine";
import {
  buildSearchUrl,
  buildVideosUrl,
  getYouTubeProvider,
  isYouTubeHost,
  officialApiYouTubeProvider,
  youtubeModule,
} from "../../src/market/youtube";
import { MarketError } from "../../src/market/types";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SEARCH_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "youtube-search.json"), "utf8"),
) as Record<string, unknown>;

const VIDEOS_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "youtube-videos.json"), "utf8"),
) as Record<string, unknown>;

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const API_KEY = "test-youtube-api-key";

function mockCtx(): ExecutionContext {
  return {
    waitUntil: (promise) => {
      void promise;
    },
    passThroughOnException: () => undefined,
  } as ExecutionContext;
}

const ctx = mockCtx();

const NORMALIZED = normalizeYouTubeQuery({ keyword: "smart watch" });

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

interface YouTubeRouterOptions {
  search?: Response;
  videos?: Response;
  searchHandler?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
  videosHandler?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
}

function youtubeRouter(server: MockPostgrest, opts: YouTubeRouterOptions = {}): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
    if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/search") {
      if (opts.searchHandler) return Promise.resolve(opts.searchHandler(url, init));
      if (opts.search) return Promise.resolve(opts.search);
      return Promise.resolve(jsonResponse(SEARCH_FIXTURE));
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/videos") {
      if (opts.videosHandler) return Promise.resolve(opts.videosHandler(url, init));
      if (opts.videos) return Promise.resolve(opts.videos);
      return Promise.resolve(jsonResponse(VIDEOS_FIXTURE));
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

function quotaResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: 403,
        message: "The request cannot be completed because you have exceeded your quota.",
        errors: [{ message: "The request cannot be completed because you have exceeded your quota.", reason: "quotaExceeded" }],
      },
    },
    403,
  );
}

function keyInvalidResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        errors: [{ message: "API key not valid. Please pass a valid API key.", reason: "keyInvalid" }],
      },
    },
    400,
  );
}

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: SECRET_KEY,
    YOUTUBE_API_KEY: API_KEY,
    ...overrides,
  } as Env;
}

describe("isYouTubeHost", () => {
  it("accepts www.googleapis.com, case-insensitively", () => {
    expect(isYouTubeHost("www.googleapis.com")).toBe(true);
    expect(isYouTubeHost("WWW.GOOGLEAPIS.COM")).toBe(true);
    expect(isYouTubeHost("www.googleapis.com.evil.com")).toBe(false);
    expect(isYouTubeHost("googleapis.com")).toBe(false);
    expect(isYouTubeHost("oauth.reddit.com")).toBe(false);
    expect(isYouTubeHost("example.com")).toBe(false);
  });
});

describe("getYouTubeProvider", () => {
  it("resolves the official-api provider", () => {
    expect(getYouTubeProvider().name).toBe("official-api");
  });
});

describe("buildSearchUrl", () => {
  const NOW = Date.parse("2026-03-08T00:00:00.000Z");

  it("builds the youtube search URL with all normalized parameters", () => {
    const url = buildSearchUrl(NORMALIZED, API_KEY, NOW);
    expect(url.hostname).toBe("www.googleapis.com");
    expect(url.pathname).toBe("/youtube/v3/search");
    expect(url.searchParams.get("part")).toBe("snippet");
    expect(url.searchParams.get("type")).toBe("video");
    expect(url.searchParams.get("q")).toBe("smart watch");
    expect(url.searchParams.get("maxResults")).toBe("25");
    expect(url.searchParams.get("order")).toBe("relevance");
    expect(url.searchParams.get("key")).toBe(API_KEY);
    expect(url.searchParams.get("publishedAfter")).toBeNull();
  });

  it("propagates limit, order and publishedWithin", () => {
    const query = normalizeYouTubeQuery({
      keyword: "phone",
      limit: 10,
      order: "viewCount",
      publishedWithin: "week",
    });
    const url = buildSearchUrl(query, API_KEY, NOW);
    expect(url.searchParams.get("maxResults")).toBe("10");
    expect(url.searchParams.get("order")).toBe("viewCount");
    expect(url.searchParams.get("publishedAfter")).toBe(new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString());
  });
});

describe("buildVideosUrl", () => {
  it("builds the videos statistics URL with a comma-joined id list", () => {
    const url = buildVideosUrl(["vid1", "vid2"], API_KEY);
    expect(url.pathname).toBe("/youtube/v3/videos");
    expect(url.searchParams.get("part")).toBe("statistics");
    expect(url.searchParams.get("id")).toBe("vid1,vid2");
    expect(url.searchParams.get("key")).toBe(API_KEY);
  });

  it("caps the id list at 50 video ids", () => {
    const ids = Array.from({ length: 60 }, (_, index) => `vid${index}`);
    const url = buildVideosUrl(ids, API_KEY);
    expect(url.searchParams.get("id")?.split(",")).toHaveLength(50);
  });
});

describe("officialApiYouTubeProvider.fetchSignals", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches search then statistics and returns a parsed aggregate signal", async () => {
    server = createMockPostgrest();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      youtubeRouter(server, {
        searchHandler: (url) => {
          seen.push("search");
          expect(url.searchParams.get("q")).toBe("smart watch");
          return jsonResponse(SEARCH_FIXTURE);
        },
        videosHandler: (url) => {
          seen.push("videos");
          expect(url.searchParams.get("part")).toBe("statistics");
          expect(url.searchParams.get("id")).toBe("vid1,vid2,vid3,vid4");
          return jsonResponse(VIDEOS_FIXTURE);
        },
      }),
    );

    const signals = await officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx);

    expect(seen).toEqual(["search", "videos"]);
    expect(signals).toHaveLength(1);
    expect(signals[0].keyword).toBe("smart watch");
    expect(signals[0].videoCount).toBe(1243);
    expect(signals[0].totalViews).toBe(425000);
    expect(signals[0].capturedAt).toBeTruthy();
  });

  it("skips the statistics call when the search returns no videos", async () => {
    server = createMockPostgrest();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      youtubeRouter(server, {
        searchHandler: () => {
          seen.push("search");
          return jsonResponse({ items: [], pageInfo: { totalResults: 0 } });
        },
        videosHandler: () => {
          seen.push("videos");
          return jsonResponse({ items: [] });
        },
      }),
    );

    const signals = await officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx);

    expect(seen).toEqual(["search"]);
    expect(signals[0].totalViews).toBe(0);
    expect(signals[0].videos).toEqual([]);
  });

  it("throws YOUTUBE_NOT_CONFIGURED before any network call when the api key is missing", async () => {
    server = createMockPostgrest();
    const fetchMock = vi.fn(youtubeRouter(server));
    vi.stubGlobal("fetch", fetchMock);

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, {} as Env, ctx)).rejects.toMatchObject({
      code: "YOUTUBE_NOT_CONFIGURED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a quota-exhausted 403 on the search call to QUOTA_EXCEEDED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server, { search: quotaResponse() }));

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
  });

  it("maps a quota-exhausted 403 on the statistics call to QUOTA_EXCEEDED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server, { videos: quotaResponse() }));

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
  });

  it("maps a plain 403 on the search call to AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server, { search: new Response("forbidden", { status: 403 }) }));

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("maps an invalid api key 400 to AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server, { search: keyInvalidResponse() }));

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("maps a 401 on the search call to AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server, { search: new Response("unauthorized", { status: 401 }) }));

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("maps a 429 on the search call to RATE_LIMITED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server, { search: new Response("slow down", { status: 429 }) }));

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("rejects redirects that leave www.googleapis.com with REDIRECT_UNTRUSTED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server, { search: redirectResponse("https://evil.example.com/phish") }));

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "REDIRECT_UNTRUSTED",
    });
  });

  it("rejects redirects without a location header with REDIRECT_NO_LOCATION", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server, { search: new Response(null, { status: 302 }) }));

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "REDIRECT_NO_LOCATION",
    });
  });

  it("rejects redirect loops with TOO_MANY_REDIRECTS", async () => {
    server = createMockPostgrest();
    let hops = 0;
    const handler = (): Response => redirectResponse(`https://www.googleapis.com/youtube/v3/search?hop=${++hops}`);
    vi.stubGlobal("fetch", youtubeRouter(server, { searchHandler: handler }));

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "TOO_MANY_REDIRECTS",
    });
  });

  it("maps fetch timeouts to TIMEOUT", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    );

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("maps network failures to HTTP_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "HTTP_ERROR",
    });
  });

  it("rejects malformed search JSON with INVALID_PAYLOAD", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server, { search: new Response("this is not json", { status: 200 }) }));

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
  });

  it("rejects oversized responses with RESPONSE_TOO_LARGE", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      youtubeRouter(server, {
        search: new Response("x", { status: 200, headers: { "content-length": "900000" } }),
      }),
    );

    await expect(officialApiYouTubeProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("serves cached signals without re-fetching when SCRAPE_CACHE is present", async () => {
    server = createMockPostgrest();
    let searchCalls = 0;
    vi.stubGlobal(
      "fetch",
      youtubeRouter(server, {
        searchHandler: () => {
          searchCalls += 1;
          return jsonResponse(SEARCH_FIXTURE);
        },
      }),
    );
    const kv = new MemoryKV();
    const env = configuredEnv({ SCRAPE_CACHE: kv as unknown as KVNamespace });

    const first = await officialApiYouTubeProvider.fetchSignals(NORMALIZED, env, ctx);
    const second = await officialApiYouTubeProvider.fetchSignals(NORMALIZED, env, ctx);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(searchCalls).toBe(1);
  });
});

describe("youtubeModule.collect", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("collects, persists and reports the market collect result", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server));

    const result = await youtubeModule.collect({ keyword: "smart watch" }, configuredEnv(), ctx);

    expect(result.source).toBe("youtube");
    expect(result.provider).toBe("official-api");
    expect(result.keyword).toBe("smart watch");
    expect(result.geo).toBe("WORLD");
    expect(result.timeRange).toBe("any");
    expect(result.property).toBe("videos");
    expect(result.category).toBeNull();
    expect(result.requested).toBe(1);
    expect(result.persisted).toBe(1);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.signals).toHaveLength(1);

    const source = server.store.sources.find((row) => row.slug === "youtube");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("api");
    expect(server.store.youtube_signals).toHaveLength(1);
    expect(server.store.youtube_signals[0].source_id).toBe(source?.id);
  });

  it("returns SUPABASE_NOT_CONFIGURED when Supabase is missing", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server));

    await expect(
      youtubeModule.collect({ keyword: "phone" }, { YOUTUBE_API_KEY: API_KEY } as Env, ctx),
    ).rejects.toMatchObject({
      code: "SUPABASE_NOT_CONFIGURED",
    });
  });

  it("propagates provider errors as typed MarketError", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server, { search: new Response("slow down", { status: 429 }) }));

    const error = await youtubeModule.collect({ keyword: "phone" }, configuredEnv(), ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    expect((error as MarketError).code).toBe("RATE_LIMITED");
  });

  it("propagates missing-credential errors as YOUTUBE_NOT_CONFIGURED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server));

    const error = await youtubeModule
      .collect({ keyword: "phone" }, configuredEnv({ YOUTUBE_API_KEY: undefined }), ctx)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    expect((error as MarketError).code).toBe("YOUTUBE_NOT_CONFIGURED");
  });

  it("propagates validation errors from the query", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", youtubeRouter(server));

    const error = await youtubeModule.collect({ order: "title" }, configuredEnv(), ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    expect((error as MarketError).code).toBe("INVALID_KEYWORD");
  });
});
