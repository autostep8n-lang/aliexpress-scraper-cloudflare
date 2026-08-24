import { describe, expect, it, vi } from "vitest";
import { jsonError, jsonOk, methodNotAllowed } from "../src/utils/http";
import { createRequestId } from "../src/logging";
import { routeRequest } from "../src/router";
import type { ScraperModule } from "../src/scrapers/types";
import type { Env } from "../src/env";

vi.mock("../src/scrapers/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scrapers/registry")>();
  return {
    ...actual,
    findScraper: (url: URL): ScraperModule | undefined => {
      if (url.hostname === "boom.example") {
        return {
          platform: "aliexpress",
          enabled: true,
          supports: () => true,
          scrape: async () => {
            throw new Error("boom");
          },
        };
      }
      return actual.findScraper(url);
    },
  };
});

const ctx = {} as ExecutionContext;

async function call(path: string, init?: RequestInit): Promise<Response> {
  return routeRequest(new Request(`https://worker.example${path}`, init ?? { method: "GET" }), {} as Env, ctx);
}

describe("http helpers", () => {
  it("jsonOk returns 200 json", async () => {
    const res = jsonOk({ hello: "world" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
  });

  it("jsonError includes code and requestId", async () => {
    const res = jsonError(400, "bad request", "BAD_REQUEST", "req-1");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad request", code: "BAD_REQUEST", requestId: "req-1" });
  });

  it("methodNotAllowed returns 405 with an Allow header", () => {
    const res = methodNotAllowed(["GET", "HEAD"]);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
  });
});

describe("logging", () => {
  it("createRequestId returns a UUID", () => {
    expect(createRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("router hardening", () => {
  it("rejects non-GET on /health with 405", async () => {
    const res = await call("/health", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("GET");
  });

  it("rejects non-GET on / with 405", async () => {
    const res = await call("/", { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("rejects non-http schemes on /api/scrape with 400", async () => {
    const res = await call("/api/scrape?url=javascript%3Aalert(1)");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ code: "INVALID_URL" });
  });

  it("keeps valid https scrape urls returning 501 for unregistered hosts", async () => {
    const res = await call("/api/scrape?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc123");
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toMatchObject({ code: "NO_SCRAPER" });
  });

  it("adds an x-request-id header to every response", async () => {
    for (const path of ["/", "/health", "/health/supabase", "/nope"]) {
      const res = await call(path);
      expect(res.headers.get("x-request-id")).toBeTruthy();
    }
  });

  it("returns 404 with a code for unknown paths", async () => {
    const res = await call("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns 501 with a code for unknown api paths", async () => {
    const res = await call("/api/whatever");
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("returns a json 500 with a code when a handler throws", async () => {
    const res = await call("/api/scrape?url=https%3A%2F%2Fboom.example%2Fx");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ code: "INTERNAL_ERROR", error: "Internal Server Error" });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});
