import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ALERT_LIMIT, MAX_ALERT_LIMIT } from "../../src/api/alerts";
import type { Env } from "../../src/env";
import { routeRequest } from "../../src/router";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";
const ctx = {} as ExecutionContext;

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

async function get(path: string, env: Env = configuredEnv()): Promise<Response> {
  return routeRequest(new Request(`https://worker.example${path}`, { method: "GET" }), env, ctx);
}

function alertRow(id: string, lastSeenAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    product_id: PRODUCT_ID,
    alert_type: "high_market_opportunity",
    severity: "high",
    status: "active",
    dedup_key: `market_opportunity:high:${id}`,
    title: `Alert ${id}`,
    message: `Alert ${id}`,
    evidence: {},
    last_seen_at: lastSeenAt,
    ...overrides,
  };
}

describe("GET /api/alerts", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns an ok empty feed with default paging", async () => {
    const response = await get("/api/alerts");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; alerts: unknown[]; page: unknown };
    expect(body.status).toBe("ok");
    expect(body.alerts).toEqual([]);
    expect(body.page).toEqual({ limit: DEFAULT_ALERT_LIMIT, offset: 0, count: 0 });
  });

  it("returns active alerts newest first", async () => {
    server.seed("alerts", [
      alertRow("newer", "2026-08-19T00:00:00.000Z"),
      alertRow("older", "2026-08-18T00:00:00.000Z"),
      alertRow("resolved", "2026-08-20T00:00:00.000Z", { status: "resolved" }),
    ]);

    const response = await get("/api/alerts?limit=10&offset=0");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { alerts: Array<{ id: string }>; page: { count: number } };
    expect(body.alerts.map((alert) => alert.id)).toEqual(["newer", "older"]);
    expect(body.page.count).toBe(2);
  });

  it("supports HEAD with the same status", async () => {
    const response = await routeRequest(
      new Request("https://worker.example/api/alerts", { method: "HEAD" }),
      configuredEnv(),
      ctx,
    );
    expect(response.status).toBe(200);
  });

  it("returns 400 INVALID_LIMIT for a non-positive or non-integer limit", async () => {
    for (const query of ["limit=0", "limit=-1", "limit=1.5", "limit=abc"]) {
      const response = await get(`/api/alerts?${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("INVALID_LIMIT");
    }
  });

  it("returns 400 INVALID_OFFSET for a negative or non-integer offset", async () => {
    for (const query of ["offset=-1", "offset=1.5", "offset=abc"]) {
      const response = await get(`/api/alerts?${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("INVALID_OFFSET");
    }
  });

  it("caps limit at the maximum page size", async () => {
    const response = await get(`/api/alerts?limit=500`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { page: { limit: number } };
    expect(body.page.limit).toBe(MAX_ALERT_LIMIT);
  });

  it("returns 503 SUPABASE_NOT_CONFIGURED when Supabase is unconfigured", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const response = await get("/api/alerts", {} as Env);

    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("SUPABASE_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 with the repository's typed code when the read fails", async () => {
    server.override("GET", "/rest/v1/alerts", 500, { message: "read rejected" });

    const response = await get("/api/alerts");

    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe("alert_list_failed");
  });

  it("rejects non-GET methods with 405", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await routeRequest(
        new Request("https://worker.example/api/alerts", { method, body: method === "POST" ? "{}" : undefined }),
        configuredEnv(),
        ctx,
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
    }
  });
});
