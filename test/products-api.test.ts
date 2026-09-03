import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { routeRequest } from "../src/router";
import type { Product } from "../src/products/types";
import { normalizeProduct } from "../src/products/normalize";
import { createMockPostgrest, type MockPostgrest, type RecordedRequest } from "./helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

const SOURCE_ALIEXPRESS = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "aliexpress",
  name: "AliExpress",
  kind: "platform",
};

const ctx = {} as ExecutionContext;

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function aliexpressProduct(): Product {
  return normalizeProduct({
    raw: {
      externalId: "1005001",
      title: "Wireless Earbuds",
      description: "High quality wireless earbuds",
      price: { amount: "19.99", currency: "usd", originalAmount: "29.99" },
      images: [{ url: "https://img.example.com/a.jpg", alt: "earbuds" }],
      category: { id: "c1", name: "Electronics" },
      rating: { average: 4.5, count: 123 },
      shipping: { free: true, deliveryMinDays: 7, deliveryMaxDays: 15 },
      attributes: { brand: "SoundCore" },
      available: true,
    },
    platform: "aliexpress",
    url: "https://www.aliexpress.com/item/1005001.html",
    scrapedAt: "2026-08-18T10:00:00.000Z",
  });
}

async function post(
  server: MockPostgrest,
  path: string,
  body: unknown,
  requestEnv: Env = configuredEnv(),
): Promise<Response> {
  vi.stubGlobal("fetch", server.fetch);
  const request = new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return routeRequest(request, requestEnv, ctx);
}

function requestsTo(server: MockPostgrest, method: string, path: string): RecordedRequest[] {
  return server.requests.filter((request) => request.method === method && request.url.includes(path));
}

describe("POST /api/products", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    server.seed("sources", [SOURCE_ALIEXPRESS]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a product and observation with 201 and returns the persisted rows", async () => {
    const res = await post(server, "/api/products", { product: aliexpressProduct(), raw: { scraped: true } });
    const body = (await res.json()) as {
      status: string;
      source: { slug: string };
      product: { dedup_key: string; title: string };
      observation: { external_id: string; price: number; raw: unknown };
    };

    expect(res.status).toBe(201);
    expect(body.status).toBe("created");
    expect(body.source.slug).toBe("aliexpress");
    expect(body.product.dedup_key).toBe("aliexpress:1005001");
    expect(body.product.title).toBe("Wireless Earbuds");
    expect(body.observation.external_id).toBe("1005001");
    expect(body.observation.price).toBe(19.99);
    expect(body.observation.raw).toEqual({ scraped: true });
    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources).toHaveLength(1);
  });

  it("returns 200 with updated when re-ingesting the same product", async () => {
    const first = await post(server, "/api/products", { product: aliexpressProduct() });
    expect(first.status).toBe(201);

    const second = await post(server, "/api/products", {
      product: { ...aliexpressProduct(), title: "Wireless Earbuds Pro" },
    });
    const body = (await second.json()) as { status: string; product: { id: string; title: string } };

    expect(second.status).toBe(200);
    expect(body.status).toBe("updated");
    expect(body.product.title).toBe("Wireless Earbuds Pro");
    expect(server.store.products).toHaveLength(1);
    expect(server.store.product_sources).toHaveLength(1);
  });

  it("returns 400 INVALID_JSON for a malformed body", async () => {
    vi.stubGlobal("fetch", server.fetch);
    const request = new Request(`https://worker.example/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{",
    });

    const res = await routeRequest(request, configuredEnv(), ctx);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_JSON");
    expect(server.requests).toHaveLength(0);
  });

  it("returns 400 INVALID_PRODUCT when the product field is missing", async () => {
    const res = await post(server, "/api/products", { raw: {} });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_PRODUCT");
  });

  it("returns 400 INVALID_PRODUCT when the product fails validation", async () => {
    const invalid = { ...aliexpressProduct(), title: "" };
    const res = await post(server, "/api/products", { product: invalid });
    const body = (await res.json()) as { code: string; error: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_PRODUCT");
    expect(body.error).toContain("title");
  });

  it("returns 503 SUPABASE_NOT_CONFIGURED without touching the network", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request(`https://worker.example/api/products`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product: aliexpressProduct() }),
    });

    const res = await routeRequest(request, {} as Env, ctx);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe("SUPABASE_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 with the repository step code when the database rejects the write", async () => {
    server.override("POST", "/rest/v1/products", 400, {
      code: "23502",
      message: "null value in column violates not-null constraint",
    });

    const res = await post(server, "/api/products", { product: aliexpressProduct() });
    const body = (await res.json()) as { code: string; error: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("product_upsert_failed");
    expect(body.error).toContain("null value");
  });

  it("returns 502 source_lookup_failed when the source lookup fails", async () => {
    server.override("GET", "/rest/v1/sources", 500, {
      code: "PGRST301",
      message: "Database error",
    });

    const res = await post(server, "/api/products", { product: aliexpressProduct() });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe("source_lookup_failed");
  });

  it("returns 405 for methods other than GET/HEAD/POST on /api/products", async () => {
    vi.stubGlobal("fetch", server.fetch);
    const res = await routeRequest(new Request("https://worker.example/api/products", { method: "PUT" }), configuredEnv(), ctx);

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, POST");
    expect(server.requests).toHaveLength(0);
  });

  it("never leaks credentials into the response or request URLs", async () => {
    const res = await post(server, "/api/products", { product: aliexpressProduct() });
    const text = await res.text();

    expect(text).not.toContain(SECRET_KEY);
    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${SECRET_KEY}`);
    }
  });

  it("preserves existing GET routes while the new route is active", async () => {
    const health = await routeRequest(new Request("https://worker.example/health", { method: "GET" }), configuredEnv(), ctx);
    expect(health.status).toBe(200);

    const missing = await routeRequest(new Request("https://worker.example/api/anything", { method: "GET" }), configuredEnv(), ctx);
    expect(missing.status).toBe(501);

    const scrape = await routeRequest(
      new Request("https://worker.example/api/scrape?url=https%3A%2F%2Fexample.com%2Fx"),
      configuredEnv(),
      ctx,
    );
    expect(scrape.status).toBe(501);
  });

  it("records the dedup_key and on_conflict targets on the write requests", async () => {
    await post(server, "/api/products", { product: aliexpressProduct() });

    const productPost = requestsTo(server, "POST", "/rest/v1/products")[0];
    const observationPost = requestsTo(server, "POST", "/rest/v1/product_sources")[0];
    expect(new URL(productPost.url).searchParams.get("on_conflict")).toBe("dedup_key");
    expect(new URL(observationPost.url).searchParams.get("on_conflict")).toBe("source_id,external_id");
  });
});
