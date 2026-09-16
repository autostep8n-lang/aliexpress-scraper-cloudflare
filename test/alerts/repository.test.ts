import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import {
  listActiveAlertsForProducts,
  listAlerts,
  resolveAlerts,
  upsertAlerts,
  type AlertRow,
} from "../../src/supabase/repository";
import { createMockPostgrest, type MockPostgrest, type RecordedRequest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const ALERT_CONFLICT = "product_id,alert_type,dedup_key";
const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function row(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    product_id: PRODUCT_ID,
    alert_type: "high_market_opportunity",
    severity: "critical",
    status: "active",
    dedup_key: "market_opportunity:high",
    title: "High market opportunity",
    summary: "Market opportunity score 80 meets the high threshold.",
    inputs: { value: 80 },
    last_seen_at: "2026-08-19T00:00:00.000Z",
    resolved_at: null,
    ...overrides,
  };
}

function requestsTo(server: MockPostgrest, method: string, path: string): RecordedRequest[] {
  return server.requests.filter((request) => request.method === method && request.url.includes(path));
}

describe("upsertAlerts", () => {
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

    const result = await upsertAlerts({} as Env, [row()]);

    expect(result).toEqual({ status: "credentials_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns updated with an empty payload without touching the network for no rows", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await upsertAlerts(configuredEnv(), []);

    expect(result).toEqual({ status: "updated", data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a row without a product_id or dedup_key", async () => {
    expect(await upsertAlerts(configuredEnv(), [row({ product_id: "" })])).toMatchObject({ status: "invalid" });
    expect(await upsertAlerts(configuredEnv(), [row({ dedup_key: "" })])).toMatchObject({ status: "invalid" });
  });

  it("inserts alerts with the ON CONFLICT dedup target and no first_seen_at payload", async () => {
    const result = await upsertAlerts(configuredEnv(), [row()]);

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.data).toHaveLength(1);
    expect(server.store.alerts).toHaveLength(1);

    const post = requestsTo(server, "POST", "/rest/v1/alerts")[0];
    expect(new URL(post.url).searchParams.get("on_conflict")).toBe(ALERT_CONFLICT);
    const payload = post.body as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).not.toHaveProperty("first_seen_at");
    expect(payload[0]).toMatchObject({
      product_id: PRODUCT_ID,
      alert_type: "high_market_opportunity",
      severity: "critical",
      status: "active",
      dedup_key: "market_opportunity:high",
      resolved_at: null,
    });
  });

  it("preserves first_seen_at and refreshes last_seen_at on conflict", async () => {
    server.seed("alerts", [
      {
        id: "existing",
        product_id: PRODUCT_ID,
        alert_type: "high_market_opportunity",
        severity: "critical",
        status: "active",
        dedup_key: "market_opportunity:high",
        title: "old",
        summary: "old",
        inputs: {},
        first_seen_at: "2026-01-01T00:00:00.000Z",
        last_seen_at: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const result = await upsertAlerts(configuredEnv(), [row()]);

    expect(result.status).toBe("updated");
    expect(server.store.alerts).toHaveLength(1);
    expect(server.store.alerts[0].first_seen_at).toBe("2026-01-01T00:00:00.000Z");
    expect(server.store.alerts[0].last_seen_at).toBe("2026-08-19T00:00:00.000Z");
  });

  it("reactivates a resolved condition on re-appearance", async () => {
    server.seed("alerts", [
      {
        id: "existing",
        product_id: PRODUCT_ID,
        alert_type: "high_market_opportunity",
        severity: "critical",
        status: "resolved",
        dedup_key: "market_opportunity:high",
        title: "old",
        summary: "old",
        inputs: {},
        resolved_at: "2026-02-01T00:00:00.000Z",
      },
    ]);

    await upsertAlerts(configuredEnv(), [row()]);

    expect(server.store.alerts[0].status).toBe("active");
    expect(server.store.alerts[0].resolved_at).toBeNull();
  });

  it("returns error alerts_upsert_failed when the database rejects the write", async () => {
    server.override("POST", "/rest/v1/alerts", 400, { code: "23505", message: "duplicate key" });

    const result = await upsertAlerts(configuredEnv(), [row()]);

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("alerts_upsert_failed");
  });

  it("never leaks credentials into request URLs", async () => {
    await upsertAlerts(configuredEnv(), [row()]);

    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${SECRET_KEY}`);
    }
  });
});

describe("listActiveAlertsForProducts", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns an empty page without network for no product ids", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await listActiveAlertsForProducts(configuredEnv(), []);

    expect(result).toEqual({ status: "found", data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns credentials_missing when Supabase is not configured", async () => {
    expect(await listActiveAlertsForProducts({} as Env, [PRODUCT_ID])).toEqual({ status: "credentials_missing" });
  });

  it("returns only active alerts for the given products", async () => {
    server.seed("alerts", [
      {
        id: "active",
        product_id: PRODUCT_ID,
        alert_type: "high_market_opportunity",
        severity: "critical",
        status: "active",
        dedup_key: "market_opportunity:high",
        title: "A",
        summary: "A",
        inputs: {},
      },
      {
        id: "resolved",
        product_id: PRODUCT_ID,
        alert_type: "lifecycle_review",
        severity: "info",
        status: "resolved",
        dedup_key: "lifecycle:inactive",
        title: "B",
        summary: "B",
        inputs: {},
      },
    ]);

    const result = await listActiveAlertsForProducts(configuredEnv(), [PRODUCT_ID]);

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.data.map((alert) => alert.id)).toEqual(["active"]);
  });

  it("returns error alert_list_failed when the read fails", async () => {
    server.override("GET", "/rest/v1/alerts", 500, { message: "read rejected" });

    const result = await listActiveAlertsForProducts(configuredEnv(), [PRODUCT_ID]);

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("alert_list_failed");
  });
});

describe("resolveAlerts", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns updated without network for no ids", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveAlerts(configuredEnv(), [], "2026-08-19T00:00:00.000Z");

    expect(result).toEqual({ status: "updated", data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the given alerts resolved with the supplied timestamp", async () => {
    server.seed("alerts", [
      {
        id: "target",
        product_id: PRODUCT_ID,
        alert_type: "high_market_opportunity",
        severity: "critical",
        status: "active",
        dedup_key: "market_opportunity:high",
        title: "A",
        summary: "A",
        inputs: {},
      },
    ]);

    const result = await resolveAlerts(configuredEnv(), ["target"], "2026-08-19T00:00:00.000Z");

    expect(result.status).toBe("updated");
    expect(server.store.alerts[0].status).toBe("resolved");
    expect(server.store.alerts[0].resolved_at).toBe("2026-08-19T00:00:00.000Z");
  });

  it("returns error alerts_resolve_failed when the write fails", async () => {
    server.override("PATCH", "/rest/v1/alerts", 400, { message: "write rejected" });

    const result = await resolveAlerts(configuredEnv(), ["target"], "2026-08-19T00:00:00.000Z");

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("alerts_resolve_failed");
  });
});

describe("listAlerts", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns credentials_missing when Supabase is not configured", async () => {
    expect(await listAlerts({} as Env, { limit: 20, offset: 0 })).toEqual({ status: "credentials_missing" });
  });

  it("returns active alerts newest first and honors the page window", async () => {
    server.seed("alerts", [
      {
        id: "newer",
        product_id: PRODUCT_ID,
        alert_type: "high_market_opportunity",
        severity: "critical",
        status: "active",
        dedup_key: "market_opportunity:high",
        title: "newer",
        summary: "newer",
        inputs: {},
        last_seen_at: "2026-08-19T00:00:00.000Z",
      },
      {
        id: "older",
        product_id: PRODUCT_ID,
        alert_type: "lifecycle_review",
        severity: "info",
        status: "active",
        dedup_key: "lifecycle:inactive",
        title: "older",
        summary: "older",
        inputs: {},
        last_seen_at: "2026-08-18T00:00:00.000Z",
      },
    ]);

    const result = await listAlerts(configuredEnv(), { limit: 1, offset: 0 });

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.data.map((alert) => alert.id)).toEqual(["newer"]);
  });

  it("returns error alert_list_failed when the read fails", async () => {
    server.override("GET", "/rest/v1/alerts", 500, { message: "read rejected" });

    const result = await listAlerts(configuredEnv(), { limit: 20, offset: 0 });

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("alert_list_failed");
  });
});
