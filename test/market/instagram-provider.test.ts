import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../../src/env";
import { normalizeInstagramQuery } from "../../src/market/instagram-engine";
import {
  buildMeMediaUrl,
  getInstagramProvider,
  instagramModule,
  isInstagramHost,
  officialApiInstagramProvider,
  sanitizeInstagramUrl,
} from "../../src/market/instagram";
import { MarketError } from "../../src/market/types";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const ME_MEDIA_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "instagram-me-media.json"), "utf8"),
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
  meMedia?: Response;
  meMediaHandler?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
}

function instagramRouter(server: MockPostgrest, opts: InstagramRouterOptions = {}): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
    if (url.hostname === "graph.instagram.com" && (url.pathname === "/me/media" || url.pathname.endsWith("/me/media"))) {
      if (opts.meMediaHandler) return Promise.resolve(opts.meMediaHandler(url, init));
      if (opts.meMedia) return Promise.resolve(opts.meMedia);
      return Promise.resolve(jsonResponse(ME_MEDIA_FIXTURE));
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
  it("accepts graph.instagram.com, case-insensitively", () => {
    expect(isInstagramHost("graph.instagram.com")).toBe(true);
    expect(isInstagramHost("GRAPH.INSTAGRAM.COM")).toBe(true);
    expect(isInstagramHost("graph.instagram.com.evil.com")).toBe(false);
    expect(isInstagramHost("graph.facebook.com")).toBe(false);
    expect(isInstagramHost("instagram.com")).toBe(false);
    expect(isInstagramHost("example.com")).toBe(false);
  });
});

describe("sanitizeInstagramUrl", () => {
  it("redacts access_token while keeping host, path, and other query params", () => {
    const url =
      "https://graph.instagram.com/me/media?fields=id,caption&limit=25&access_token=secret-token-value";
    const sanitized = sanitizeInstagramUrl(url);
    expect(sanitized).toContain("https://graph.instagram.com/me/media");
    expect(sanitized).toMatch(/fields=id(%2C|,)caption/);
    expect(sanitized).toContain("limit=25");
    expect(sanitized).toContain("access_token=REDACTED");
    expect(sanitized).not.toContain("secret-token-value");
  });

  it("redacts client_secret and appsecret_proof", () => {
    const url = new URL("https://graph.instagram.com/me");
    url.searchParams.set("client_secret", "app-secret");
    url.searchParams.set("appsecret_proof", "proof-value");
    const sanitized = sanitizeInstagramUrl(url);
    expect(sanitized).toContain("client_secret=REDACTED");
    expect(sanitized).toContain("appsecret_proof=REDACTED");
    expect(sanitized).not.toContain("app-secret");
    expect(sanitized).not.toContain("proof-value");
  });
});

describe("getInstagramProvider", () => {
  it("resolves the official-api provider", () => {
    expect(getInstagramProvider().name).toBe("official-api");
  });
});

describe("buildMeMediaUrl", () => {
  it("builds GET graph.instagram.com/me/media with the media fields and limit", () => {
    const url = buildMeMediaUrl(10, ACCESS_TOKEN);
    expect(url.hostname).toBe("graph.instagram.com");
    expect(url.pathname).toBe("/me/media");
    expect(url.searchParams.get("fields")).toContain("id");
    expect(url.searchParams.get("fields")).toContain("caption");
    expect(url.searchParams.get("fields")).toContain("like_count");
    expect(url.searchParams.get("fields")).toContain("comments_count");
    expect(url.searchParams.get("fields")).toContain("media_url");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("access_token")).toBe(ACCESS_TOKEN);
  });
});

