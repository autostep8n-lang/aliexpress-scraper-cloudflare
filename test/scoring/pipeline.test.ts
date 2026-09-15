import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { runAutomatedScoring, scorePersistedProduct } from "../../src/scoring/pipeline";
import { createMockPostgrest, type MockPostgrest, type StoredRow } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const LAST_SEEN = "2026-08-18T10:00:00.000Z";

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function productRow(id: string, overrides: Record<string, unknown> = {}): StoredRow {
  return { id, title: `Product ${id}`, last_seen_at: LAST_SEEN, ...overrides };
}

function observationRow(
  id: string,
  productId: string,
  overrides: Record<string, unknown> = {},
): StoredRow {
  return {
    id,
    product_id: productId,
    external_id: `ext-${id}`,
    rating_average: 4.5,
    rating_count: 120,
    last_seen_at: LAST_SEEN,
    ...overrides,
  };
}

describe("runAutomatedScoring", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("persists a market_opportunity score from real observation rating data", async () => {
    server = createMockPostgrest();
    server.seed("products", [productRow("p-1")]);
    server.seed("product_sources", [observationRow("o-1", "p-1")]);
    vi.stubGlobal("fetch", server.fetch);

    const summary = await runAutomatedScoring(configuredEnv());

    expect(summary).toMatchObject({
      status: "ok",
      total: 1,
      scored: 1,
      skipped: 0,
      failed: 0,
      persisted: 1,
    });
    expect(server.store.scores).toHaveLength(1);
    const row = server.store.scores[0];
    expect(row.product_id).toBe("p-1");
    expect(row.score_type).toBe("market_opportunity");
    expect(row.version).toBe(1);
    expect(Number(row.value)).toBeGreaterThan(0);
    expect(row.computed_at).toBe(LAST_SEEN);
    expect(server.store.scores.some((candidate) => candidate.score_type === "competition")).toBe(false);
  });

  it("skips a product with no demand data, with an explicit reason", async () => {
    server = createMockPostgrest();
    server.seed("products", [productRow("p-1")]);
    server.seed("product_sources", [
      observationRow("o-1", "p-1", { rating_average: null, rating_count: null }),
    ]);
    vi.stubGlobal("fetch", server.fetch);

    const summary = await runAutomatedScoring(configuredEnv());

    expect(summary).toMatchObject({ status: "ok", total: 1, scored: 0, skipped: 1, failed: 0, persisted: 0 });
    expect(summary.reasons).toEqual({ NO_DEMAND_DATA: 1 });
    expect(server.store.scores).toHaveLength(0);
  });

  it("skips a product that has no observation, with an explicit reason", async () => {
    server = createMockPostgrest();
    server.seed("products", [productRow("p-1")]);
    vi.stubGlobal("fetch", server.fetch);

    const summary = await runAutomatedScoring(configuredEnv());

    expect(summary).toMatchObject({ status: "ok", total: 1, skipped: 1, scored: 0, persisted: 0 });
    expect(summary.reasons).toEqual({ NO_OBSERVATION_DATA: 1 });
  });

  it("handles an empty product set without writing anything", async () => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);

    const summary = await runAutomatedScoring(configuredEnv());

    expect(summary).toMatchObject({ status: "ok", total: 0, scored: 0, skipped: 0, failed: 0, persisted: 0 });
    expect(server.store.scores).toHaveLength(0);
  });

  it("scores multiple products in one batch", async () => {
    server = createMockPostgrest();
    server.seed("products", [productRow("p-1"), productRow("p-2")]);
    server.seed("product_sources", [observationRow("o-1", "p-1"), observationRow("o-2", "p-2")]);
    vi.stubGlobal("fetch", server.fetch);

    const summary = await runAutomatedScoring(configuredEnv());

    expect(summary).toMatchObject({ status: "ok", total: 2, scored: 2, persisted: 2 });
    expect(server.store.scores).toHaveLength(2);
  });

  it("isolates a per-product scoring failure and keeps processing the batch", async () => {
    server = createMockPostgrest();
    server.seed("products", [productRow("p-1"), productRow("p-2")]);
    server.seed("product_sources", [observationRow("o-1", "p-1"), observationRow("o-2", "p-2")]);
    vi.stubGlobal("fetch", server.fetch);

    const summary = await runAutomatedScoring(configuredEnv(), {
      scoreOne: (product, observation) => {
        if (product.id === "p-2") throw new Error("boom");
        return scorePersistedProduct(product, observation);
      },
    });

    expect(summary).toMatchObject({ status: "ok", total: 2, scored: 1, failed: 1, skipped: 0, persisted: 1 });
    expect(summary.reasons).toEqual({ SCORING_FAILED: 1 });
    expect(server.store.scores).toHaveLength(1);
    expect(server.store.scores[0].product_id).toBe("p-1");
  });

  it("reports a persistence failure without aborting the run", async () => {
    server = createMockPostgrest();
    server.seed("products", [productRow("p-1")]);
    server.seed("product_sources", [observationRow("o-1", "p-1")]);
    server.override("POST", "/rest/v1/scores", 500, { message: "boom" });
    vi.stubGlobal("fetch", server.fetch);

    const summary = await runAutomatedScoring(configuredEnv());

    expect(summary).toMatchObject({ status: "ok", total: 1, scored: 0, failed: 1, persisted: 0 });
    expect(summary.reasons).toEqual({ SCORES_UPSERT_FAILED: 1 });
  });

  it("pages products in bounded batches instead of loading them all at once", async () => {
    server = createMockPostgrest();
    server.seed("products", [productRow("p-1"), productRow("p-2"), productRow("p-3")]);
    server.seed("product_sources", [
      observationRow("o-1", "p-1"),
      observationRow("o-2", "p-2"),
      observationRow("o-3", "p-3"),
    ]);
    vi.stubGlobal("fetch", server.fetch);

    const summary = await runAutomatedScoring(configuredEnv(), { batchSize: 2 });

    expect(summary).toMatchObject({ status: "ok", total: 3, scored: 3, persisted: 3 });
    const productListRequests = server.requests.filter(
      (request) => request.method === "GET" && request.url.includes("/rest/v1/products"),
    );
    expect(productListRequests.length).toBeGreaterThanOrEqual(2);
  });

  it("honors the maxProducts bound", async () => {
    server = createMockPostgrest();
    server.seed("products", [productRow("p-1"), productRow("p-2"), productRow("p-3")]);
    server.seed("product_sources", [
      observationRow("o-1", "p-1"),
      observationRow("o-2", "p-2"),
      observationRow("o-3", "p-3"),
    ]);
    vi.stubGlobal("fetch", server.fetch);

    const summary = await runAutomatedScoring(configuredEnv(), { batchSize: 2, maxProducts: 2 });

    expect(summary).toMatchObject({ status: "ok", total: 2, scored: 2, persisted: 2 });
  });

  it("is idempotent and deterministic across repeated runs", async () => {
    server = createMockPostgrest();
    server.seed("products", [productRow("p-1")]);
    server.seed("product_sources", [observationRow("o-1", "p-1")]);
    vi.stubGlobal("fetch", server.fetch);

    const first = await runAutomatedScoring(configuredEnv());
    const valueAfterFirst = server.store.scores[0].value;
    const second = await runAutomatedScoring(configuredEnv());

    expect(first).toMatchObject({ status: "ok", scored: 1, persisted: 1 });
    expect(second).toMatchObject({ status: "ok", scored: 1, persisted: 1 });
    expect(server.store.scores).toHaveLength(1);
    expect(server.store.scores[0].value).toBe(valueAfterFirst);
  });

  it("skips cleanly when Supabase is not configured", async () => {
    server = createMockPostgrest();
    const fetchSpy = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchSpy);

    const summary = await runAutomatedScoring({} as Env);

    expect(summary).toMatchObject({ status: "skipped", total: 0, code: "SUPABASE_NOT_CONFIGURED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a typed error when the product listing fails", async () => {
    server = createMockPostgrest();
    server.override("GET", "/rest/v1/products", 500, { message: "boom" });
    vi.stubGlobal("fetch", server.fetch);

    const summary = await runAutomatedScoring(configuredEnv());

    expect(summary).toMatchObject({ status: "error", code: "product_list_failed" });
    expect(summary.message).toContain("boom");
  });
});

describe("scorePersistedProduct", () => {
  it("returns a skip reason when there is no observation", () => {
    const outcome = scorePersistedProduct(
      { id: "p-1" } as Parameters<typeof scorePersistedProduct>[0],
      undefined,
    );
    expect(outcome.rows).toHaveLength(0);
    expect(outcome.reason).toBe("NO_OBSERVATION_DATA");
  });
});
