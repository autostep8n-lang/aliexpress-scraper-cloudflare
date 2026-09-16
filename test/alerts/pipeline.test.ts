import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import {
  countryOpportunityEvidence,
  latestMarketOpportunities,
  loadAlertsPage,
  runAutomatedAlerts,
} from "../../src/alerts/pipeline";
import type { CountryOpportunityPersistedRow } from "../../src/country/types";
import type { PersistedScoreRecord } from "../../src/supabase/repository";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const PRODUCT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function product(id: string, lifecycleStatus = "active", lastSeenAt = "2026-08-18T10:00:00.000Z") {
  return { id, title: id, lifecycle_status: lifecycleStatus, last_seen_at: lastSeenAt };
}

function marketScore(
  productId: string,
  value: number,
  signals: Array<{ present: boolean; weight: number }> = [{ present: true, weight: 0.3 }],
  computedAt = "2026-08-18T10:00:00.000Z",
) {
  return {
    id: `score-${productId}`,
    product_id: productId,
    product_source_id: null,
    score_type: "market_opportunity",
    value,
    min_value: 0,
    max_value: 100,
    version: 1,
    computed_at: computedAt,
    inputs: {
      score_type: "market_opportunity",
      version: 1,
      normalized: value / 100,
      signals: signals.map((signal, index) => ({
        key: `signal_${index}`,
        label: `Signal ${index}`,
        weight: signal.weight,
        value: 1,
        present: signal.present,
        contribution: signal.present ? signal.weight : 0,
      })),
    },
  };
}

function countryScore(productId: string, country: string, value: number, tier = "high") {
  return {
    id: `country-${productId}-${country}`,
    product_id: productId,
    country,
    keyword: "earbuds",
    score_type: "country_opportunity",
    value,
    min_value: 0,
    max_value: 100,
    normalized: value / 100,
    total_weight: 0.5,
    tier,
    version: 1,
    inputs: {},
    country_latest_value: value,
    country_change: null,
    country_direction: "unknown",
    computed_at: "2026-08-18T10:00:00.000Z",
  };
}

function seededAlert(productId: string, alertType: string, dedupKey: string, firstSeenAt: string) {
  return {
    id: `alert-${productId}-${dedupKey}`,
    product_id: productId,
    alert_type: alertType,
    severity: "critical",
    status: "active",
    dedup_key: dedupKey,
    title: "Seeded",
    summary: "Seeded alert",
    inputs: {},
    first_seen_at: firstSeenAt,
    last_seen_at: firstSeenAt,
    resolved_at: null,
  };
}

