import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../../src/env";
import { routeRequest } from "../../src/router";
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

/** Minimal ExecutionContext with the waitUntil the youtube cache needs. */
function mockCtx(): ExecutionContext {
  return {
    waitUntil: (promise) => {
      void promise;
    },
    passThroughOnException: () => undefined,
  } as ExecutionContext;
}

const ctx = mockCtx();

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: SECRET_KEY,
    YOUTUBE_API_KEY: API_KEY,
    ...overrides,
  } as Env;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Routes www.googleapis.com to fixtures and everything else to the PostgREST mock. */
function compositeFetch(
  server: MockPostgrest,
  opts: { search?: Response; videos?: Response } = {},
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
    if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/search") {
      if (opts.search) return Promise.resolve(opts.search);
      return Promise.resolve(jsonResponse(SEARCH_FIXTURE));
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/videos") {
      if (opts.videos) return Promise.resolve(opts.videos);
      return Promise.resolve(jsonResponse(VIDEOS_FIXTURE));
    }
    return server.fetch(input, init);
  };
}

async function get(
  server: MockPostgrest,
  path: string,
  requestEnv: Env = configuredEnv(),
  fetchMock: typeof fetch = compositeFetch(server),
): Promise<Response> {
  vi.stubGlobal("fetch", fetchMock);
  return routeRequest(new Request(`https://worker.example${path}`, { method: "GET" }), requestEnv, ctx);
}

interface YouTubeBody {
  status: string;
  source: string;
  provider: string;
  keyword: string;
  order: string;
  publishedWithin: string;
  limit: number | null;
  capturedAt: string;
  requested: number;
  persisted: number;
  created: number;
  updated: number;
  failed: number;
  signals: Array<{ keyword: string; videoCount: number; totalViews: number; topChannel: string | null }>;
}

describe("GET /api/market/youtube", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("collects, persists and reports a YouTube signal for a keyword", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/youtube?q=smart%20watch");
    expect(res.status).toBe(200);

    const body = (await res.json()) as YouTubeBody;
    expect(body.status).toBe("ok");
    expect(body.source).toBe("youtube");
    expect(body.provider).toBe("official-api");
    expect(body.keyword).toBe("smart watch");
    expect(body.order).toBe("relevance");
    expect(body.publishedWithin).toBe("any");
    expect(body.limit).toBe(25);
    expect(body.requested).toBe(1);
    expect(body.persisted).toBe(1);
    expect(body.created).toBe(1);
    expect(body.updated).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]).toMatchObject({
      keyword: "smart watch",
      videoCount: 1243,
      totalViews: 425000,
      topChannel: "TechReviews",
    });
    expect(body.capturedAt).toBeTruthy();

    const source = server.store.sources.find((row) => row.slug === "youtube");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("api");
    expect(server.store.youtube_signals).toHaveLength(1);
    expect(server.store.youtube_signals[0].source_id).toBe(source?.id);
  });

  it("defaults order to relevance, publishedWithin to any and limit to 25", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/youtube?q=phone");
    const body = (await res.json()) as YouTubeBody;

    expect(res.status).toBe(200);
    expect(body.order).toBe("relevance");
    expect(body.publishedWithin).toBe("any");
    expect(body.limit).toBe(25);
  });

  it("propagates maxResults, order and publishedWithin query parameters", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/youtube?q=phone&maxResults=10&order=viewCount&publishedWithin=week");
    const body = (await res.json()) as YouTubeBody;

    expect(res.status).toBe(200);
    expect(body.order).toBe("viewCount");
    expect(body.publishedWithin).toBe("week");
    expect(body.limit).toBe(10);
  });

  it("returns 400 MISSING_KEYWORD when q is absent", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/youtube");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("MISSING_KEYWORD");
    expect(server.requests).toHaveLength(0);
  });

  it("returns 400 with the validation code for an invalid limit", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/youtube?q=phone&maxResults=0");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_LIMIT");
  });

  it("returns 400 with the validation code for an invalid order", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/youtube?q=phone&order=title");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_ORDER");
  });

  it("returns 400 with the validation code for an invalid publishedWithin", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/youtube?q=phone&publishedWithin=decade");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_PUBLISHED_WITHIN");
  });

  it("returns 502 with the provider's typed code when YouTube rate-limits the request", async () => {
    server = createMockPostgrest();

    const res = await get(
      server,
      "/api/market/youtube?q=phone",
      configuredEnv(),
      compositeFetch(server, { search: new Response("slow down", { status: 429 }) }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("returns 502 with QUOTA_EXCEEDED when the YouTube quota bucket is exhausted", async () => {
    server = createMockPostgrest();

    const res = await get(
      server,
      "/api/market/youtube?q=phone",
      configuredEnv(),
      compositeFetch(server, {
        search: jsonResponse(
          {
            error: {
              code: 403,
              message: "quota exceeded",
              errors: [{ message: "quota exceeded", reason: "quotaExceeded" }],
            },
          },
          403,
        ),
      }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("QUOTA_EXCEEDED");
  });

  it("returns 502 YOUTUBE_NOT_CONFIGURED when the YouTube api key is missing", async () => {
    server = createMockPostgrest();

    const res = await get(
      server,
      "/api/market/youtube?q=phone",
      configuredEnv({ YOUTUBE_API_KEY: undefined }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("YOUTUBE_NOT_CONFIGURED");
    expect(server.requests).toHaveLength(0);
  });

  it("returns 503 SUPABASE_NOT_CONFIGURED without touching the network", async () => {
    server = createMockPostgrest();
    const fetchMock = vi.fn(compositeFetch(server));
    vi.stubGlobal("fetch", fetchMock);

    const res = await routeRequest(
      new Request("https://worker.example/api/market/youtube?q=phone", { method: "GET" }),
      {} as Env,
      ctx,
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe("SUPABASE_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 405 for non-GET methods", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server));

    const res = await routeRequest(
      new Request("https://worker.example/api/market/youtube?q=phone", { method: "POST" }),
      configuredEnv(),
      ctx,
    );

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
    expect(server.requests).toHaveLength(0);
  });

  it("never leaks credentials into the response or request URLs", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/youtube?q=smart%20watch");
    const text = await res.text();

    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain(API_KEY);
    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${SECRET_KEY}`);
    }
  });
});
