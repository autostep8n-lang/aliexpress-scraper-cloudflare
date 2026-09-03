import { describe, expect, it } from "vitest";
import { assembleDiscoveryProducts, parseProductListQuery } from "../../src/dashboard/assemble";
import type { CountryOpportunityPersistedRow } from "../../src/country/types";
import type { PersistedProductRecord, PersistedScoreRecord } from "../../src/supabase/repository";

const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";

function product(overrides: Partial<PersistedProductRecord> = {}): PersistedProductRecord {
  return {
    id: PRODUCT_ID,
    dedup_key: "aliexpress:1",
    canonical_url: "https://www.aliexpress.com/item/1.html",
    title: "Wireless Earbuds",
    description: null,
    brand: "SoundCore",
    category_id: null,
    primary_image_url: "https://img.example.com/a.jpg",
    images: [],
    attributes: {},
    availability_status: "in_stock",
    lifecycle_status: "active",
    last_seen_at: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

function marketScore(normalized: number, computedAt = "2026-08-18T10:00:00.000Z"): PersistedScoreRecord {
  const value = Math.round(normalized * 100);
  return {
    id: "score-market",
    product_id: PRODUCT_ID,
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
      normalized,
      signals: [
        {
          key: "competition_pressure",
          label: "Competition pressure",
          weight: 1,
          value: normalized,
          present: true,
          contribution: normalized,
        },
      ],
    },
  };
}

function countryRow(country: string, normalized: number): CountryOpportunityPersistedRow {
  const value = Math.round(normalized * 100);
  return {
    id: `country-${country}`,
    product_id: PRODUCT_ID,
    country,
    keyword: "wireless earbuds",
    score_type: "country_opportunity",
    value,
    min_value: 0,
    max_value: 100,
    normalized,
    total_weight: 0.6,
    tier: value >= 65 ? "high" : value >= 40 ? "medium" : "low",
    version: 1,
    inputs: {
      score_type: "country_opportunity",
      version: 1,
      normalized,
      signals: [
        {
          key: "country_search_level",
          label: "Country search interest",
          weight: 0.4,
          value: normalized,
          present: true,
          contribution: normalized * 0.4,
        },
      ],
    },
    country_latest_value: 80,
    country_change: 40,
    country_direction: "up",
    computed_at: "2026-08-18T10:00:00.000Z",
    created_at: "2026-08-18T10:00:00.000Z",
    updated_at: "2026-08-18T10:00:00.000Z",
  };
}

describe("parseProductListQuery", () => {
  it("defaults limit 20 and offset 0", () => {
    expect(parseProductListQuery(new URLSearchParams())).toEqual({
      ok: true,
      query: { limit: 20, offset: 0, lifecycle: undefined, q: undefined },
    });
  });

  it("caps limit at 50 and rejects invalid paging/lifecycle", () => {
    const capped = parseProductListQuery(new URLSearchParams("limit=99"));
    expect(capped).toMatchObject({ ok: true, query: { limit: 50 } });
    expect(parseProductListQuery(new URLSearchParams("limit=0"))).toMatchObject({ ok: false, code: "INVALID_LIMIT" });
    expect(parseProductListQuery(new URLSearchParams("offset=-1"))).toMatchObject({ ok: false, code: "INVALID_OFFSET" });
    expect(parseProductListQuery(new URLSearchParams("lifecycle=hot"))).toMatchObject({ ok: false, code: "INVALID_LIFECYCLE" });
  });
});

describe("assembleDiscoveryProducts", () => {
  it("computes P5.24/P5.25 on-read from persisted market and country scores", () => {
    const [row] = assembleDiscoveryProducts([product()], [marketScore(0.4)], [countryRow("SA", 0.8)]);
    expect(row.decision.provider).toBe("template");
    expect(row.decision.score.scoreType).toBe("decision_opportunity");
    expect(row.decision.score.value).toBe(60);
    expect(row.decision.score.tier).toBe("medium");
    expect(row.decision.selectedCountry).toBe("SA");
    expect(row.decision.summary).toContain("Decision opportunity score 60 (medium)");
    expect(row.decision.caveats).toEqual([]);
    expect(JSON.stringify(row)).not.toMatch(/WORLD|facebook|pinterest|social/i);
  });

  it("treats missing market and country as caveats, never as zero opportunity", () => {
    const [row] = assembleDiscoveryProducts([product()], [], []);
    expect(row.decision.score.tier).toBe("unknown");
    expect(row.decision.score.value).toBe(0);
    expect(row.decision.selectedCountry).toBeNull();
    expect(row.decision.caveats).toEqual([
      "product market opportunity is missing",
      "country opportunity is missing",
    ]);
    expect(row.decision.summary).toContain("Caveats:");
  });

  it("uses the latest computed_at score when duplicates exist", () => {
    const older = marketScore(0.9, "2026-08-01T00:00:00.000Z");
    const newer = marketScore(0.4, "2026-08-18T10:00:00.000Z");
    newer.id = "score-market-newer";
    const [row] = assembleDiscoveryProducts([product()], [older, newer], []);
    expect(row.decision.summary).toContain("Product market opportunity 40");
  });

  it("does not expose evidence or ranking fields", () => {
    const [row] = assembleDiscoveryProducts([product()], [marketScore(0.8)], [countryRow("GB", 0.7)]);
    expect(row).not.toHaveProperty("evidence");
    expect(row.decision).not.toHaveProperty("evidence");
    expect(Object.keys(row.decision).sort()).toEqual(["caveats", "provider", "score", "selectedCountry", "summary"]);
  });
});
