import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../../src/env";
import { routeRequest } from "../../src/router";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SEARCH_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "reddit-search.json"), "utf8"),
) as Record<string, unknown>;

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const TOKEN = "test-access-token";

/** Minimal ExecutionContext with the waitUntil the reddit cache needs. */
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
    REDDIT_CLIENT_ID: CLIENT_ID,
    REDDIT_CLIENT_SECRET: CLIENT_SECRET,
    ...overrides,
  } as Env;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Routes reddit.com to fixtures and everything else to the PostgREST mock. */
function compositeFetch(
  server: MockPostgrest,
  opts: { token?: Response; search?: Response } = {},
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
    if (url.hostname === "www.reddit.com" && url.pathname === "/api/v1/access_token") {
      if (opts.token) return Promise.resolve(opts.token);
      return Promise.resolve(jsonResponse({ access_token: TOKEN, token_type: "bearer", expires_in: 3600 }));
    }
    if (url.hostname === "oauth.reddit.com" && url.pathname === "/search") {
      if (opts.search) return Promise.resolve(opts.search);
      return Promise.resolve(jsonResponse(SEARCH_FIXTURE));
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

interface RedditBody {
  status: string;
  source: string;
  provider: string;
  keyword: string;
  sort: string;
  timeFilter: string;
  limit: number | null;
  capturedAt: string;
  requested: number;
  persisted: number;
  created: number;
  updated: number;
  failed: number;
  signals: Array<{ keyword: string; mentions: number; totalScore: number; topSubreddit: string | null }>;
}

describe("GET /api/market/reddit", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("collects, persists and reports a Reddit signal for a keyword", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/reddit?q=smart%20watch");
    expect(res.status).toBe(200);

    const body = (await res.json()) as RedditBody;
    expect(body.status).toBe("ok");
    expect(body.source).toBe("reddit");
    expect(body.provider).toBe("official-api");
    expect(body.keyword).toBe("smart watch");
    expect(body.sort).toBe("relevance");
    expect(body.timeFilter).toBe("all");
    expect(body.limit).toBe(25);
    expect(body.requested).toBe(1);
    expect(body.persisted).toBe(1);
    expect(body.created).toBe(1);
    expect(body.updated).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]).toMatchObject({ keyword: "smart watch", mentions: 4, totalScore: 320, topSubreddit: "smartwatch" });
    expect(body.capturedAt).toBeTruthy();

    const source = server.store.sources.find((row) => row.slug === "reddit");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("api");
    expect(server.store.reddit_signals).toHaveLength(1);
    expect(server.store.reddit_signals[0].source_id).toBe(source?.id);
  });

  it("defaults sort to relevance, timeFilter to all and limit to 25", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/reddit?q=phone");
    const body = (await res.json()) as RedditBody;

    expect(res.status).toBe(200);
    expect(body.sort).toBe("relevance");
    expect(body.timeFilter).toBe("all");
    expect(body.limit).toBe(25);
  });

  it("propagates limit, sort and timeFilter query parameters", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/reddit?q=phone&limit=10&sort=top&timeFilter=week");
    const body = (await res.json()) as RedditBody;

    expect(res.status).toBe(200);
    expect(body.sort).toBe("top");
    expect(body.timeFilter).toBe("week");
    expect(body.limit).toBe(10);
  });

  it("returns 400 MISSING_KEYWORD when q is absent", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/reddit");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("MISSING_KEYWORD");
    expect(server.requests).toHaveLength(0);
  });

  it("returns 400 with the validation code for an invalid limit", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/reddit?q=phone&limit=0");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_LIMIT");
  });

  it("returns 400 with the validation code for an invalid sort", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/reddit?q=phone&sort=rising");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_SORT");
  });

  it("returns 400 with the validation code for an invalid timeFilter", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/reddit?q=phone&timeFilter=decade");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_TIME_FILTER");
  });

  it("returns 502 with the provider's typed code when Reddit rate-limits the request", async () => {
    server = createMockPostgrest();

    const res = await get(
      server,
      "/api/market/reddit?q=phone",
      configuredEnv(),
      compositeFetch(server, { search: new Response("slow down", { status: 429 }) }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("returns 502 REDDIT_NOT_CONFIGURED when Reddit credentials are missing", async () => {
    server = createMockPostgrest();

    const res = await get(
      server,
      "/api/market/reddit?q=phone",
      configuredEnv({ REDDIT_CLIENT_ID: undefined, REDDIT_CLIENT_SECRET: undefined }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("REDDIT_NOT_CONFIGURED");
    expect(server.requests).toHaveLength(0);
  });

  it("returns 503 SUPABASE_NOT_CONFIGURED without touching the network", async () => {
    server = createMockPostgrest();
    const fetchMock = vi.fn(compositeFetch(server));
    vi.stubGlobal("fetch", fetchMock);

    const res = await routeRequest(
      new Request("https://worker.example/api/market/reddit?q=phone", { method: "GET" }),
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
      new Request("https://worker.example/api/market/reddit?q=phone", { method: "POST" }),
      configuredEnv(),
      ctx,
    );

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
    expect(server.requests).toHaveLength(0);
  });

  it("never leaks credentials into the response or request URLs", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/reddit?q=smart%20watch");
    const text = await res.text();

    expect(text).not.toContain(SECRET_KEY);
    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${SECRET_KEY}`);
    }
  });
});
