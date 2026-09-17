import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import {
  getReportById,
  listReports,
  upsertReports,
  type ReportRow,
} from "../../src/supabase/repository";
import { createMockPostgrest, type MockPostgrest, type RecordedRequest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const REPORT_CONFLICT = "report_type,dedup_key";
const REPORT_ID = "22222222-2222-2222-2222-222222222222";
const MISSING_ID = "33333333-3333-3333-3333-333333333333";

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function row(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    report_type: "daily_digest",
    dedup_key: "2026-09-14",
    title: "Daily digest for 2026-09-14",
    summary: "discovery ok",
    period_start: "2026-09-14T00:00:00.000Z",
    period_end: "2026-09-15T00:00:00.000Z",
    payload: { status: "ok" },
    generated_at: "2026-09-14T03:00:00.000Z",
    ...overrides,
  };
}

function requestsTo(server: MockPostgrest, method: string, path: string): RecordedRequest[] {
  return server.requests.filter((request) => request.method === method && request.url.includes(path));
}

describe("upsertReports", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns credentials_missing without touching the network when unconfigured", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await upsertReports({} as Env, [row()]);

    expect(result).toEqual({ status: "credentials_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns updated with an empty payload without touching the network for no rows", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await upsertReports(configuredEnv(), []);

    expect(result).toEqual({ status: "updated", data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a row without a report_type or dedup_key", async () => {
    expect(await upsertReports(configuredEnv(), [row({ report_type: "" })])).toMatchObject({ status: "invalid" });
    expect(await upsertReports(configuredEnv(), [row({ dedup_key: "" })])).toMatchObject({ status: "invalid" });
  });

  it("inserts reports with the ON CONFLICT dedup target and no created_at payload", async () => {
    const result = await upsertReports(configuredEnv(), [row()]);

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.data).toHaveLength(1);
    expect(server.store.reports).toHaveLength(1);

    const post = requestsTo(server, "POST", "/rest/v1/reports")[0];
    expect(new URL(post.url).searchParams.get("on_conflict")).toBe(REPORT_CONFLICT);
    const payload = post.body as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0].created_at).toBeUndefined();
    expect(payload[0]).toMatchObject({ report_type: "daily_digest", dedup_key: "2026-09-14" });
  });

  it("updates the same row on a repeat dedup key instead of appending", async () => {
    const first = await upsertReports(configuredEnv(), [row()]);
    const second = await upsertReports(configuredEnv(), [row({ summary: "refreshed" })]);

    expect(first.status).toBe("created");
    expect(second.status).toBe("updated");
    expect(server.store.reports).toHaveLength(1);
    expect(server.store.reports[0].summary).toBe("refreshed");
  });

  it("returns a typed error when the write fails", async () => {
    server.override("POST", "/rest/v1/reports", 500, { message: "db down" });

    const result = await upsertReports(configuredEnv(), [row()]);

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.code).toBe("reports_upsert_failed");
  });
});

describe("listReports", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns credentials_missing without touching the network when unconfigured", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await listReports({} as Env, { limit: 10, offset: 0 });

    expect(result).toEqual({ status: "credentials_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns reports most recently generated first", async () => {
    server.seed("reports", [
      { id: "older", report_type: "daily_digest", dedup_key: "2026-09-13", generated_at: "2026-09-13T00:00:00.000Z" },
      { id: "newer", report_type: "daily_digest", dedup_key: "2026-09-14", generated_at: "2026-09-14T00:00:00.000Z" },
    ]);

    const result = await listReports(configuredEnv(), { limit: 10, offset: 0 });

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.data.map((report) => report.id)).toEqual(["newer", "older"]);
  });

  it("narrows the archive to a single report type when asked", async () => {
    server.seed("reports", [
      { id: "digest", report_type: "daily_digest", dedup_key: "2026-09-14", generated_at: "2026-09-14T00:00:00.000Z" },
      { id: "other", report_type: "weekly_digest", dedup_key: "2026-W37", generated_at: "2026-09-14T00:00:00.000Z" },
    ]);

    const result = await listReports(configuredEnv(), { limit: 10, offset: 0, reportType: "daily_digest" });

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.data.map((report) => report.id)).toEqual(["digest"]);
  });

  it("returns a typed error when the read fails", async () => {
    server.override("GET", "/rest/v1/reports", 500, { message: "read rejected" });

    const result = await listReports(configuredEnv(), { limit: 10, offset: 0 });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.code).toBe("report_list_failed");
  });
});

describe("getReportById", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns credentials_missing without touching the network when unconfigured", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await getReportById({} as Env, REPORT_ID);

    expect(result.status).toBe("credentials_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the matching report without writing", async () => {
    server.seed("reports", [
      { id: REPORT_ID, report_type: "daily_digest", dedup_key: "2026-09-14" },
      { id: MISSING_ID, report_type: "daily_digest", dedup_key: "2026-09-13" },
    ]);

    const result = await getReportById(configuredEnv(), REPORT_ID);

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.data.id).toBe(REPORT_ID);
    expect(server.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("returns not_found for an unknown uuid without treating it as a lookup error", async () => {
    server.seed("reports", [{ id: REPORT_ID, report_type: "daily_digest", dedup_key: "2026-09-14" }]);

    const result = await getReportById(configuredEnv(), MISSING_ID);

    expect(result.status).toBe("not_found");
    expect(server.requests.some((request) => request.url.includes(`id=eq.${MISSING_ID}`))).toBe(true);
  });

  it("returns not_found for a malformed id without querying reports", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await getReportById(configuredEnv(), "invalid-test-id");

    expect(result.status).toBe("not_found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a typed error when the lookup fails", async () => {
    server.override("GET", "/rest/v1/reports", 500, { message: "db down" });

    const result = await getReportById(configuredEnv(), REPORT_ID);

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.code).toBe("report_lookup_failed");
  });
});
