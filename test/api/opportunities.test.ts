import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPPORTUNITY_RANKING_WINDOW } from "../../src/dashboard/assemble";
import type { Env } from "../../src/env";
import { routeRequest } from "../../src/router";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const ctx = {} as ExecutionContext;

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

async function get(path: string, env: Env = configuredEnv()): Promise<Response> {
  return routeRequest(new Request(`https://worker.example${path}`, { method: "GET" }), env, ctx);
}

async function head(path: string, env: Env = configuredEnv()): Promise<Response> {
  return routeRequest(new Request(`https://worker.example${path}`, { method: "HEAD" }), env, ctx);
}

function marketRow(productId: string, normalized: number, computedAt = "2026-08-18T10:00:00.000Z") {
  return {
    id: `s-${productId}`,
    product_id: productId,
    score_type: "market_opportunity",
    value: Math.round(normalized * 100),
    min_value: 0,
    max_value: 100,
    version: 1,
    computed_at: computedAt,
    inputs: {
      score_type: "market_opportunity",
      version: 1,
      normalized,
      signals: [
        {
          key: "competition_pressure",
          label: "Competition",
          weight: 1,
          value: normalized,
          present: true,
          contribution: normalized,
        },
      ],
    },
  };
}

function productRow(overrides: {
  id: string;
  title?: string;
  last_seen_at: string;
  lifecycle_status?: string;
  brand?: string;
}) {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    brand: overrides.brand ?? "Brand",
    last_seen_at: overrides.last_seen_at,
    lifecycle_status: overrides.lifecycle_status ?? "active",
    availability_status: "in_stock",
    primary_image_url: "https://img.example.com/a.jpg",
    canonical_url: `https://www.aliexpress.com/item/${overrides.id}.html`,
  };
}

