import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { upsertCountryOpportunityScores } from "../../src/supabase/repository";
import type { CountryOpportunityObservationRow } from "../../src/country/types";
import { createMockPostgrest, type MockPostgrest, type RecordedRequest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const COUNTRY_OPPORTUNITY_CONFLICT = "product_id,country,score_type";
const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_PRODUCT_ID = "22222222-2222-2222-2222-222222222222";

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function row(overrides: Partial<CountryOpportunityObservationRow> = {}): CountryOpportunityObservationRow {
  return {
    product_id: PRODUCT_ID,
    country: "US",
    keyword: "smart watch",
    score_type: "country_opportunity",
    value: 80,
    min_value: 0,
    max_value: 100,
    normalized: 0.8,
    total_weight: 0.4,
    tier: "high",
    version: 1,
    inputs: { score_type: "country_opportunity", version: 1 },
    country_latest_value: 80,
    country_change: null,
    country_direction: "unknown",
    computed_at: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function requestsTo(server: MockPostgrest, method: string, path: string): RecordedRequest[] {
  return server.requests.filter((request) => request.method === method && request.url.includes(path));
}

describe("upsertCountryOpportunityScores", () => {
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

    const result = await upsertCountryOpportunityScores({} as Env, [row()]);

    expect(result).toEqual({ status: "credentials_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns updated with an empty payload without touching the network for no rows", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await upsertCountryOpportunityScores(configuredEnv(), []);

    expect(result).toEqual({ status: "updated", data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("inserts country opportunity scores without writing public.scores or creating a source", async () => {
    const result = await upsertCountryOpportunityScores(configuredEnv(), [row(), row({ country: "GB" })]);

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.data).toHaveLength(2);
    expect(server.store.country_opportunity_scores).toHaveLength(2);
    expect(server.store.sources).toHaveLength(0);
    expect(server.requests.every((request) => !request.url.includes("/rest/v1/scores"))).toBe(true);
  });

  it("replaces a snapshot instead of duplicating the same product x country x score_type", async () => {
    const first = await upsertCountryOpportunityScores(configuredEnv(), [row()]);
    expect(first.status).toBe("created");

    const second = await upsertCountryOpportunityScores(configuredEnv(), [row({ value: 41, tier: "medium" })]);
    expect(second.status).toBe("updated");
    expect(server.store.country_opportunity_scores).toHaveLength(1);
    expect(server.store.country_opportunity_scores[0].value).toBe(41);
    expect(server.store.country_opportunity_scores[0].tier).toBe("medium");
  });

  it("keeps separate snapshots for different countries or products", async () => {
    await upsertCountryOpportunityScores(configuredEnv(), [row()]);
    await upsertCountryOpportunityScores(configuredEnv(), [row({ country: "SA" })]);
    await upsertCountryOpportunityScores(configuredEnv(), [row({ product_id: OTHER_PRODUCT_ID })]);

    expect(server.store.country_opportunity_scores).toHaveLength(3);
  });

  it("targets the dedup key with on_conflict on the upsert request", async () => {
    await upsertCountryOpportunityScores(configuredEnv(), [row()]);

    const post = requestsTo(server, "POST", "/rest/v1/country_opportunity_scores")[0];
    expect(new URL(post.url).searchParams.get("on_conflict")).toBe(COUNTRY_OPPORTUNITY_CONFLICT);
  });

  it("sends the observation payload for the product x country score", async () => {
    await upsertCountryOpportunityScores(configuredEnv(), [row()]);

    const post = requestsTo(server, "POST", "/rest/v1/country_opportunity_scores")[0];
    const payload = post.body as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      product_id: PRODUCT_ID,
      country: "US",
      keyword: "smart watch",
      score_type: "country_opportunity",
      value: 80,
      min_value: 0,
      max_value: 100,
      normalized: 0.8,
      total_weight: 0.4,
      tier: "high",
      version: 1,
      country_latest_value: 80,
      country_change: null,
      country_direction: "unknown",
    });
  });

  it("returns error country_opportunity_upsert_failed when the database rejects the write", async () => {
    server.override("POST", "/rest/v1/country_opportunity_scores", 400, {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    });

    const result = await upsertCountryOpportunityScores(configuredEnv(), [row()]);

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("country_opportunity_upsert_failed");
  });

  it("never leaks credentials into request URLs", async () => {
    await upsertCountryOpportunityScores(configuredEnv(), [row()]);

    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${SECRET_KEY}`);
    }
  });
});