describe("officialApiInstagramProvider.fetchSignals", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches /me/media, filters captions, and returns a parsed own-media signal", async () => {
    server = createMockPostgrest();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      instagramRouter(server, {
        meMediaHandler: (url) => {
          seen.push("me_media");
          expect(url.hostname).toBe("graph.instagram.com");
          expect(url.pathname).toBe("/me/media");
          expect(url.searchParams.get("fields")).toContain("id");
          expect(url.searchParams.get("fields")).toContain("caption");
          expect(url.searchParams.get("access_token")).toBe(ACCESS_TOKEN);
          expect(url.href).not.toContain("ig_hashtag_search");
          expect(url.href).not.toContain("top_media");
          expect(url.href).not.toContain("recent_media");
          return jsonResponse(ME_MEDIA_FIXTURE);
        },
      }),
    );

    const signals = await officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx);

    expect(seen).toEqual(["me_media"]);
    expect(signals).toHaveLength(1);
    expect(signals[0].keyword).toBe("smart watch");
    expect(signals[0].hashtag).toBe("smartwatch");
    expect(signals[0].mediaCount).toBe(6);
    expect(signals[0].topMediaCount).toBe(6);
    expect(signals[0].recentMediaCount).toBe(6);
    expect(signals[0].totalEngagement).toBe(5739);
    expect(signals[0].topMedia.map((item) => item.id)).toEqual([
      "media_top3",
      "media_top1",
      "media_top2",
      "media_rec1",
      "media_top4",
      "media_rec2",
    ]);
    expect(signals[0].topMedia.map((item) => item.id)).not.toContain("media_unrelated");
    expect(signals[0].capturedAt).toBeTruthy();
  });

  it("returns a zero signal when no own-media captions match the query", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      instagramRouter(server, {
        meMedia: jsonResponse({
          data: [
            {
              id: "media_unrelated",
              media_type: "IMAGE",
              caption: "Sunset at the beach #travel",
              timestamp: "2026-03-03T10:00:00+0000",
              like_count: 9999,
              comments_count: 999,
            },
          ],
        }),
      }),
    );

    const signals = await officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx);

    expect(signals[0].mediaCount).toBe(0);
    expect(signals[0].topMedia).toEqual([]);
    expect(signals[0].totalEngagement).toBe(0);
    expect(signals[0].hashtag).toBe("smartwatch");
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

  it("maps an invalid-token Graph error (code 190) on /me/media to AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: graphErrorResponse(190) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("never leaks access_token from a Graph AUTH_ERROR message", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: graphErrorResponse(190) }));

    const error = await officialApiInstagramProvider
      .fetchSignals(NORMALIZED, configuredEnv(), ctx)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    const message = (error as MarketError).message;
    expect((error as MarketError).code).toBe("AUTH_ERROR");
    expect(message).not.toContain(ACCESS_TOKEN);
    expect(message).toContain("access_token=REDACTED");
    expect(message).toContain("/me/media");
    expect(JSON.stringify(error)).not.toContain(ACCESS_TOKEN);
  });

  it("never leaks access_token from a Graph RATE_LIMITED message", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: graphErrorResponse(613) }));

    const error = await officialApiInstagramProvider
      .fetchSignals(NORMALIZED, configuredEnv(), ctx)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    const message = (error as MarketError).message;
    expect((error as MarketError).code).toBe("RATE_LIMITED");
    expect(message).not.toContain(ACCESS_TOKEN);
    expect(message).toContain("access_token=REDACTED");
    expect(JSON.stringify(error)).not.toContain(ACCESS_TOKEN);
  });

  it("never leaks access_token from TIMEOUT or network HTTP_ERROR messages", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")));

    const timeoutError = await officialApiInstagramProvider
      .fetchSignals(NORMALIZED, configuredEnv(), ctx)
      .catch((err: unknown) => err);
    expect(timeoutError).toBeInstanceOf(MarketError);
    expect((timeoutError as MarketError).message).not.toContain(ACCESS_TOKEN);
    expect((timeoutError as MarketError).message).toContain("access_token=REDACTED");

    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    const networkError = await officialApiInstagramProvider
      .fetchSignals(NORMALIZED, configuredEnv(), ctx)
      .catch((err: unknown) => err);
    expect(networkError).toBeInstanceOf(MarketError);
    expect((networkError as MarketError).message).not.toContain(ACCESS_TOKEN);
    expect((networkError as MarketError).message).toContain("access_token=REDACTED");
    expect((networkError as MarketError).message).toContain("/me/media");
  });

  it("never leaks access_token when fetch throws an error whose message contains the request URL", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      return Promise.reject(new TypeError(`fetch failed: ${href}`));
    });

    const error = await officialApiInstagramProvider
      .fetchSignals(NORMALIZED, configuredEnv(), ctx)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MarketError);
    const message = (error as MarketError).message;
    expect((error as MarketError).code).toBe("HTTP_ERROR");
    expect(message).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(error)).not.toContain(ACCESS_TOKEN);
    expect(message).toContain("graph.instagram.com");
    expect(message).toContain("/me/media");
    expect(message).toContain("access_token=REDACTED");
  });

  it("preserves a 17-digit media id from unquoted Graph JSON", async () => {
    server = createMockPostgrest();
    const rawMedia =
      '{"data":[{"id":28689534960681881,"media_type":"IMAGE","caption":"#smartwatch","timestamp":"2026-01-01T00:00:00+0000","like_count":1,"comments_count":0}]}';
    vi.stubGlobal(
      "fetch",
      instagramRouter(server, {
        meMedia: new Response(rawMedia, { status: 200, headers: { "content-type": "application/json" } }),
      }),
    );

    const signals = await officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx);
    expect(signals[0].topMedia[0].id).toBe("28689534960681881");
    expect(signals[0].topMedia[0].id).not.toBe(String(JSON.parse(rawMedia).data[0].id));
  });

  it("maps an expired-session Graph error (code 102) to AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: graphErrorResponse(102) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("maps a Graph rate-limit error (code 613) to RATE_LIMITED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: graphErrorResponse(613) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("maps the app request-limit Graph error (code 4) to RATE_LIMITED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: graphErrorResponse(4) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("maps a 429 on the /me/media call to RATE_LIMITED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: new Response("slow down", { status: 429 }) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("maps a 401 on the /me/media call to AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: new Response("unauthorized", { status: 401 }) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("maps a 403 on the /me/media call to AUTH_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: new Response("forbidden", { status: 403 }) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("maps a 400 invalid-parameter Graph error (code 100) to HTTP_ERROR", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: graphErrorResponse(100) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "HTTP_ERROR",
    });
  });

  it("rejects redirects that leave graph.instagram.com with REDIRECT_UNTRUSTED", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: redirectResponse("https://evil.example.com/phish") }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "REDIRECT_UNTRUSTED",
    });
  });

  it("rejects redirects without a location header with REDIRECT_NO_LOCATION", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: new Response(null, { status: 302 }) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "REDIRECT_NO_LOCATION",
    });
  });

  it("rejects redirect loops with TOO_MANY_REDIRECTS", async () => {
    server = createMockPostgrest();
    let hops = 0;
    const handler = (): Response => redirectResponse(`https://graph.instagram.com/me/media?hop=${++hops}`);
    vi.stubGlobal("fetch", instagramRouter(server, { meMediaHandler: handler }));

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

  it("rejects malformed /me/media JSON with INVALID_PAYLOAD", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: new Response("this is not json", { status: 200 }) }));

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
  });

  it("rejects oversized responses with RESPONSE_TOO_LARGE", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      instagramRouter(server, {
        meMedia: new Response("x", { status: 200, headers: { "content-length": "900000" } }),
      }),
    );

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("serves cached signals without re-fetching when SCRAPE_CACHE is present", async () => {
    server = createMockPostgrest();
    let meMediaCalls = 0;
    vi.stubGlobal(
      "fetch",
      instagramRouter(server, {
        meMediaHandler: () => {
          meMediaCalls += 1;
          return jsonResponse(ME_MEDIA_FIXTURE);
        },
      }),
    );
    const kv = new MemoryKV();
    const env = configuredEnv({ SCRAPE_CACHE: kv as unknown as KVNamespace });

    const first = await officialApiInstagramProvider.fetchSignals(NORMALIZED, env, ctx);
    const second = await officialApiInstagramProvider.fetchSignals(NORMALIZED, env, ctx);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(meMediaCalls).toBe(1);
  });

  it("follows allowlisted paging.next and merges unique own media", async () => {
    server = createMockPostgrest();
    const page1 = {
      data: [
        {
          id: "media_page1",
          media_type: "IMAGE",
          caption: "page one #smartwatch",
          timestamp: "2026-03-02T00:00:00+0000",
          like_count: 10,
          comments_count: 1,
        },
      ],
      paging: { next: "https://graph.instagram.com/me/media?after=cursor1" },
    };
    const page2 = {
      data: [
        {
          id: "media_page2",
          media_type: "IMAGE",
          caption: "page two #smartwatch",
          timestamp: "2026-03-01T00:00:00+0000",
          like_count: 50,
          comments_count: 5,
        },
        {
          id: "media_page1",
          media_type: "IMAGE",
          caption: "page one duplicate #smartwatch",
          timestamp: "2026-03-02T00:00:00+0000",
          like_count: 10,
          comments_count: 1,
        },
      ],
    };
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      instagramRouter(server, {
        meMediaHandler: (url) => {
          seen.push(url.searchParams.get("after") ?? "first");
          if (url.searchParams.get("after") === "cursor1") return jsonResponse(page2);
          return jsonResponse(page1);
        },
      }),
    );

    const signals = await officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx);

    expect(seen).toEqual(["first", "cursor1"]);
    expect(signals[0].mediaCount).toBe(2);
    expect(signals[0].topMedia.map((item) => item.id)).toEqual(["media_page2", "media_page1"]);
  });

  it("rejects paging.next that leaves graph.instagram.com", async () => {
    server = createMockPostgrest();
    vi.stubGlobal(
      "fetch",
      instagramRouter(server, {
        meMedia: jsonResponse({
          data: [],
          paging: { next: "https://evil.example.com/steal" },
        }),
      }),
    );

    await expect(officialApiInstagramProvider.fetchSignals(NORMALIZED, configuredEnv(), ctx)).rejects.toMatchObject({
      code: "REDIRECT_UNTRUSTED",
    });
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
    vi.stubGlobal("fetch", instagramRouter(server, { meMedia: new Response("slow down", { status: 429 }) }));

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