describe("GET /api/opportunities", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns an empty list when no products exist", async () => {
    const res = await get("/api/opportunities");
    const body = (await res.json()) as { status: string; products: unknown[]; page: { total: number } };
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.products).toEqual([]);
    expect(body.page).toEqual({ limit: 20, offset: 0, total: 0 });
    expect(server.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("ranks by decision_opportunity normalized DESC, not last_seen_at", async () => {
    server.seed("products", [
      productRow({ id: "p-new-low", title: "New Low", last_seen_at: "2026-08-18T12:00:00.000Z" }),
      productRow({ id: "p-old-high", title: "Old High", last_seen_at: "2026-01-01T00:00:00.000Z" }),
    ]);
    server.seed("scores", [marketRow("p-new-low", 0.3), marketRow("p-old-high", 0.9)]);

    const res = await get("/api/opportunities");
    const body = (await res.json()) as {
      products: Array<{ id: string; decision: { score: { scoreType: string; version: number; normalized: number } } }>;
      page: { total: number };
    };
    expect(body.products.map((row) => row.id)).toEqual(["p-old-high", "p-new-low"]);
    expect(body.products[0].decision.score.scoreType).toBe("decision_opportunity");
    expect(body.products[0].decision.score.version).toBe(1);
    expect(body.page.total).toBe(2);
  });

  it("ranks before pagination and sets page.total to the eligible ranked count", async () => {
    server.seed("products", [
      productRow({ id: "p-a", last_seen_at: "2026-08-18T12:00:00.000Z" }),
      productRow({ id: "p-b", last_seen_at: "2026-08-18T11:00:00.000Z" }),
      productRow({ id: "p-c", last_seen_at: "2026-08-18T10:00:00.000Z" }),
    ]);
    server.seed("scores", [marketRow("p-a", 0.2), marketRow("p-b", 0.9), marketRow("p-c", 0.5)]);

    const res = await get("/api/opportunities?limit=1");
    const body = (await res.json()) as { products: Array<{ id: string }>; page: { limit: number; offset: number; total: number } };
    expect(body.products.map((row) => row.id)).toEqual(["p-b"]);
    expect(body.page).toEqual({ limit: 1, offset: 0, total: 3 });
  });

  it("excludes unknown and all-unknown windows yield empty results", async () => {
    server.seed("products", [
      productRow({ id: "p-ok", last_seen_at: "2026-08-18T12:00:00.000Z" }),
      productRow({ id: "p-unknown", last_seen_at: "2026-08-18T11:00:00.000Z" }),
    ]);
    server.seed("scores", [marketRow("p-ok", 0.4)]);

    const mixed = (await (await get("/api/opportunities")).json()) as { products: Array<{ id: string }>; page: { total: number } };
    expect(mixed.products.map((row) => row.id)).toEqual(["p-ok"]);
    expect(mixed.page.total).toBe(1);

    server.store.products.length = 0;
    server.store.scores.length = 0;
    server.seed("products", [productRow({ id: "p-none", last_seen_at: "2026-08-18T10:00:00.000Z" })]);
    const allUnknown = (await (await get("/api/opportunities")).json()) as { products: unknown[]; page: { total: number } };
    expect(allUnknown.products).toEqual([]);
    expect(allUnknown.page.total).toBe(0);
  });

  it("ignores wrong-product country evidence so P5.24 rules still apply", async () => {
    server.seed("products", [productRow({ id: "p-1", last_seen_at: "2026-08-18T10:00:00.000Z" })]);
    server.seed("country_opportunity_scores", [
      {
        id: "c-wrong",
        product_id: "other-product",
        country: "SA",
        keyword: "earbuds",
        score_type: "country_opportunity",
        value: 99,
        min_value: 0,
        max_value: 100,
        normalized: 0.99,
        total_weight: 0.6,
        tier: "high",
        version: 1,
        inputs: { score_type: "country_opportunity", version: 1, normalized: 0.99, signals: [] },
        country_latest_value: 99,
        country_change: 10,
        country_direction: "up",
      },
    ]);
    const body = (await (await get("/api/opportunities")).json()) as { products: unknown[]; page: { total: number } };
    expect(body.products).toEqual([]);
    expect(body.page.total).toBe(0);
  });

  it("filters by lifecycle and title search in the read path", async () => {
    server.seed("products", [
      productRow({ id: "p-1", title: "Wireless Earbuds", last_seen_at: "2026-08-18T12:00:00.000Z", lifecycle_status: "active" }),
      productRow({ id: "p-2", title: "Wireless Speaker", last_seen_at: "2026-08-18T11:00:00.000Z", lifecycle_status: "archived" }),
      productRow({ id: "p-3", title: "Wired Headphones", last_seen_at: "2026-08-18T10:00:00.000Z", lifecycle_status: "active" }),
    ]);
    server.seed("scores", [marketRow("p-1", 0.4), marketRow("p-2", 0.9), marketRow("p-3", 0.7)]);

    const lifecycle = (await (await get("/api/opportunities?lifecycle=active")).json()) as { products: Array<{ id: string }>; page: { total: number } };
    expect(lifecycle.products.map((row) => row.id)).toEqual(["p-3", "p-1"]);
    expect(lifecycle.page.total).toBe(2);

    const search = (await (await get("/api/opportunities?q=Wireless")).json()) as { products: Array<{ id: string }>; page: { total: number } };
    expect(search.products.map((row) => row.id)).toEqual(["p-2", "p-1"]);
    expect(search.page.total).toBe(2);
  });

  it("reads only the 200 most recently seen matching products before ranking", async () => {
    const products = [];
    const scores = [];
    for (let i = 0; i < OPPORTUNITY_RANKING_WINDOW + 1; i += 1) {
      const id = `p-${String(i).padStart(3, "0")}`;
      products.push(
        productRow({
          id,
          last_seen_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
      scores.push(marketRow(id, i === 0 ? 0.99 : 0.1));
    }
    server.seed("products", products);
    server.seed("scores", scores);

    const body = (await (await get("/api/opportunities?limit=1")).json()) as { products: Array<{ id: string }>; page: { total: number } };
    expect(body.products[0].id).toBe("p-200");
    expect(body.products[0].id).not.toBe("p-000");
    expect(body.page.total).toBe(OPPORTUNITY_RANKING_WINDOW);
    const productReads = server.requests.filter((request) => request.url.includes("/rest/v1/products"));
    expect(productReads.some((request) => {
      const url = new URL(request.url);
      return url.searchParams.get("offset") === "0" && url.searchParams.get("limit") === String(OPPORTUNITY_RANKING_WINDOW);
    })).toBe(true);
  });

  it("returns 400 for invalid query params", async () => {
    expect((await get("/api/opportunities?limit=0")).status).toBe(400);
    expect(((await (await get("/api/opportunities?limit=0")).json()) as { code: string }).code).toBe("INVALID_LIMIT");
    expect(((await (await get("/api/opportunities?offset=-1")).json()) as { code: string }).code).toBe("INVALID_OFFSET");
    expect(((await (await get("/api/opportunities?lifecycle=hot")).json()) as { code: string }).code).toBe("INVALID_LIFECYCLE");
  });

  it("returns 503 when Supabase is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await get("/api/opportunities", {} as Env);
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(503);
    expect(body.code).toBe("SUPABASE_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the product list read fails", async () => {
    server.override("GET", "/rest/v1/products", 500, { message: "db down" });
    const res = await get("/api/opportunities");
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(502);
    expect(body.code).toBe("product_list_failed");
  });

  it("never writes and never leaks credentials", async () => {
    const res = await get("/api/opportunities");
    const text = await res.text();
    expect(text).not.toContain(SECRET_KEY);
    expect(server.requests.every((request) => request.method === "GET")).toBe(true);
    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
    }
  });
});

describe("HEAD /api/opportunities", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the same GET handler behavior", async () => {
    server.seed("products", [productRow({ id: "p-1", last_seen_at: "2026-08-18T10:00:00.000Z" })]);
    server.seed("scores", [marketRow("p-1", 0.4)]);
    const res = await head("/api/opportunities");
    expect(res.status).toBe(200);
    expect(server.requests.every((request) => request.method === "GET")).toBe(true);
  });
});

