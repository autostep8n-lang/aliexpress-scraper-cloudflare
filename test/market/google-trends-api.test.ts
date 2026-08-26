import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../../src/env";
import { routeRequest } from "../../src/router";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const EXPLORE_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "google-trends-explore.json"), "utf8"),
) as Record<string, unknown>;
const MULTILINE_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "google-trends-multiline.json"), "utf8"),
) as Record<string, unknown>;

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

/** Minimal ExecutionContext with the waitUntil the trends cache needs. */
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
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY, ...overrides } as Env;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Routes trends.google.com to fixtures and everything else to the PostgREST mock. */
function compositeFetch(
  server: MockPostgrest,
  opts: { explore?: Response; multiline?: Response } = {},
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
    if (url.hostname === "trends.google.com" && url.pathname === "/trends/api/explore") {
      if (opts.explore) return Promise.resolve(opts.explore);
      return Promise.resolve(jsonResponse(EXPLORE_FIXTURE));
    }
    if (url.hostname === "trends.google.com" && url.pathname === "/trends/api/widgetdata/multiline") {
      if (opts.multiline) return Promise.resolve(opts.multiline);
      return Promise.resolve(jsonResponse(MULTILINE_FIXTURE));
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

interface TrendsBody {
  status: string;
  source: string;
  provider: string;
  keyword: string;
  geo: string;
  timeRange: string;
  property: string;
  category: number | null;
  capturedAt: string;
  requested: number;
  persisted: number;
  created: number;
  updated: number;
  failed: number;
  signals: Array<{ keyword: string; geo: string; value: number; periodStart: string }>;
}

describe("GET /api/market/google-trends", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("collects, persists and reports Google Trends signals for a keyword", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/google-trends?q=smart%20watch&geo=US");
    expect(res.status).toBe(200);

    const body = (await res.json()) as TrendsBody;
    expect(body.status).toBe("ok");
    expect(body.source).toBe("google-trends");
    expect(body.provider).toBe("internal-api");
    expect(body.keyword).toBe("smart watch");
    expect(body.geo).toBe("US");
    expect(body.timeRange).toBe("today 5-y");
    expect(body.property).toBe("web");
    expect(body.category).toBeNull();
    expect(body.requested).toBe(5);
    expect(body.persisted).toBe(5);
    expect(body.created).toBe(5);
    expect(body.updated).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.signals).toHaveLength(5);
    expect(body.signals[0]).toMatchObject({ keyword: "smart watch", geo: "US", value: 100 });
    expect(body.capturedAt).toBeTruthy();

    const source = server.store.sources.find((row) => row.slug === "google-trends");
    expect(source).toBeDefined();
    expect(source?.kind).toBe("api");
    expect(server.store.google_trends).toHaveLength(5);
    expect(server.store.google_trends[0].source_id).toBe(source?.id);
  });

  it("defaults geo to WORLD, property to web and the time range to today 5-y", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/google-trends?q=phone");
    const body = (await res.json()) as TrendsBody;

    expect(res.status).toBe(200);
    expect(body.geo).toBe("WORLD");
    expect(body.property).toBe("web");
    expect(body.timeRange).toBe("today 5-y");
    expect(body.category).toBeNull();
  });

  it("propagates geo, timeRange, property and category query parameters", async () => {
    server = createMockPostgrest();

    const res = await get(
      server,
      "/api/market/google-trends?q=phone&geo=GB-SCT&timeRange=now%207-d&property=youtube&category=5",
    );
    const body = (await res.json()) as TrendsBody;

    expect(res.status).toBe(200);
    expect(body.geo).toBe("GB-SCT");
    expect(body.timeRange).toBe("now 7-d");
    expect(body.property).toBe("youtube");
    expect(body.category).toBe(5);
  });

  it("returns 200 with persisted=0 when the timeline is empty", async () => {
    server = createMockPostgrest();
    const fetchMock = compositeFetch(server, {
      multiline: jsonResponse({ default: { resolution: "MONTH", timelineData: [] } }),
    });

    const res = await get(server, "/api/market/google-trends?q=rare-keyword", configuredEnv(), fetchMock);
    const body = (await res.json()) as TrendsBody;

    expect(res.status).toBe(200);
    expect(body.requested).toBe(0);
    expect(body.persisted).toBe(0);
    expect(body.created).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.signals).toHaveLength(0);
  });

  it("returns 400 MISSING_KEYWORD when q is absent", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/google-trends");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("MISSING_KEYWORD");
    expect(server.requests).toHaveLength(0);
  });

  it("returns 400 with the validation code for an invalid geo", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/google-trends?q=phone&geo=usa");
    const body = (await res.json()) as { code: string; error: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_GEO");
    expect(body.error).toContain("usa");
  });

  it("returns 400 with the validation code for an invalid timeRange", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/google-trends?q=phone&timeRange=last%20week");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_TIME_RANGE");
  });

  it("returns 400 with the validation code for an unknown property", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/google-trends?q=phone&property=podcast");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_PROPERTY");
  });

  it("returns 502 with the provider's typed code when Google Trends rate-limits the request", async () => {
    server = createMockPostgrest();

    const res = await get(
      server,
      "/api/market/google-trends?q=phone",
      configuredEnv(),
      compositeFetch(server, { explore: new Response("rate limited", { status: 429 }) }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("returns 502 with the provider's typed code on a provider HTTP error", async () => {
    server = createMockPostgrest();

    const res = await get(
      server,
      "/api/market/google-trends?q=phone",
      configuredEnv(),
      compositeFetch(server, { explore: new Response("nope", { status: 500 }) }),
    );
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("HTTP_ERROR");
  });

  it("returns 503 SUPABASE_NOT_CONFIGURED without touching the network", async () => {
    server = createMockPostgrest();
    const fetchMock = vi.fn(compositeFetch(server));
    vi.stubGlobal("fetch", fetchMock);

    const res = await routeRequest(
      new Request("https://worker.example/api/market/google-trends?q=phone", { method: "GET" }),
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
      new Request("https://worker.example/api/market/google-trends?q=phone", { method: "POST" }),
      configuredEnv(),
      ctx,
    );

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
    expect(server.requests).toHaveLength(0);
  });

  it("never leaks credentials into the response or request URLs", async () => {
    server = createMockPostgrest();

    const res = await get(server, "/api/market/google-trends?q=smart%20watch");
    const text = await res.text();

    expect(text).not.toContain(SECRET_KEY);
    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${SECRET_KEY}`);
    }
  });
});
