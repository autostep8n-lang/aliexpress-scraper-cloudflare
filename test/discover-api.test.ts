import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { routeRequest } from "../src/router";
import { isTiktokHost } from "../src/scrapers/tiktok";
import { createMockPostgrest, type MockPostgrest } from "./helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

const ctx = {} as ExecutionContext;

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

async function get(path: string, requestEnv: Env = configuredEnv()): Promise<Response> {
  return routeRequest(new Request(`https://worker.example${path}`, { method: "GET" }), requestEnv, ctx);
}

describe("GET /api/discover (tiktok-shop discovery pipeline)", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("discovers and persists products, reporting created counts", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([searchItem("111"), searchItem("222")])));

    const res = await get("/api/discover?q=earbuds");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      platform: string;
      query: string;
      discovered: number;
      persisted: number;
      created: number;
      updated: number;
      failed: number;
      products: Array<{ url: string; title: string; externalId: string; persisted: { status: string } }>;
    };
    expect(body.status).toBe("ok");
    expect(body.platform).toBe("tiktok-shop");
    expect(body.query).toBe("earbuds");
    expect(body.discovered).toBe(2);
    expect(body.persisted).toBe(2);
    expect(body.created).toBe(2);
    expect(body.updated).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.products).toHaveLength(2);
    expect(body.products[0]).toMatchObject({
      url: "https://www.tiktok.com/@shop/product/111",
      title: "Product 111",
      externalId: "111",
      persisted: { status: "created" },
    });

    expect(server.store.sources.map((row) => row.slug)).toContain("tiktok-shop");
    expect(server.store.products).toHaveLength(2);
    expect(server.store.product_sources).toHaveLength(2);
  });

  it("honors region and limit parameters", async () => {
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
        return Promise.resolve(new Response(searchPageHtml([searchItem("111"), searchItem("222"), searchItem("333")]), { status: 200 }));
      }
      return server.fetch(input, init);
    });

    const res = await get("/api/discover?q=earbuds&region=gb&limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { region: string; discovered: number; persisted: number };
    expect(body.region).toBe("GB");
    expect(body.discovered).toBe(3);
    expect(body.persisted).toBe(2);
    expect(requestedUrl?.searchParams.get("region")).toBe("GB");
  });

  it("reports updated counts on a repeat discovery", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([searchItem("111")])));

    await get("/api/discover?q=earbuds");
    const res = await get("/api/discover?q=earbuds");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; updated: number; persisted: number };
    expect(body.created).toBe(0);
    expect(body.updated).toBe(1);
    expect(body.persisted).toBe(1);
  });

  it("returns 400 MISSING_QUERY when neither q nor category is given", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([])));

    const res = await get("/api/discover");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("MISSING_QUERY");
  });

  it("allows category-only discovery", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([searchItem("111")])));

    const res = await get("/api/discover?category=c42");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { category: string };
    expect(body.category).toBe("c42");
  });

  it("returns 400 INVALID_LIMIT for a non-positive limit", async () => {
    server = createMockPostgrest();

    const zero = await get("/api/discover?q=earbuds&limit=0");
    expect(zero.status).toBe(400);
    expect(((await zero.json()) as { code: string }).code).toBe("INVALID_LIMIT");

    const nonNumeric = await get("/api/discover?q=earbuds&limit=abc");
    expect(nonNumeric.status).toBe(400);
    expect(((await nonNumeric.json()) as { code: string }).code).toBe("INVALID_LIMIT");
  });

  it("returns 503 SUPABASE_NOT_CONFIGURED when supabase bindings are missing", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, searchPageHtml([searchItem("111")])));

    const res = await get("/api/discover?q=earbuds", {} as Env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SUPABASE_NOT_CONFIGURED");
  });

  it("returns 502 with the typed code when the platform blocks the request", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, "<html><body>Captcha required to continue.</body></html>"));

    const res = await get("/api/discover?q=earbuds");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BLOCKED");
  });

  it("returns 502 NO_PRODUCT_DATA when the page has no search data", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", compositeFetch(server, "<html><body>empty app shell</body></html>"));

    const res = await get("/api/discover?q=earbuds");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NO_PRODUCT_DATA");
  });
});