describe("GET /opportunities HTML", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the empty state", async () => {
    const res = await get("/opportunities");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Top Opportunities");
    expect(html).toContain("No ranked opportunities.");
  });

  it("renders ranked compact product cards", async () => {
    server.seed("products", [
      productRow({ id: "p-low", title: "Low Score", last_seen_at: "2026-08-18T12:00:00.000Z" }),
      productRow({ id: "p-high", title: "High Score", last_seen_at: "2026-08-18T10:00:00.000Z" }),
    ]);
    server.seed("scores", [marketRow("p-low", 0.2), marketRow("p-high", 0.9)]);
    const html = await (await get("/opportunities")).text();
    expect(html.indexOf("High Score")).toBeLessThan(html.indexOf("Low Score"));
    expect(html).toContain("Score 90 (high)");
    expect(html).not.toMatch(/WORLD|facebook|pinterest|social/i);
  });

  it("escapes user/product text in HTML", async () => {
    server.seed("products", [
      productRow({
        id: "p-xss",
        title: `<script>alert(1)</script>`,
        brand: `"><img src=x onerror=alert(2)>`,
        last_seen_at: "2026-08-18T10:00:00.000Z",
      }),
    ]);
    server.seed("scores", [marketRow("p-xss", 0.4)]);
    const html = await (await get("/opportunities")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(2)&gt;");
    expect(html).not.toContain(`"><img src=x onerror=alert(2)>`);
  });

  it("escapes query text in the filter form", async () => {
    const html = await (await get("/opportunities?q=%3Cscript%3Ealert(1)%3C/script%3E")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders the error state", async () => {
    server.override("GET", "/rest/v1/products", 500, { message: "db down" });
    const html = await (await get("/opportunities")).text();
    expect(html).toContain("Unable to load opportunities.");
    expect(html).toContain("product_list_failed");
  });

  it("renders the unconfigured state without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await get("/opportunities", {} as Env);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Supabase is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("P6.26 /api/products remains last_seen_at DESC", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not score-sort the discovery list", async () => {
    server.seed("products", [
      productRow({ id: "p-new-low", last_seen_at: "2026-08-18T12:00:00.000Z" }),
      productRow({ id: "p-old-high", last_seen_at: "2026-01-01T00:00:00.000Z" }),
    ]);
    server.seed("scores", [marketRow("p-new-low", 0.2), marketRow("p-old-high", 0.9)]);

    const products = (await (await get("/api/products")).json()) as { products: Array<{ id: string }> };
    const opportunities = (await (await get("/api/opportunities")).json()) as { products: Array<{ id: string }> };
    expect(products.products.map((row) => row.id)).toEqual(["p-new-low", "p-old-high"]);
    expect(opportunities.products.map((row) => row.id)).toEqual(["p-old-high", "p-new-low"]);
  });
});