describe("runAutomatedAlerts", () => {
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

    const result = await runAutomatedAlerts({} as Env);

    expect(result).toMatchObject({ status: "skipped", code: "SUPABASE_NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an ok run with zeroes for an empty catalog", async () => {
    const result = await runAutomatedAlerts(configuredEnv());

    expect(result).toMatchObject({ status: "ok", total: 0, created: 0, resolved: 0, failed: 0 });
    expect(server.store.alerts).toHaveLength(0);
  });

  it("creates alerts from persisted market, country and lifecycle evidence", async () => {
    server.seed("products", [product(PRODUCT, "archived")]);
    server.seed("scores", [marketScore(PRODUCT, 80)]);
    server.seed("country_opportunity_scores", [countryScore(PRODUCT, "SA", 72)]);

    const result = await runAutomatedAlerts(configuredEnv(), { now: () => "2026-08-19T00:00:00.000Z" });

    expect(result).toMatchObject({ status: "ok", total: 1, evaluated: 1, created: 3, resolved: 0, failed: 0 });
    expect(server.store.alerts.map((row) => row.dedup_key).sort()).toEqual([
      "country_opportunity:SA:high",
      "lifecycle:archived",
      "market_opportunity:high",
    ]);
    expect(server.store.alerts.every((row) => row.status === "active")).toBe(true);
    expect(server.store.alerts.every((row) => row.last_seen_at === "2026-08-19T00:00:00.000Z")).toBe(true);
  });

  it("preserves first_seen_at and refreshes last_seen_at on a repeat run", async () => {
    server.seed("products", [product(PRODUCT)]);
    server.seed("scores", [marketScore(PRODUCT, 80)]);
    server.seed("alerts", [seededAlert(PRODUCT, "high_market_opportunity", "market_opportunity:high", "2026-01-01T00:00:00.000Z")]);

    const result = await runAutomatedAlerts(configuredEnv(), { now: () => "2026-08-19T00:00:00.000Z" });

    expect(result.created).toBe(1);
    expect(server.store.alerts).toHaveLength(1);
    expect(server.store.alerts[0].first_seen_at).toBe("2026-01-01T00:00:00.000Z");
    expect(server.store.alerts[0].last_seen_at).toBe("2026-08-19T00:00:00.000Z");
  });

  it("resolves an active alert whose condition has disappeared", async () => {
    server.seed("products", [product(PRODUCT, "active")]);
    server.seed("alerts", [
      seededAlert(PRODUCT, "high_market_opportunity", "market_opportunity:high", "2026-01-01T00:00:00.000Z"),
    ]);

    const result = await runAutomatedAlerts(configuredEnv(), { now: () => "2026-08-19T00:00:00.000Z" });

    expect(result).toMatchObject({ status: "ok", created: 0, resolved: 1, failed: 0 });
    expect(server.store.alerts[0].status).toBe("resolved");
    expect(server.store.alerts[0].resolved_at).toBe("2026-08-19T00:00:00.000Z");
  });

  it("keeps an alert active while its condition still holds", async () => {
    server.seed("products", [product(PRODUCT, "archived")]);
    server.seed("alerts", [
      seededAlert(PRODUCT, "lifecycle_review", "lifecycle:archived", "2026-01-01T00:00:00.000Z"),
    ]);

    const result = await runAutomatedAlerts(configuredEnv(), { now: () => "2026-08-19T00:00:00.000Z" });

    expect(result).toMatchObject({ created: 1, resolved: 0, unchanged: 1 });
    expect(server.store.alerts[0].status).toBe("active");
    expect(server.store.alerts[0].resolved_at).toBeNull();
  });

  it("ignores a market score whose persisted signals carry no weight", async () => {
    server.seed("products", [product(PRODUCT)]);
    server.seed("scores", [marketScore(PRODUCT, 95, [{ present: false, weight: 0.3 }])]);

    const result = await runAutomatedAlerts(configuredEnv());

    expect(result.created).toBe(0);
    expect(server.store.alerts).toHaveLength(0);
  });

  it("ignores a market score with a malformed signal breakdown", async () => {
    server.seed("products", [product(PRODUCT)]);
    server.seed("scores", [{ ...marketScore(PRODUCT, 95), inputs: {} }]);

    const result = await runAutomatedAlerts(configuredEnv());

    expect(result.created).toBe(0);
    expect(server.store.alerts).toHaveLength(0);
  });

  it("keeps lifecycle alerts at zero for the only lifecycle state the pipeline persists", async () => {
    // The existing pipeline never produces or persists lifecycle transitions,
    // so products stay at the ingestion default and no lifecycle_review alert
    // can fire. This documents the P7.31 lifecycle limitation.
    server.seed("products", [product(PRODUCT, "discovered")]);
    server.seed("scores", [marketScore(PRODUCT, 80)]);

    const result = await runAutomatedAlerts(configuredEnv());

    expect(result.status).toBe("ok");
    expect(server.store.alerts.map((row) => row.alert_type)).toEqual(["high_market_opportunity"]);
  });

  it("counts a repository write failure without aborting the run", async () => {
    server.seed("products", [product(PRODUCT, "archived")]);
    server.override("POST", "/rest/v1/alerts", 400, { message: "write rejected" });

    const result = await runAutomatedAlerts(configuredEnv());

    expect(result.status).toBe("ok");
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.reasons?.ALERTS_UPSERT_FAILED).toBeGreaterThanOrEqual(1);
  });

  it("records ALERT_LIST_FAILED when the active-alert read fails", async () => {
    server.seed("products", [product(PRODUCT)]);
    server.override("GET", "/rest/v1/alerts", 500, { message: "read rejected" });

    const result = await runAutomatedAlerts(configuredEnv());

    expect(result.status).toBe("ok");
    expect(result.reasons?.ALERT_LIST_FAILED).toBeGreaterThanOrEqual(1);
  });

  it("bounds the number of products processed per run", async () => {
    server.seed("products", [product(PRODUCT), product(OTHER, "active", "2026-08-17T10:00:00.000Z")]);
    server.seed("scores", [marketScore(PRODUCT, 80), marketScore(OTHER, 80)]);

    const result = await runAutomatedAlerts(configuredEnv(), { maxProducts: 1 });

    expect(result.total).toBe(1);
    expect(server.store.alerts).toHaveLength(1);
  });

  it("never writes to products or leaves alerts via unexpected verbs", async () => {
    server.seed("products", [product(PRODUCT, "archived")]);
    server.seed("scores", [marketScore(PRODUCT, 80)]);

    await runAutomatedAlerts(configuredEnv());

    const productWrites = server.requests.filter(
      (request) => request.url.includes("/rest/v1/products") && request.method !== "GET",
    );
    expect(productWrites).toHaveLength(0);
    const alertDeletes = server.requests.filter(
      (request) => request.url.includes("/rest/v1/alerts") && request.method === "DELETE",
    );
    expect(alertDeletes).toHaveLength(0);
  });
});

