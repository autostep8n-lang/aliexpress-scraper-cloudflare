import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { upsertGoogleTrends } from "../../src/supabase/repository";
import type { GoogleTrendsObservationRow } from "../../src/market/types";
import { createMockPostgrest, type MockPostgrest, type RecordedRequest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

const GOOGLE_TRENDS_SOURCE = {
  id: "33333333-3333-3333-3333-333333333333",
  slug: "google-trends",
  name: "Google Trends",
  kind: "api",
};

const GOOGLE_TRENDS_CONFLICT = "source_id,keyword,geo,property,time_range,period_start";

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function row(overrides: Partial<GoogleTrendsObservationRow> = {}): GoogleTrendsObservationRow {
  return {
    source_id: null,
    keyword: "smart watch",
    geo: "US",
    property: "web",
    category: null,
    time_range: "today 5-y",
    period_start: "2026-01-01T00:00:00.000Z",
    period_end: "2026-02-01T00:00:00.000Z",
    value: 50,
    captured_at: "2026-03-01T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function requestsTo(server: MockPostgrest, method: string, path: string): RecordedRequest[] {
  return server.requests.filter((request) => request.method === method && request.url.includes(path));
}

describe("upsertGoogleTrends", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns credentials_missing without touching the network when Supabase is unconfigured", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await upsertGoogleTrends({} as Env, [row()]);

    expect(result).toEqual({ status: "credentials_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns updated with an empty payload without touching the network for no rows", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await upsertGoogleTrends(configuredEnv(), []);

    expect(result).toEqual({ status: "updated", data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates the google-trends source and inserts rows, backfilling source_id", async () => {
    const result = await upsertGoogleTrends(configuredEnv(), [row(), row({ keyword: "phone" })]);

    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    const source = server.store.sources.find((entry) => entry.slug === "google-trends");
    expect(source).toBeDefined();
    expect(source).toMatchObject({ slug: "google-trends", name: "Google Trends", kind: "api" });

    expect(server.store.google_trends).toHaveLength(2);
    expect(server.store.google_trends.every((entry) => entry.source_id === source?.id)).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data.every((entry) => entry.source_id === source?.id)).toBe(true);
  });

  it("reuses an existing google-trends source without duplicating it", async () => {
    server.seed("sources", [GOOGLE_TRENDS_SOURCE]);

    const result = await upsertGoogleTrends(configuredEnv(), [row()]);

    expect(result.status).toBe("created");
    expect(server.store.sources.filter((entry) => entry.slug === "google-trends")).toHaveLength(1);
    expect(server.store.google_trends[0].source_id).toBe(GOOGLE_TRENDS_SOURCE.id);
  });

  it("replaces a bucket instead of duplicating on a re-collect", async () => {
    const first = await upsertGoogleTrends(configuredEnv(), [row()]);
    expect(first.status).toBe("created");

    const second = await upsertGoogleTrends(configuredEnv(), [row({ value: 90 })]);
    expect(second.status).toBe("updated");
    expect(server.store.google_trends).toHaveLength(1);
    expect(server.store.google_trends[0].value).toBe(90);
  });

  it("targets the dedup key with on_conflict on the upsert request", async () => {
    await upsertGoogleTrends(configuredEnv(), [row()]);

    const post = requestsTo(server, "POST", "/rest/v1/google_trends")[0];
    expect(new URL(post.url).searchParams.get("on_conflict")).toBe(GOOGLE_TRENDS_CONFLICT);
  });

  it("sends the normalized observation payload with a resolved source_id", async () => {
    await upsertGoogleTrends(configuredEnv(), [row()]);

    const post = requestsTo(server, "POST", "/rest/v1/google_trends")[0];
    const payload = post.body as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      keyword: "smart watch",
      geo: "US",
      property: "web",
      category: null,
      time_range: "today 5-y",
      period_start: "2026-01-01T00:00:00.000Z",
      period_end: "2026-02-01T00:00:00.000Z",
      value: 50,
      captured_at: "2026-03-01T00:00:00.000Z",
      metadata: {},
    });
    expect(payload[0].source_id).toBe(server.store.sources[0].id);
  });

  it("returns error source_lookup_failed when the source lookup fails", async () => {
    server.override("GET", "/rest/v1/sources", 500, {
      code: "PGRST301",
      message: "Database error",
    });

    const result = await upsertGoogleTrends(configuredEnv(), [row()]);

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("source_lookup_failed");
  });

  it("returns error source_create_failed when the source upsert fails", async () => {
    server.override("POST", "/rest/v1/sources", 500, {
      code: "23502",
      message: "null value in column violates not-null constraint",
    });

    const result = await upsertGoogleTrends(configuredEnv(), [row()]);

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("source_create_failed");
  });

  it("returns error google_trends_upsert_failed when the database rejects the write", async () => {
    server.seed("sources", [GOOGLE_TRENDS_SOURCE]);
    server.override("POST", "/rest/v1/google_trends", 400, {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    });

    const result = await upsertGoogleTrends(configuredEnv(), [row()]);

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("google_trends_upsert_failed");
  });

  it("never leaks credentials into request URLs", async () => {
    await upsertGoogleTrends(configuredEnv(), [row()]);

    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${SECRET_KEY}`);
    }
  });
});
