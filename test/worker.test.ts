import { describe, expect, it } from "vitest";
import { routeRequest } from "../src/router";
import type { Env } from "../src/env";

const env = {} as Env;
const ctx = {} as ExecutionContext;

async function get(path: string, requestEnv: Env = env): Promise<Response> {
  return routeRequest(new Request(`https://worker.example${path}`, { method: "GET" }), requestEnv, ctx);
}

describe("router", () => {
  it("serves the product discovery dashboard at /", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Product Discovery");
    expect(html).toContain("Supabase is not configured");
  });

  it("returns ok for GET /health", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("product-intelligence-platform");
    expect(body.config).toEqual({
      supabaseConfigured: false,
      cacheConfigured: false,
      assetsConfigured: false,
    });
  });

  it("reports configured bindings on /health without leaking values", async () => {
    const res = await get("/health", {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "secret-value",
    } as Env);
    const text = await res.text();
    const body = JSON.parse(text) as { config: Record<string, boolean> };
    expect(body.config.supabaseConfigured).toBe(true);
    expect(text.includes("secret-value")).toBe(false);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await get("/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns 400 when /api/scrape is missing the url parameter", async () => {
    const res = await get("/api/scrape");
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid url on /api/scrape", async () => {
    const res = await get("/api/scrape?url=not-a-url");
    expect(res.status).toBe(400);
  });

  it("returns 501 for a url with no registered scraper", async () => {
    const res = await get("/api/scrape?url=https%3A%2F%2Fexample.com%2Fproduct%2F1");
    expect(res.status).toBe(501);
  });

  it("returns 501 for unimplemented api paths", async () => {
    const res = await get("/api/anything");
    expect(res.status).toBe(501);
  });
});
