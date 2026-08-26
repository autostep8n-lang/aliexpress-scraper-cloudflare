import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../../src/env";
import { normalizeQuery } from "../../src/market/engine";
import {
  buildExploreRequest,
  getGoogleTrendsProvider,
  googleTrendsModule,
  internalApiTrendsProvider,
  isTrendsHost,
} from "../../src/market/google-trends";
import { MarketError } from "../../src/market/types";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const EXPLORE_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "google-trends-explore.json"), "utf8"),
) as Record<string, unknown>;
const MULTILINE_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "google-trends-multiline.json"), "utf8"),
) as Record<string, unknown>;

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

function mockCtx(): ExecutionContext {
  return {
    waitUntil: (promise) => {
      void promise;
    },
    passThroughOnException: () => undefined,
  } as ExecutionContext;
}

const ctx = mockCtx();

/** Asserts that `fn` throws a MarketError with the given code. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as MarketError).code).toBe(code);
    return;
  }
  throw new Error(`expected a MarketError with code ${code}`);
}

const NORMALIZED = normalizeQuery({ keyword: "smart watch", geo: "US" });

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

interface TrendsRouterOptions {
  explore?: Response;
  multiline?: Response;
  exploreHandler?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
  multilineHandler?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
}

function trendsRouter(server: MockPostgrest, opts: TrendsRouterOptions = {}): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
    if (url.hostname === "trends.google.com" && url.pathname === "/trends/api/explore") {
      if (opts.exploreHandler) return Promise.resolve(opts.exploreHandler(url, init));
      if (opts.explore) return Promise.resolve(opts.explore);
      const explore = structuredClone(EXPLORE_FIXTURE);
      return Promise.resolve(
        new Response(JSON.stringify(explore), { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
    if (url.hostname === "trends.google.com" && url.pathname === "/trends/api/widgetdata/multiline") {
      if (opts.multilineHandler) return Promise.resolve(opts.multilineHandler(url, init));
      if (opts.multiline) return Promise.resolve(opts.multiline);
      return Promise.resolve(
        new Response(JSON.stringify(MULTILINE_FIXTURE), { status: 200, headers: { "content-type": "application/json" } }),
      );
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
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY, ...overrides } as Env;
}

describe("isTrendsHost", () => {
  it("accepts trends.google.com and subdomains, case-insensitively", () => {
    expect(isTrendsHost("trends.google.com")).toBe(true);
    expect(isTrendsHost("Trends.Google.com")).toBe(true);
    expect(isTrendsHost("api.trends.google.com")).toBe(true);
    expect(isTrendsHost("google.com")).toBe(false);
    expect(isTrendsHost("trends.google.com.evil.com")).toBe(false);
    expect(isTrendsHost("example.com")).toBe(false);
  });
});

describe("buildExploreRequest", () => {
  it("builds a one-keyword comparison item, mapping WORLD/geo and web/property", () => {
    const parsed = JSON.parse(buildExploreRequest(NORMALIZED)) as {
      comparisonItem: Array<{ keyword: string; geo: string; time: string; category: number; property: string }>;
    };
    expect(parsed.comparisonItem).toHaveLength(1);
    expect(parsed.comparisonItem[0]).toMatchObject({
      keyword: "smart watch",
      geo: "US",
      time: "today 5-y",
      category: 0,
      property: "",
    });

    const world = normalizeQuery({ keyword: "phone" });
    const parsedWorld = JSON.parse(buildExploreRequest(world)) as {
      comparisonItem: Array<{ geo: string; property: string }>;
    };
    expect(parsedWorld.comparisonItem[0].geo).toBe("");
    expect(parsedWorld.comparisonItem[0].property).toBe("");
  });
});

describe("getGoogleTrendsProvider", () => {
  it("defaults to the internal-api provider", () => {
    expect(getGoogleTrendsProvider({} as Env).name).toBe("internal-api");
    expect(getGoogleTrendsProvider(configuredEnv({ GOOGLE_TRENDS_PROVIDER: "INTERNAL-API" })).name).toBe("internal-api");
  });

  it("rejects unknown providers with PROVIDER_UNAVAILABLE", () => {
    expectCode(
      () => getGoogleTrendsProvider(configuredEnv({ GOOGLE_TRENDS_PROVIDER: "pytrends" })),
      "PROVIDER_UNAVAILABLE",
    );
  });
});

describe("internalApiTrendsProvider.fetchSignals", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("executes the two-request handshake and returns parsed signals", async () => {
    server = createMockPostgrest();
    const seen: Array<{ path: string; cookie?: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      trendsRouter(server, {
        exploreHandler: (url) => {
          seen.push({ path: url.pathname });
          return jsonResponse(EXPLORE_FIXTURE);
        },
        multilineHandler: (url, init) => {
          const headers = init?.headers as Record<string, string> | Headers | undefined;
          const cookie = headers instanceof Headers ? headers.get("cookie") : headers?.cookie;
          seen.push({ path: url.pathname, cookie });
          expect(url.searchParams.get("token")).toBe("v2-explore-token-1");
          return jsonResponse(MULTILINE_FIXTURE);
        },
      }),
    );

    const signals = await internalApiTrendsProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx);

    expect(seen.map((entry) => entry.path)).toEqual(["/trends/api/explore", "/trends/api/widgetdata/multiline"]);
    expect(seen[1].cookie).toContain("NID=");
    expect(signals).toHaveLength(5);
    expect(signals[0].keyword).toBe("smart watch");
    expect(signals[0].geo).toBe("US");
    expect(signals[0].value).toBe(100);
    expect(signals[0].periodStart).toBe("2025-10-03T00:00:00.000Z");
    expect(signals.every((item) => item.capturedAt)).toBe(true);
  });

  it("maps HTTP 429 to RATE_LIMITED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", trendsRouter(server, { explore: new Response("rate limited", { status: 429 }) }));

    await expect(internalApiTrendsProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("maps non-2xx responses to HTTP_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", trendsRouter(server, { explore: new Response("nope", { status: 500 }) }));

    await expect(internalApiTrendsProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "HTTP_ERROR",
    });
  });

  it("follows same-host redirects", async () => {
    server = createMockPostgrest();
    let redirected = false;
    vi.stubGlobal(
      "fetch",
      trendsRouter(server, {
        exploreHandler: () => {
          if (!redirected) {
            redirected = true;
            return redirectResponse("https://trends.google.com/trends/api/explore?hl=en-US");
          }
          return jsonResponse(EXPLORE_FIXTURE);
        },
      }),
    );

    const signals = await internalApiTrendsProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx);
    expect(redirected).toBe(true);
    expect(signals.length).toBeGreaterThan(0);
  });

  it("rejects redirects that leave trends.google.com with REDIRECT_UNTRUSTED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      trendsRouter(server, {
        explore: redirectResponse("https://evil.example.com/phish"),
        exploreHandler: undefined,
      }),
    );

    await expect(internalApiTrendsProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "REDIRECT_UNTRUSTED",
    });
  });

  it("rejects redirects without a location header with REDIRECT_NO_LOCATION", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", trendsRouter(server, { explore: new Response(null, { status: 302 }) }));

    await expect(internalApiTrendsProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "REDIRECT_NO_LOCATION",
    });
  });

  it("rejects redirect loops with TOO_MANY_REDIRECTS", async () => {
    server = createMockPostgrest();
    let hops = 0;
    const handler = (): Response =>
      redirectResponse(`https://trends.google.com/trends/api/explore?hop=${++hops}`);
    vi.stubGlobal("fetch", trendsRouter(server, { exploreHandler: handler }));

    await expect(internalApiTrendsProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "TOO_MANY_REDIRECTS",
    });
  });

  it("maps fetch timeouts to TIMEOUT", async () => {
    server = createMockPostgrest();
    const timeoutFetch = (): Promise<Response> =>
      Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
    vi.stubGlobal("fetch", timeoutFetch);

    await expect(internalApiTrendsProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("maps network failures to HTTP_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      () => Promise.reject(new TypeError("Failed to fetch")),
    );

    await expect(internalApiTrendsProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "HTTP_ERROR",
    });
  });

  it("rejects an explore response without widgets with INVALID_PAYLOAD", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", trendsRouter(server, { explore: jsonResponse({ widgets: [], cookie: "NID=x" }) }));

    await expect(internalApiTrendsProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
  });

  it("rejects malformed JSON with INVALID_PAYLOAD", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      trendsRouter(server, { explore: new Response("this is not json", { status: 200 }) }),
    );

    await expect(internalApiTrendsProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
  });

  it("rejects oversized responses with RESPONSE_TOO_LARGE", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      trendsRouter(server, {
        explore: new Response("x", { status: 200, headers: { "content-length": "900000" } }),
      }),
    );

    await expect(internalApiTrendsProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("serves cached signals without re-fetching when SCRAPE_CACHE is present", async () => {
    server = createMockPostgrest();
    let trendsCalls = 0;
    vi.stubGlobal(
      "fetch",
      trendsRouter(server, {
        exploreHandler: () => {
          trendsCalls += 1;
          return jsonResponse(EXPLORE_FIXTURE);
        },
      }),
    );
    const kv = new MemoryKV();
    const env = configuredEnv({ SCRAPE_CACHE: kv as unknown as KVNamespace });

    const first = await internalApiTrendsProvider.fetchSignals(NORMALIZED, env, ctx);
    const second = await internalApiTrendsProvider.fetchSignals(NORMALIZED, env, ctx);

    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    expect(trendsCalls).toBe(1);
  });
});

describe("googleTrendsModule.collect", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("collects, persists and reports the market collect result", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", trendsRouter(server));

    const result = await googleTrendsModule.collect(
      { keyword: "smart watch", geo: "US" },
      configuredEnv(),
      ctx,
    );

    expect(result.source).toBe("google-trends");
    expect(result.provider).toBe("internal-api");
    expect(result.keyword).toBe("smart watch");
    expect(result.geo).toBe("US");
    expect(result.timeRange).toBe("today 5-y");
    expect(result.property).toBe("web");
    expect(result.category).toBeNull();
    expect(result.requested).toBe(5);
    expect(result.persisted).toBe(5);
    expect(result.created).toBe(5);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.signals).toHaveLength(5);

    const source = server.store.sources.find((row) => row.slug === "google-trends");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("api");
    expect(server.store.google_trends).toHaveLength(5);
    expect(server.store.google_trends[0].source_id).toBe(source?.id);
  });

  it("returns SUPABASE_NOT_CONFIGURED when Supabase is missing", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", trendsRouter(server));

    await expect(googleTrendsModule.collect({ keyword: "phone" }, {} as Env, ctx)).rejects.toMatchObject({
      code: "SUPABASE_NOT_CONFIGURED",
    });
  });

  it("propagates provider errors as typed MarketError", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", trendsRouter(server, { explore: new Response("rate limited", { status: 429 }) }));

    const error = await googleTrendsModule.collect(
      { keyword: "phone" },
      configuredEnv(),
      ctx,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    expect((error as MarketError).code).toBe("RATE_LIMITED");
  });

  it("propagates validation errors from the query", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", trendsRouter(server));

    const error = await googleTrendsModule.collect({ geo: "USA" }, configuredEnv(), ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    expect((error as MarketError).code).toBe("INVALID_KEYWORD");
  });
});