describe("alert evidence adapters", () => {
  it("keeps only the latest market score per product", () => {
    const rows = [
      {
        id: "a",
        product_id: PRODUCT,
        product_source_id: null,
        score_type: "market_opportunity",
        value: 90,
        min_value: 0,
        max_value: 100,
        version: 1,
        computed_at: "2026-08-18T10:00:00.000Z",
        inputs: { signals: [{ present: true, weight: 0.5 }] },
      },
      {
        id: "b",
        product_id: PRODUCT,
        product_source_id: null,
        score_type: "market_opportunity",
        value: 40,
        min_value: 0,
        max_value: 100,
        version: 1,
        computed_at: "2026-08-17T10:00:00.000Z",
        inputs: { signals: [{ present: true, weight: 0.5 }] },
      },
      {
        id: "c",
        product_id: PRODUCT,
        product_source_id: null,
        score_type: "competition",
        value: 99,
        min_value: 0,
        max_value: 100,
        version: 1,
        computed_at: "2026-08-18T10:00:00.000Z",
        inputs: {},
      },
    ] as PersistedScoreRecord[];

    expect(latestMarketOpportunities(rows)).toEqual([
      { productId: PRODUCT, scoreType: "market_opportunity", value: 90, totalWeight: 0.5 },
    ]);
  });

  it("reads the effective country weight and keeps invalid weights non-finite", () => {
    const rows = [
      countryScore(PRODUCT, "SA", 70),
      { ...countryScore(OTHER, "US", 70), total_weight: null },
    ] as unknown as CountryOpportunityPersistedRow[];

    const evidence = countryOpportunityEvidence(rows);
    expect(evidence[0]).toMatchObject({ productId: PRODUCT, country: "SA", totalWeight: 0.5, tier: "high" });
    expect(Number.isNaN(evidence[1].totalWeight)).toBe(true);
  });
});

describe("loadAlertsPage", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns only active alerts with the requested page metadata", async () => {
    server.seed("alerts", [
      {
        id: "a",
        product_id: PRODUCT,
        alert_type: "high_market_opportunity",
        severity: "critical",
        status: "active",
        dedup_key: "market_opportunity:high",
        title: "A",
        summary: "A",
        inputs: {},
        last_seen_at: "2026-08-18T10:00:00.000Z",
      },
      {
        id: "b",
        product_id: PRODUCT,
        alert_type: "lifecycle_review",
        severity: "info",
        status: "resolved",
        dedup_key: "lifecycle:inactive",
        title: "B",
        summary: "B",
        inputs: {},
        last_seen_at: "2026-08-19T10:00:00.000Z",
      },
    ]);

    const loaded = await loadAlertsPage(configuredEnv(), { limit: 20, offset: 0 });

    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;
    expect(loaded.data.alerts.map((alert) => alert.id)).toEqual(["a"]);
    expect(loaded.data.page).toEqual({ limit: 20, offset: 0, count: 1 });
  });

  it("returns credentials_missing when Supabase is not configured", async () => {
    const loaded = await loadAlertsPage({} as Env, { limit: 20, offset: 0 });
    expect(loaded).toEqual({ status: "credentials_missing" });
  });
});
