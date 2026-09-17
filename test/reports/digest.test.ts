import { describe, expect, it } from "vitest";
import type { AutomatedAlertsSummary } from "../../src/alerts/pipeline";
import type { ScheduledAutomationResult } from "../../src/discovery/scheduled";
import {
  buildDailyDigest,
  dailyDigestPayload,
  dailyDigestSummary,
  digestStatus,
  utcDayBounds,
  utcDayKey,
} from "../../src/reports";
import type { AutomatedScoringSummary } from "../../src/scoring/pipeline";

const OK_DISCOVERY = {
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
} as const;

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

function automation(overrides: Partial<ScheduledAutomationResult> = {}): ScheduledAutomationResult {
  return { discovery: OK_DISCOVERY, scoring: OK_SCORING, alerts: OK_ALERTS, ...overrides };
}

describe("utcDayKey / utcDayBounds", () => {
  it("derives the UTC calendar day from an instant", () => {
    expect(utcDayKey("2026-09-14T23:59:59.999Z")).toBe("2026-09-14");
    expect(utcDayKey("2026-09-15T00:00:00.000Z")).toBe("2026-09-15");
  });

  it("returns the half-open UTC bounds covering that day", () => {
    expect(utcDayBounds("2026-09-14T12:00:00.000Z")).toEqual({
      start: "2026-09-14T00:00:00.000Z",
      end: "2026-09-15T00:00:00.000Z",
    });
  });

  it("rolls the end bound across a month boundary", () => {
    expect(utcDayBounds("2026-08-31T08:00:00.000Z")).toEqual({
      start: "2026-08-31T00:00:00.000Z",
      end: "2026-09-01T00:00:00.000Z",
    });
  });
});

describe("buildDailyDigest", () => {
  it("uses the UTC day as the dedup key and pins the period bounds", () => {
    const digest = buildDailyDigest(automation(), "2026-09-14T03:00:00.000Z");

    expect(digest.reportType).toBe("daily_digest");
    expect(digest.dedupKey).toBe("2026-09-14");
    expect(digest.title).toBe("Daily digest for 2026-09-14");
    expect(digest.periodStart).toBe("2026-09-14T00:00:00.000Z");
    expect(digest.periodEnd).toBe("2026-09-15T00:00:00.000Z");
    expect(digest.generatedAt).toBe("2026-09-14T03:00:00.000Z");
  });

  it("keeps the same dedup key for any time within the same UTC day", () => {
    const morning = buildDailyDigest(automation(), "2026-09-14T00:00:01.000Z");
    const night = buildDailyDigest(automation(), "2026-09-14T23:59:59.000Z");
    expect(morning.dedupKey).toBe(night.dedupKey);
  });

  it("changes the dedup key across a UTC midnight boundary", () => {
    const before = buildDailyDigest(automation(), "2026-09-14T23:59:59.000Z");
    const after = buildDailyDigest(automation(), "2026-09-15T00:00:00.000Z");
    expect(before.dedupKey).not.toBe(after.dedupKey);
  });

  it("represents a clean run as ok with a per-step summary", () => {
    const digest = buildDailyDigest(automation(), "2026-09-14T03:00:00.000Z");

    expect(digestStatus(automation())).toBe("ok");
    expect(digest.payload.status).toBe("ok");
    expect(digest.summary).toBe(
      "discovery ok: 3 discovered, 2 persisted; scoring ok: 2 scored, 0 skipped; alerts ok: 1 created, 0 resolved",
    );
    expect(digest.payload.discovery).toMatchObject({ status: "ok", platform: "tiktok-shop", persisted: 2 });
    expect(digest.payload.scoring).toMatchObject({ status: "ok", scored: 2 });
    expect(digest.payload.alerts).toMatchObject({ status: "ok", created: 1 });
  });

  it("represents a failed discovery as an error without inventing downstream results", () => {
    const failed = automation({
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
    });

    const digest = buildDailyDigest(failed, "2026-09-14T03:00:00.000Z");
    expect(digestStatus(failed)).toBe("error");
    expect(digest.payload.status).toBe("error");
    expect(digest.summary).toBe("discovery error (BLOCKED); scoring not run; alerts not run");
  });

  it("represents a skipped run as skipped", () => {
    const skipped = automation({
      discovery: {
        status: "skipped",
        code: "SUPABASE_NOT_CONFIGURED",
        message: "Supabase is not configured",
        query: "earbuds",
        region: null,
        limit: 20,
        durationMs: 1,
      },
      scoring: null,
      alerts: null,
    });

    expect(digestStatus(skipped)).toBe("skipped");
    expect(buildDailyDigest(skipped, "2026-09-14T03:00:00.000Z").payload.status).toBe("skipped");
  });

  it("represents a partial run when a downstream step never produced a summary", () => {
    const partial = automation({
      discovery: OK_DISCOVERY,
      scoring: { ...OK_SCORING, status: "error", code: "PRODUCT_LIST_FAILED", message: "storage down", scored: 0 },
      alerts: null,
    });

    const digest = buildDailyDigest(partial, "2026-09-14T03:00:00.000Z");
    expect(digestStatus(partial)).toBe("error");
    expect(digest.payload.status).toBe("error");
    expect(digest.summary).toContain("scoring error (PRODUCT_LIST_FAILED)");
    expect(digest.summary).toContain("alerts not run");
  });

  it("downgrades to partial when discovery succeeds but downstream steps are absent", () => {
    const partial = automation({ discovery: OK_DISCOVERY, scoring: null, alerts: null });
    expect(digestStatus(partial)).toBe("partial");
    expect(buildDailyDigest(partial, "2026-09-14T03:00:00.000Z").payload.status).toBe("partial");
  });

  it("marks a partial run when a downstream step was skipped", () => {
    const partial = automation({
      discovery: OK_DISCOVERY,
      scoring: { ...OK_SCORING, status: "skipped", code: "SUPABASE_NOT_CONFIGURED" },
      alerts: null,
    });
    expect(digestStatus(partial)).toBe("partial");
  });

  it("exposes payload and summary builders directly", () => {
    expect(dailyDigestPayload(automation())).toMatchObject({ status: "ok" });
    expect(dailyDigestSummary(automation())).toContain("discovery ok");
  });
});
