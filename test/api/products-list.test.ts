import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("GET /api/products", () => {
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
    const res = await get("/api/products");
    const body = (await res.json()) as { status: string; products: unknown[]; page: { total: number } };
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.products).toEqual([]);
    expect(body.page).toEqual({ limit: 20, offset: 0, total: 0 });
    expect(server.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("lists products with compact on-read P5.24/P5.25 decision fields", async () => {
    server.seed("products", [
      {
        id: "p-1",
        title: "Wireless Earbuds",
        brand: "SoundCore",
        primary_image_url: "https://img.example.com/a.jpg",
        canonical_url: "https://www.aliexpress.com/item/1.html",
        availability_status: "in_stock",
        lifecycle_status: "active",
        last_seen_at: "2026-08-18T10:00:00.000Z",
      },
    ]);
    server.seed("scores", [
      {
        id: "s-1",
        product_id: "p-1",
        score_type: "market_opportunity",
        value: 40,
        min_value: 0,
        max_value: 100,
        version: 1,
        computed_at: "2026-08-18T10:00:00.000Z",
        inputs: {
          score_type: "market_opportunity",
          version: 1,
          normalized: 0.4,
          signals: [{ key: "competition_pressure", label: "Competition", weight: 1, value: 0.4, present: true, contribution: 0.4 }],
        },
      },
    ]);
    server.seed("country_opportunity_scores", [
      {
        id: "c-1",
        product_id: "p-1",
        country: "SA",
        keyword: "earbuds",
        score_type: "country_opportunity",
        value: 80,
        min_value: 0,
        max_value: 100,
        normalized: 0.8,
        total_weight: 0.6,
        tier: "high",
        version: 1,
        inputs: {
          score_type: "country_opportunity",
          version: 1,
          normalized: 0.8,
          signals: [{ key: "country_search_level", label: "Country search", weight: 0.4, value: 0.8, present: true, contribution: 0.32 }],
        },
        country_latest_value: 80,
        country_change: 40,
        country_direction: "up",
      },
    ]);

    const res = await get("/api/products");
    const body = (await res.json()) as {
      status: string;
      products: Array<{
        id: string;
        title: string;
        decision: { provider: string; score: { value: number; tier: string }; selectedCountry: string | null; summary: string; caveats: string[] };
      }>;
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.products).toHaveLength(1);
    expect(body.products[0].id).toBe("p-1");
    expect(body.products[0].title).toBe("Wireless Earbuds");
    expect(body.products[0].decision.provider).toBe("template");
    expect(body.products[0].decision.score.value).toBe(60);
    expect(body.products[0].decision.score.tier).toBe("medium");
    expect(body.products[0].decision.selectedCountry).toBe("SA");
    expect(body.products[0].decision.caveats).toEqual([]);
    expect(body.products[0].decision.summary).toContain("Decision opportunity score 60 (medium)");
    expect(JSON.stringify(body)).not.toMatch(/WORLD|facebook|pinterest|social/i);
    expect(body.products[0]).not.toHaveProperty("evidence");
    expect(server.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("returns unknown + caveats when scores are missing", async () => {
    server.seed("products", [
      {
        id: "p-1",
        title: "Bare Product",
        last_seen_at: "2026-08-18T10:00:00.000Z",
        lifecycle_status: "discovered",
      },
    ]);
    const res = await get("/api/products");
    const body = (await res.json()) as { products: Array<{ decision: { score: { tier: string; value: number }; caveats: string[] } }> };
    expect(body.products[0].decision.score.tier).toBe("unknown");
    expect(body.products[0].decision.score.value).toBe(0);
    expect(body.products[0].decision.caveats).toEqual([
      "product market opportunity is missing",
      "country opportunity is missing",
    ]);
  });

  it("returns 400 for invalid query params", async () => {
    expect((await get("/api/products?limit=0")).status).toBe(400);
    expect(((await (await get("/api/products?limit=0")).json()) as { code: string }).code).toBe("INVALID_LIMIT");
    expect(((await (await get("/api/products?offset=-1")).json()) as { code: string }).code).toBe("INVALID_OFFSET");
    expect(((await (await get("/api/products?lifecycle=hot")).json()) as { code: string }).code).toBe("INVALID_LIFECYCLE");
  });

  it("returns 503 when Supabase is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await get("/api/products", {} as Env);
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(503);
    expect(body.code).toBe("SUPABASE_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the product list read fails", async () => {
    server.override("GET", "/rest/v1/products", 500, { message: "db down" });
    const res = await get("/api/products");
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(502);
    expect(body.code).toBe("product_list_failed");
  });

  it("never leaks credentials", async () => {
    const res = await get("/api/products");
    const text = await res.text();
    expect(text).not.toContain(SECRET_KEY);
    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
    }
  });
});

describe("GET / product discovery dashboard", () => {
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
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("No products discovered yet.");
  });

  it("renders compact score and summary for a product", async () => {
    server.seed("products", [
      {
        id: "p-1",
        title: "Wireless Earbuds",
        brand: "SoundCore",
        last_seen_at: "2026-08-18T10:00:00.000Z",
        lifecycle_status: "active",
        availability_status: "in_stock",
      },
    ]);
    const res = await get("/");
    const html = await res.text();
    expect(html).toContain("Wireless Earbuds");
    expect(html).toContain("Score 0 (unknown)");
    expect(html).toContain("product market opportunity is missing");
    expect(html).not.toMatch(/WORLD|facebook|pinterest|social/i);
  });

  it("renders the unconfigured state without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await get("/", {} as Env);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Supabase is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
