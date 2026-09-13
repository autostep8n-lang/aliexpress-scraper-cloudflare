import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { routeRequest } from "../../src/router";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const MISSING_ID = "22222222-2222-4222-8222-222222222222";
const XSS_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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

function seedDetail(server: MockPostgrest, id = PRODUCT_ID): void {
  server.seed("products", [
    {
      id,
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
      product_id: id,
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
        signals: [
          {
            key: "competition_pressure",
            label: "Competition",
            weight: 1,
            value: 0.4,
            present: true,
            contribution: 0.4,
          },
        ],
      },
    },
  ]);
  server.seed("country_opportunity_scores", [
    {
      id: "c-1",
      product_id: id,
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
        signals: [
          {
            key: "country_search_level",
            label: "Country search",
            weight: 0.4,
            value: 0.8,
            present: true,
            contribution: 0.32,
          },
        ],
      },
      country_latest_value: 80,
      country_change: 40,
      country_direction: "up",
    },
  ]);
}

describe("GET /api/products/:id", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns 200 with full analyst evidence for an existing product", async () => {
    seedDetail(server);
    const res = await get(`/api/products/${PRODUCT_ID}`);
    const body = (await res.json()) as {
      status: string;
      product: { id: string; title: string };
      decision: {
        provider: string;
        score: { value: number; tier: string; scoreType: string };
        selectedCountry: string | null;
        summary: string;
        caveats: string[];
        evidence: { market: { present: boolean }; country: { present: boolean; country: string | null } };
      };
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.product.id).toBe(PRODUCT_ID);
    expect(body.product.title).toBe("Wireless Earbuds");
    expect(body.decision.provider).toBe("template");
    expect(body.decision.score.scoreType).toBe("decision_opportunity");
    expect(body.decision.score.value).toBe(60);
    expect(body.decision.score.tier).toBe("medium");
    expect(body.decision.selectedCountry).toBe("SA");
    expect(body.decision.summary).toContain("Decision opportunity score 60 (medium)");
    expect(body.decision.evidence.market.present).toBe(true);
    expect(body.decision.evidence.country.present).toBe(true);
    expect(body.decision.evidence.country.country).toBe("SA");
    expect(body.decision.caveats).toEqual([]);
    expect(server.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("returns 404 for an unknown product", async () => {
    seedDetail(server);
    const res = await get(`/api/products/${MISSING_ID}`);
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 404 for a malformed id without querying products", async () => {
    seedDetail(server);
    const res = await get("/api/products/invalid-test-id");
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(server.requests.some((request) => request.url.includes("/rest/v1/products"))).toBe(false);
  });

  it("returns 404 for nested or empty ids instead of treating them as products", async () => {
    const nested = await get(`/api/products/${PRODUCT_ID}/extra`);
    expect(nested.status).toBe(501);
    const empty = await get("/api/products/");
    expect(empty.status).toBe(501);
  });

  it("returns 503 when Supabase is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await get(`/api/products/${PRODUCT_ID}`, {} as Env);
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(503);
    expect(body.code).toBe("SUPABASE_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the product lookup fails", async () => {
    server.override("GET", "/rest/v1/products", 500, { message: "db down" });
    const res = await get(`/api/products/${PRODUCT_ID}`);
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(502);
    expect(body.code).toBe("product_lookup_failed");
  });

  it("rejects non-GET methods", async () => {
    const res = await routeRequest(
      new Request(`https://worker.example/api/products/${PRODUCT_ID}`, { method: "POST" }),
      configuredEnv(),
      ctx,
    );
    expect(res.status).toBe(405);
  });

  it("supports HEAD without writing", async () => {
    seedDetail(server);
    const res = await head(`/api/products/${PRODUCT_ID}`);
    expect(res.status).toBe(200);
    expect(server.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("never leaks credentials", async () => {
    seedDetail(server);
    const res = await get(`/api/products/${PRODUCT_ID}`);
    const text = await res.text();
    expect(text).not.toContain(SECRET_KEY);
    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
    }
  });

  it("keeps GET /api/products compact and without evidence", async () => {
    seedDetail(server);
    const res = await get("/api/products");
    const body = (await res.json()) as {
      products: Array<{ id: string; decision: Record<string, unknown> }>;
    };
    expect(res.status).toBe(200);
    expect(body.products[0].id).toBe(PRODUCT_ID);
    expect(body.products[0].decision).not.toHaveProperty("evidence");
    expect(Object.keys(body.products[0].decision).sort()).toEqual([
      "caveats",
      "provider",
      "score",
      "selectedCountry",
      "summary",
    ]);
  });
});

describe("GET /products/:id HTML", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders score, summary, evidence and why content", async () => {
    seedDetail(server);
    const res = await get(`/products/${PRODUCT_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Wireless Earbuds");
    expect(html).toContain("SoundCore");
    expect(html).toContain("Score 60 (medium)");
    expect(html).toContain("Decision opportunity score 60 (medium)");
    expect(html).toContain("Why this opportunity");
    expect(html).toContain("Product market opportunity 40");
    expect(html).toContain("Selected country SA scored 80");
    expect(html).toContain("Latest search interest: 80");
    expect(html).toContain("Source listing");
    expect(html).not.toMatch(/WORLD|facebook|pinterest|social/i);
    expect(server.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("returns 404 HTML for a missing product", async () => {
    const res = await get(`/products/${MISSING_ID}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Product not found.");
  });

  it("renders the unconfigured state without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await get(`/products/${PRODUCT_ID}`, {} as Env);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Supabase is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("escapes user/product text in HTML", async () => {
    server.seed("products", [
      {
        id: XSS_ID,
        title: `<script>alert(1)</script>`,
        brand: `"><img src=x onerror=alert(2)>`,
        last_seen_at: "2026-08-18T10:00:00.000Z",
        lifecycle_status: "active",
      },
    ]);
    const html = await (await get(`/products/${XSS_ID}`)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(2)&gt;");
  });
});

describe("list pages link to product detail", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("links discovery and opportunity titles to /products/:id", async () => {
    seedDetail(server);
    const discovery = await (await get("/")).text();
    const opportunities = await (await get("/opportunities")).text();
    expect(discovery).toContain(`href="/products/${PRODUCT_ID}"`);
    expect(opportunities).toContain(`href="/products/${PRODUCT_ID}"`);
    expect(discovery).not.toContain("Why this opportunity");
    expect(opportunities).not.toContain("Why this opportunity");
  });
});
