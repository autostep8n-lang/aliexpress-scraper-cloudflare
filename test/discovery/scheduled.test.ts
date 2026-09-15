import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import {
  DAILY_DISCOVERY_LIMIT,
  DAILY_DISCOVERY_QUERY,
  runDailyDiscovery,
  runScheduledAutomation,
} from "../../src/discovery/scheduled";
import { isTiktokHost } from "../../src/scrapers/tiktok";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const CRON = "0 0 * * *";

const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext;

function searchItem(id: string): Record<string, unknown> {
  return {
    productId: id,
    title: `Product ${id}`,
    price: 19.99,
    salePrice: 14.99,
    currency: "USD",
    images: [{ url: `https://p16-sign-sg.tiktokcdn.com/obj/${id}.jpg` }],
    sellerId: `seller-${id}`,
    sellerName: `Store ${id}`,
    sales: 120,
    itemAvailable: true,
  };
}

function searchPageHtml(items: Record<string, unknown>[]): string {
  const payload = {
    __DEFAULT_SCOPE__: {
      "webapp.search-layout": {
        searchData: {
          data: { items, total: items.length },
        },
      },
    },
  };
  return `<!doctype html><html><head>
    <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script>
  </head><body></body></html>`;
}

function compositeFetch(server: MockPostgrest, html: string): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
    if (isTiktokHost(url.hostname)) {
      return Promise.resolve(new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
    }
    return server.fetch(input, init);
  };
}

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function scheduledController(): ScheduledController {
  return {
    cron: CRON,
    scheduledTime: Date.UTC(2026, 8, 14, 0, 0, 0),
    noRetry: () => undefined,
  };
}

describe("runDailyDiscovery", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("discovers and persists TikTok products with the fixed daily query", async () => {
    server = createMockPostgrest();
    let requestedUrl: URL | undefined;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL((input as Request).url);
      if (isTiktokHost(url.hostname)) {
        requestedUrl = url;
        return Promise.resolve(
          new Response(searchPageHtml([searchItem("111"), searchItem("222")]), {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        );
      }
      return server.fetch(input, init);
    });

    const result = await runDailyDiscovery(configuredEnv(), ctx, scheduledController());

    expect(DAILY_DISCOVERY_QUERY).toBe("earbuds");
    expect(result).toMatchObject({
      status: "ok",
      platform: "tiktok-shop",
      query: "earbuds",
      region: null,
      limit: DAILY_DISCOVERY_LIMIT,
      discovered: 2,
      persisted: 2,
      created: 2,
      updated: 0,
      failed: 0,
    });
    expect(requestedUrl?.searchParams.get("q")).toBe("earbuds");
    expect(requestedUrl?.searchParams.has("region")).toBe(false);
    expect(server.store.sources.map((row) => row.slug)).toContain("tiktok-shop");
    expect(server.store.products).toHaveLength(2);
    expect(server.store.product_sources).toHaveLength(2);
  });

  it("refreshes existing products on a repeat run", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([searchItem("111")])));

    const first = await runDailyDiscovery(configuredEnv(), ctx, scheduledController());
    const second = await runDailyDiscovery(configuredEnv(), ctx, scheduledController());

    expect(first).toMatchObject({ status: "ok", created: 1, updated: 0, persisted: 1 });
    expect(second).toMatchObject({ status: "ok", created: 0, updated: 1, persisted: 1 });
    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources).toHaveLength(1);
  });

  it("returns a typed error when the platform blocks the request", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, "<html><body>Captcha required to continue.</body></html>"));

    const result = await runDailyDiscovery(configuredEnv(), ctx, scheduledController());

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.code).toBe("BLOCKED");
    expect(server.store.products).toHaveLength(0);
  });

  it("skips the run when Supabase bindings are missing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runDailyDiscovery({} as Env, ctx, scheduledController());

    expect(result).toMatchObject({
      status: "skipped",
      code: "SUPABASE_NOT_CONFIGURED",
      query: DAILY_DISCOVERY_QUERY,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Worker scheduled handler", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("invokes daily discovery from the Worker scheduled export", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([searchItem("111")])));

    await worker.scheduled!(scheduledController(), configuredEnv(), ctx);

    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources.map((row) => row.external_id)).toEqual(["111"]);
  });
});

describe("runScheduledAutomation (P7.29 + P7.30)", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("runs automated scoring after a successful discovery and logs a scoring summary", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([searchItem("111")])));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await runScheduledAutomation(configuredEnv(), ctx, scheduledController());

    expect(result.discovery.status).toBe("ok");
    expect(result.scoring).not.toBeNull();
    expect(result.scoring).toMatchObject({ status: "ok" });

    const scoringLog = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .find((entry) => entry.event === "scheduled.scoring");
    expect(scoringLog).toBeDefined();
    expect(scoringLog).toMatchObject({
      level: "info",
      total: expect.any(Number),
      scored: expect.any(Number),
      skipped: expect.any(Number),
      failed: expect.any(Number),
      persisted: expect.any(Number),
      durationMs: expect.any(Number),
    });
  });

  it("does not run scoring when discovery fails", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, "<html><body>Captcha required to continue.</body></html>"));

    const result = await runScheduledAutomation(configuredEnv(), ctx, scheduledController());

    expect(result.discovery.status).toBe("error");
    expect(result.scoring).toBeNull();
    expect(server.store.products).toHaveLength(0);
  });

  it("does not erase successful discovery when scoring fails", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([searchItem("111")])));
    server.override("GET", "/rest/v1/product_sources", 500, { message: "storage down" });

    const result = await runScheduledAutomation(configuredEnv(), ctx, scheduledController());

    expect(result.discovery.status).toBe("ok");
    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources).toHaveLength(1);
    expect(result.scoring).not.toBeNull();
    expect(result.scoring?.failed).toBeGreaterThanOrEqual(1);
  });

  it("skips both discovery and scoring when Supabase is not configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runScheduledAutomation({} as Env, ctx, scheduledController());

    expect(result.discovery.status).toBe("skipped");
    expect(result.scoring).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
