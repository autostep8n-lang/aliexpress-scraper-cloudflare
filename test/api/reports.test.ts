import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REPORT_LIMIT, MAX_REPORT_LIMIT } from "../../src/api/reports";
import type { Env } from "../../src/env";
import { routeRequest } from "../../src/router";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const REPORT_ID = "22222222-2222-2222-2222-222222222222";
const ctx = {} as ExecutionContext;

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

async function get(path: string, env: Env = configuredEnv()): Promise<Response> {
  return routeRequest(new Request(`https://worker.example${path}`, { method: "GET" }), env, ctx);
}

function reportRow(id: string, generatedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    report_type: "daily_digest",
    dedup_key: `2026-09-${id}`,
    title: `Report ${id}`,
    summary: `Report ${id}`,
    period_start: "2026-09-14T00:00:00.000Z",
    period_end: "2026-09-15T00:00:00.000Z",
    payload: { status: "ok" },
    generated_at: generatedAt,
    ...overrides,
  };
}

describe("GET /api/reports", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns an ok empty archive with default paging", async () => {
    const response = await get("/api/reports");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; reports: unknown[]; page: unknown };
    expect(body.status).toBe("ok");
    expect(body.reports).toEqual([]);
    expect(body.page).toEqual({ limit: DEFAULT_REPORT_LIMIT, offset: 0, count: 0 });
  });

  it("returns reports newest first", async () => {
    server.seed("reports", [
      reportRow("14", "2026-09-14T00:00:00.000Z"),
      reportRow("13", "2026-09-13T00:00:00.000Z"),
    ]);

    const response = await get("/api/reports?limit=10&offset=0");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { reports: Array<{ id: string }>; page: { count: number } };
    expect(body.reports.map((report) => report.id)).toEqual(["14", "13"]);
    expect(body.page.count).toBe(2);
  });

  it("filters to a single report type when type is provided", async () => {
    server.seed("reports", [
      reportRow("14", "2026-09-14T00:00:00.000Z"),
      reportRow("other", "2026-09-15T00:00:00.000Z", { report_type: "weekly_digest" }),
    ]);

    const response = await get("/api/reports?type=daily_digest");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { reports: Array<{ id: string }>; page: { count: number } };
    expect(body.reports.map((report) => report.id)).toEqual(["14"]);
    expect(body.page.count).toBe(1);
  });

  it("supports HEAD with the same status", async () => {
    const response = await routeRequest(
      new Request("https://worker.example/api/reports", { method: "HEAD" }),
      configuredEnv(),
      ctx,
    );
    expect(response.status).toBe(200);
  });

  it("returns 400 INVALID_LIMIT for a non-positive or non-integer limit", async () => {
    for (const query of ["limit=0", "limit=-1", "limit=1.5", "limit=abc"]) {
      const response = await get(`/api/reports?${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("INVALID_LIMIT");
    }
  });

  it("returns 400 INVALID_OFFSET for a negative or non-integer offset", async () => {
    for (const query of ["offset=-1", "offset=1.5", "offset=abc"]) {
      const response = await get(`/api/reports?${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("INVALID_OFFSET");
    }
  });

  it("returns 400 INVALID_TYPE for an unknown report type", async () => {
    for (const query of ["type=bogus", "type=WEEKLY", "type=weekly_digest"]) {
      const response = await get(`/api/reports?${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("INVALID_TYPE");
    }
  });

  it("caps limit at the maximum page size", async () => {
    const response = await get("/api/reports?limit=500");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { page: { limit: number } };
    expect(body.page.limit).toBe(MAX_REPORT_LIMIT);
  });

  it("returns 503 SUPABASE_NOT_CONFIGURED when Supabase is unconfigured", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const response = await get("/api/reports", {} as Env);

    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("SUPABASE_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 with the repository's typed code when the read fails", async () => {
    server.override("GET", "/rest/v1/reports", 500, { message: "read rejected" });

    const response = await get("/api/reports");

    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe("report_list_failed");
  });

  it("rejects non-GET methods with 405", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await routeRequest(
        new Request("https://worker.example/api/reports", { method, body: method === "POST" ? "{}" : undefined }),
        configuredEnv(),
        ctx,
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
    }
  });
});

describe("GET /api/reports/:id", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the matching report", async () => {
    server.seed("reports", [reportRow(REPORT_ID, "2026-09-14T00:00:00.000Z")]);

    const response = await get(`/api/reports/${REPORT_ID}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; report: { id: string } };
    expect(body.status).toBe("ok");
    expect(body.report.id).toBe(REPORT_ID);
  });

  it("returns 404 for an unknown report", async () => {
    server.seed("reports", [reportRow(REPORT_ID, "2026-09-14T00:00:00.000Z")]);

    const response = await get("/api/reports/33333333-3333-3333-3333-333333333333");

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("REPORT_NOT_FOUND");
  });

  it("returns 404 for a malformed id without querying the database", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const response = await get("/api/reports/not-a-uuid");

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("REPORT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 503 when Supabase is unconfigured", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const response = await get(`/api/reports/${REPORT_ID}`, {} as Env);

    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("SUPABASE_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 with the repository's typed code when the lookup fails", async () => {
    server.override("GET", "/rest/v1/reports", 500, { message: "db down" });

    const response = await get(`/api/reports/${REPORT_ID}`);

    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe("report_lookup_failed");
  });

  it("rejects non-GET methods with 405", async () => {
    const response = await routeRequest(
      new Request(`https://worker.example/api/reports/${REPORT_ID}`, { method: "POST", body: "{}" }),
      configuredEnv(),
      ctx,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  });
});
