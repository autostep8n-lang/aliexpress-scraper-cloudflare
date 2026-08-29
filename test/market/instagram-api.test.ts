import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../../src/env";
import { routeRequest } from "../../src/router";
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

/** Minimal ExecutionContext with the waitUntil the instagram cache needs. */
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
    INSTAGRAM_ACCESS_TOKEN: ACCESS_TOKEN,
    INSTAGRAM_IG_USER_ID: IG_USER_ID,
    ...overrides,
  } as Env;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

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

/** Routes graph.facebook.com to fixtures and everything else to the PostgREST mock. */
function compositeFetch(
  server: MockPostgrest,
  opts: { hashtagSearch?: Response; topMedia?: Response; recentMedia?: Response } = {},
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
    if (url.hostname === "graph.facebook.com" && url.pathname.endsWith("/hashtag_search")) {
      if (opts.hashtagSearch) return Promise.resolve(opts.hashtagSearch);
      return Promise.resolve(jsonResponse(HASHTAG_SEARCH_FIXTURE));
    }
    if (url.hostname === "graph.facebook.com" && url.pathname.endsWith("/top_media")) {
      if (opts.topMedia) return Promise.resolve(opts.topMedia);
      return Promise.resolve(jsonResponse(TOP_MEDIA_FIXTURE));
    }
    if (url.hostname === "graph.facebook.com" && url.pathname.endsWith("/recent_media")) {
      if (opts.recentMedia) return Promise.resolve(opts.recentMedia);
      return Promise.resolve(jsonResponse(RECENT_MEDIA_FIXTURE));
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

interface InstagramBody {
  status: string;
  source: string;
  provider: string;
  keyword: string;
  hashtag: string | null;
  limit: number | null;
  capturedAt: string;
  requested: number;
  persisted: number;
  created: number;
  updated: number;
  failed: number;
  signals: Array<{ keyword: string; hashtag: string; mediaCount: number; totalEngagement: number }>;
}

describe("GET /api/market/instagram", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("collects, persists and reports an Instagram signal for a keyword", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/instagram?q=smart%20watch");
    expect(res.status).toBe(200);

    const body = (await res.json()) as InstagramBody;
    expect(body.status).toBe("ok");
    expect(body.source).toBe("instagram");
    expect(body.provider).toBe("official-api");
    expect(body.keyword).toBe("smart watch");
    expect(body.hashtag).toBe("smartwatch");
    expect(body.limit).toBe(25);
    expect(body.requested).toBe(1);
    expect(body.persisted).toBe(1);
    expect(body.created).toBe(1);
    expect(body.updated).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]).toMatchObject({
      keyword: "smart watch",
      hashtag: "smartwatch",
      mediaCount: 6,
      totalEngagement: 5739,
    });
    expect(body.capturedAt).toBeTruthy();

    const source = server.store.sources.find((row) => row.slug === "instagram");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("api");
    expect(server.store.instagram_signals).toHaveLength(1);
    expect(server.store.instagram_signals[0].source_id).toBe(source?.id);
  });

  it("defaults limit to 25", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/instagram?q=phone");
    const body = (await res.json()) as InstagramBody;

    expect(res.status).toBe(200);
    expect(body.hashtag).toBe("phone");
    expect(body.limit).toBe(25);
  });

  it("propagates the limit query parameter", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/instagram?q=phone&limit=10");
    const body = (await res.json()) as InstagramBody;

    expect(res.status).toBe(200);
    expect(body.limit).toBe(10);
  });

  it("returns 400 MISSING_KEYWORD when q is absent", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/instagram");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("MISSING_KEYWORD");
    expect(server.requests).toHaveLength(0);
  });

  it("returns 400 with the validation code for an invalid limit", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/instagram?q=phone&limit=0");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_LIMIT");
  });

  it("returns 400 with the validation code for a keyword with no hashtag characters", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/instagram?q=%24%24%24");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_KEYWORD");
  });

  it("returns 502 with the provider's typed code when Instagram rate-limits the request", async () => {
    server = createMockPostgrest();

    const res = await get(
      server,
      "/api/market/instagram?q=phone",
      configuredEnv(),
      compositeFetch(server, { hashtagSearch: new Response("slow down", { status: 429 }) }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("returns 502 with RATE_LIMITED when the 30-hashtag/7-day Graph limit is hit", async () => {
    server = createMockPostgrest();

    const res = await get(
      server,
      "/api/market/instagram?q=phone",
      configuredEnv(),
      compositeFetch(server, { hashtagSearch: graphErrorResponse(613) }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("returns 502 with AUTH_ERROR when the Graph API rejects the token", async () => {
    server = createMockPostgrest();

    const res = await get(
      server,
      "/api/market/instagram?q=phone",
      configuredEnv(),
      compositeFetch(server, { hashtagSearch: graphErrorResponse(190) }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("AUTH_ERROR");
  });

  it("returns 502 INSTAGRAM_NOT_CONFIGURED when the access token is missing", async () => {
    server = createMockPostgrest();

    const res = await get(
      server,
      "/api/market/instagram?q=phone",
      configuredEnv({ INSTAGRAM_ACCESS_TOKEN: undefined }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("INSTAGRAM_NOT_CONFIGURED");
    expect(server.requests).toHaveLength(0);
  });

  it("returns 503 SUPABASE_NOT_CONFIGURED without touching the network", async () => {
    server = createMockPostgrest();
    const fetchMock = vi.fn(compositeFetch(server));
    vi.stubGlobal("fetch", fetchMock);

    const res = await routeRequest(
      new Request("https://worker.example/api/market/instagram?q=phone", { method: "GET" }),
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
      new Request("https://worker.example/api/market/instagram?q=phone", { method: "POST" }),
      configuredEnv(),
      ctx,
    );

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
    expect(server.requests).toHaveLength(0);
  });

  it("never leaks credentials into the response or request URLs", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/instagram?q=smart%20watch");
    const text = await res.text();

    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).not.toContain(IG_USER_ID);
    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${SECRET_KEY}`);
    }
  });
});
