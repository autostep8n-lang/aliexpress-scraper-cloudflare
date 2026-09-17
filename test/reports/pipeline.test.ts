import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomatedAlertsSummary } from "../../src/alerts/pipeline";
import type { ScheduledAutomationResult } from "../../src/discovery/scheduled";
import type { Env } from "../../src/env";
import { runAutomatedReports } from "../../src/reports";
import type { AutomatedScoringSummary } from "../../src/scoring/pipeline";
import { createMockPostgrest, type MockPostgrest, type RecordedRequest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

const OK_SCORING: AutomatedScoringSummary = {
  status: "ok",
  total: 2,
  scored: 2,
  skipped: 0,
  failed: 0,
  persisted: 2,
  durationMs: 4,
};

const OK_ALERTS: AutomatedAlertsSummary = {
  status: "ok",
  total: 2,
  evaluated: 2,
  created: 1,
  resolved: 0,
  unchanged: 1,
  failed: 0,
  durationMs: 3,
};

function automation(): ScheduledAutomationResult {
  return {
    discovery: {
      status: "ok",
      platform: "tiktok-shop",
      query: "earbuds",
      region: null,
      limit: 20,
      discovered: 3,
      persisted: 2,
      created: 1,
      updated: 1,
      failed: 0,
      durationMs: 12,
    },
    scoring: OK_SCORING,
    alerts: OK_ALERTS,
  };
}

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function reportPosts(server: MockPostgrest): RecordedRequest[] {
  return server.requests.filter((request) => request.method === "POST" && request.url.includes("/rest/v1/reports"));
}

describe("runAutomatedReports", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("skips without touching the network when Supabase is unconfigured", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await runAutomatedReports({} as Env, automation());

    expect(result).toMatchObject({
      status: "skipped",
      reportType: "daily_digest",
      code: "SUPABASE_NOT_CONFIGURED",
      persisted: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("upserts the daily digest keyed on (report_type, dedup_key)", async () => {
    const result = await runAutomatedReports(configuredEnv(), automation(), {
      now: () => "2026-09-14T03:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "ok",
      reportType: "daily_digest",
      dedupKey: "2026-09-14",
      persisted: 1,
    });
    expect(server.store.reports).toHaveLength(1);

    const post = reportPosts(server)[0];
    expect(new URL(post.url).searchParams.get("on_conflict")).toBe("report_type,dedup_key");
    const payload = post.body as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      report_type: "daily_digest",
      dedup_key: "2026-09-14",
      period_start: "2026-09-14T00:00:00.000Z",
      period_end: "2026-09-15T00:00:00.000Z",
      generated_at: "2026-09-14T03:00:00.000Z",
    });
    expect(payload[0].payload).toMatchObject({ status: "ok" });
    expect(payload[0].created_at).toBeUndefined();
  });

  it("is idempotent within the same UTC day", async () => {
    const now = () => "2026-09-14T05:00:00.000Z";

    const first = await runAutomatedReports(configuredEnv(), automation(), { now });
    const second = await runAutomatedReports(configuredEnv(), automation(), { now });

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(server.store.reports).toHaveLength(1);
    expect(reportPosts(server)).toHaveLength(2);
  });

  it("creates a distinct row on a new UTC day", async () => {
    await runAutomatedReports(configuredEnv(), automation(), { now: () => "2026-09-14T23:00:00.000Z" });
    await runAutomatedReports(configuredEnv(), automation(), { now: () => "2026-09-15T01:00:00.000Z" });

    expect(server.store.reports).toHaveLength(2);
    expect(server.store.reports.map((row) => row.dedup_key)).toEqual(["2026-09-14", "2026-09-15"]);
  });

  it("records a failed automation run as an error digest rather than skipping it", async () => {
    const failed: ScheduledAutomationResult = {
      discovery: {
        status: "error",
        code: "BLOCKED",
        message: "captcha",
        query: "earbuds",
        region: null,
        limit: 20,
        durationMs: 9,
      },
      scoring: null,
      alerts: null,
    };

    const result = await runAutomatedReports(configuredEnv(), failed, {
      now: () => "2026-09-14T03:00:00.000Z",
    });

    expect(result.status).toBe("ok");
    expect(server.store.reports).toHaveLength(1);
    expect(server.store.reports[0].payload).toMatchObject({ status: "error" });
  });

  it("returns a typed error and never throws when persistence fails", async () => {
    server.override("POST", "/rest/v1/reports", 500, { message: "write rejected" });
    const before = structuredClone(automation());

    const result = await runAutomatedReports(configuredEnv(), automation(), {
      now: () => "2026-09-14T03:00:00.000Z",
    });

    expect(result).toMatchObject({ status: "error", code: "reports_upsert_failed" });
    expect(server.store.reports).toHaveLength(0);
    // The report layer never mutates the automation result it describes.
    expect(before).toEqual(automation());
  });

  it("returns a typed error when the clock yields an invalid instant", async () => {
    const result = await runAutomatedReports(configuredEnv(), automation(), { now: () => "not-a-date" });

    expect(result).toMatchObject({ status: "error", code: "DIGEST_BUILD_FAILED" });
    expect(server.requests).toHaveLength(0);
  });

  it("logs a scheduled.reports entry for both ok and error outcomes", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runAutomatedReports(configuredEnv(), automation(), { now: () => "2026-09-14T03:00:00.000Z" });
    const okEntry = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .find((entry) => entry.event === "scheduled.reports");
    expect(okEntry).toMatchObject({
      level: "info",
      reportType: "daily_digest",
      dedupKey: "2026-09-14",
      persisted: 1,
    });

    server.override("POST", "/rest/v1/reports", 500, { message: "write rejected" });
    await runAutomatedReports(configuredEnv(), automation(), { now: () => "2026-09-14T04:00:00.000Z" });
    const errorEntry = errorSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .find((entry) => entry.reportType === "daily_digest");
    expect(errorEntry).toMatchObject({
      level: "error",
      reportType: "daily_digest",
      code: "reports_upsert_failed",
      persisted: 0,
    });
  });
});
