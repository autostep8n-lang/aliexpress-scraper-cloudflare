import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { tiktokDiscovery } from "../../src/discovery/tiktok";
import { isTiktokHost } from "../../src/scrapers/tiktok";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

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

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY, ...overrides } as Env;
}

function browserEnv(quickAction: (action: string, options: unknown) => Promise<Response>): Env {
  return configuredEnv({ BROWSER: { quickAction } as unknown as NonNullable<Env["BROWSER"]> });
}

function contentResponse(result: string): Response {
  return new Response(JSON.stringify({ success: true, result, meta: { status: 200, title: "x" } }), { status: 200 });
}

describe("tiktokDiscovery.discover", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("discovers, normalizes, and persists products from a search page", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([searchItem("111"), searchItem("222"), searchItem("333")])));

    const result = await tiktokDiscovery.discover({ query: "earbuds", limit: 20 }, configuredEnv(), ctx);

    expect(result.platform).toBe("tiktok-shop");
    expect(result.query).toBe("earbuds");
    expect(result.requested).toBe(20);
    expect(result.discovered).toBe(3);
    expect(result.persisted).toBe(3);
    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.products).toHaveLength(3);

    const first = result.products[0];
    expect(first.product?.platform).toBe("tiktok-shop");
    expect(first.product?.externalId).toBe("111");
    expect(first.product?.url).toBe("https://www.tiktok.com/@shop/product/111");
    expect(first.product?.title).toBe("Product 111");
    expect(first.product?.price).toEqual({ amount: 14.99, currency: "USD" });
    expect(first.persisted.status).toBe("created");

    expect(server.store.sources.map((row) => row.slug)).toContain("tiktok-shop");
    expect(server.store.products).toHaveLength(3);
    expect(server.store.product_sources).toHaveLength(3);
    expect(server.store.product_sources.map((row) => row.external_id).sort()).toEqual(["111", "222", "333"]);
    expect(server.store.product_sources[0].attributes).toMatchObject({ sellerName: "Store 111", sales: "120" });
  });

  it("honors the limit and only persists that many products", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([searchItem("111"), searchItem("222"), searchItem("333")])));

    const result = await tiktokDiscovery.discover({ query: "earbuds", limit: 2 }, configuredEnv(), ctx);

    expect(result.discovered).toBe(3);
    expect(result.persisted).toBe(2);
    expect(result.created).toBe(2);
    expect(result.products).toHaveLength(2);
    expect(server.store.product_sources).toHaveLength(2);
  });

  it("re-persists the same products as updates on a repeat run", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([searchItem("111")])));

    const first = await tiktokDiscovery.discover({ query: "earbuds", limit: 20 }, configuredEnv(), ctx);
    const second = await tiktokDiscovery.discover({ query: "earbuds", limit: 20 }, configuredEnv(), ctx);

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources).toHaveLength(1);
  });

  it("passes category and region through to the search url", async () => {
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
        return Promise.resolve(new Response(searchPageHtml([searchItem("111")]), { status: 200 }));
      }
      return server.fetch(input, init);
    });

    await tiktokDiscovery.discover({ query: "earbuds", category: "c42", region: "GB", limit: 20 }, configuredEnv(), ctx);

    expect(requestedUrl?.pathname).toBe("/search");
    expect(requestedUrl?.searchParams.get("q")).toBe("earbuds");
    expect(requestedUrl?.searchParams.get("category_id")).toBe("c42");
    expect(requestedUrl?.searchParams.get("region")).toBe("GB");
  });

  it("returns an empty result when the search page has no products", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([])));

    const result = await tiktokDiscovery.discover({ query: "nothing", limit: 20 }, configuredEnv(), ctx);

    expect(result.discovered).toBe(0);
    expect(result.persisted).toBe(0);
    expect(result.products).toEqual([]);
    expect(server.store.product_sources).toHaveLength(0);
  });

  it("recovers a BLOCKED search page via the BROWSER binding", async () => {
    server = createMockPostgrest();
    const quickAction = vi.fn(async (_action: string, _options: unknown) => contentResponse(searchPageHtml([searchItem("111")])));
    vi.stubGlobal("fetch", compositeFetch(server, "<html><body>Please verify you are human.</body></html>"));

    const result = await tiktokDiscovery.discover({ query: "earbuds", limit: 20 }, browserEnv(quickAction), ctx);

    expect(quickAction).toHaveBeenCalledTimes(1);
    expect(quickAction).toHaveBeenCalledWith("content", expect.objectContaining({ url: expect.stringContaining("search") }));
    expect(result.created).toBe(1);
  });

  it("throws BLOCKED when the page is blocked and no BROWSER binding exists", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, "<html><body>Captcha required to continue.</body></html>"));

    const promise = tiktokDiscovery.discover({ query: "earbuds", limit: 20 }, configuredEnv(), ctx);
    await expect(promise).rejects.toMatchObject({ code: "BLOCKED" });
  });

  it("counts failures when products cannot be persisted", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([searchItem("111")])));

    const result = await tiktokDiscovery.discover({ query: "earbuds", limit: 20 }, {} as Env, ctx);

    expect(result.persisted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.products[0].persisted.status).toBe("credentials_missing");
  });

  it("serves repeat discovery from the SCRAPE_CACHE without refetching", async () => {
    server = createMockPostgrest();
    const store = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string): Promise<string | null> => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string): Promise<void> => {
        store.set(key, value);
      }),
    } as unknown as KVNamespace;

    let fetches = 0;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL((input as Request).url);
      if (isTiktokHost(url.hostname)) {
        fetches++;
        return Promise.resolve(new Response(searchPageHtml([searchItem("111")]), { status: 200 }));
      }
      return server.fetch(input, init);
    });

    const env = configuredEnv({ SCRAPE_CACHE: cache });
    await tiktokDiscovery.discover({ query: "earbuds", limit: 20 }, env, ctx);
    await tiktokDiscovery.discover({ query: "earbuds", limit: 20 }, env, ctx);

    expect(fetches).toBe(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(server.store.product_sources).toHaveLength(1);
  });
});
