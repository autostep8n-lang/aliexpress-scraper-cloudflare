import { describe, expect, it } from "vitest";
import {
  assessMarketOpportunity,
  demandFromProduct,
  opportunityFromProduct,
  scoreCompetition,
  toOpportunityRows,
} from "../src/opportunity";
import type { CompetitionInput, OpportunityInput } from "../src/opportunity";
import type { Product } from "../src/products/types";
import { computeProfit, profitInputFromProduct } from "../src/profit";
import { summarizeMetric } from "../src/trends";

function competition(overrides: Partial<CompetitionInput> = {}): CompetitionInput {
  return { ...overrides };
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    platform: "aliexpress",
    externalId: "item-1",
    url: "https://example.com/item-1",
    title: "Wireless Earbuds",
    price: { amount: 30, currency: "USD" },
    images: [{ url: "https://example.com/img.jpg" }],
    rating: { average: 4.5, count: 1200 },
    scrapedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function profit(overrides: Partial<Parameters<typeof computeProfit>[0]> = {}) {
  return computeProfit({
    currency: "USD",
    sellingPrice: 30,
    supplierCost: 15,
    shippingCost: 3,
    platformFees: { rate: 0.02 },
    ...overrides,
  });
}

function ratingTrend(points: Array<[string, number]>) {
  return summarizeMetric("rating", points.map(([at, value]) => ({ at, value })));
}

describe("scoreCompetition", () => {
  it("returns 0 when no competition data was observed", () => {
    const result = scoreCompetition(competition());
    expect(result.scoreType).toBe("competition");
    expect(result.version).toBe(1);
    expect(result.value).toBe(0);
    expect(result.maxValue).toBe(100);
  });

  it("scores an observed empty market as zero pressure but present", () => {
    const result = scoreCompetition(competition({ competitorCount: 0, sourceCount: 0 }));
    expect(result.value).toBe(0);
    expect(result.totalWeight).toBeCloseTo(0.5, 4);
  });

  it("scores competitive pressure higher with more competitors and sources", () => {
    const low = scoreCompetition(competition({ competitorCount: 2, sourceCount: 1 }));
    const high = scoreCompetition(competition({ competitorCount: 500, sourceCount: 20 }));
    expect(high.value).toBeGreaterThan(low.value);
    expect(high.value).toBeLessThanOrEqual(100);
  });

  it("treats priced-above-median as pressure and priced-below-median as advantage", () => {
    const above = scoreCompetition(
      competition({ competitorCount: 10, sourceCount: 3, ownPrice: 150, competitorPrices: [100, 100, 100] }),
    );
    const below = scoreCompetition(
      competition({ competitorCount: 10, sourceCount: 3, ownPrice: 50, competitorPrices: [100, 100, 100] }),
    );
    expect(above.value).toBeGreaterThan(below.value);
  });

  it("only counts signals that carry data (present weight tracks inputs)", () => {
    const result = scoreCompetition(competition({ competitorCount: 9, sourceCount: 0 }));
    const present = result.signals.filter((signal) => signal.present);
    expect(present.map((signal) => signal.key).sort()).toEqual(["competitor_volume", "source_breadth"]);
    expect(result.totalWeight).toBeCloseTo(0.5, 4);
  });

  it("ignores missing optional fields without crashing", () => {
    const result = scoreCompetition(competition({ competitorCount: 3, sourceCount: 1, competitorPrices: [] }));
    const keys = result.signals.filter((signal) => signal.present).map((signal) => signal.key);
    expect(keys).toEqual(expect.arrayContaining(["competitor_volume", "source_breadth"]));
    expect(keys).not.toContain("price_positioning");
  });

  it("rejects invalid inputs as not present", () => {
    const result = scoreCompetition(
      competition({ competitorCount: -5, sourceCount: Number.NaN, dominantCompetitorShare: 2 }),
    );
    const present = result.signals.filter((signal) => signal.present);
    expect(present.map((signal) => signal.key)).toEqual([]);
  });
});

describe("assessMarketOpportunity", () => {
  it("scores low competition, high demand and healthy margin as a high opportunity", () => {
    const result = assessMarketOpportunity({
      competition: competition({ competitorCount: 1, sourceCount: 1 }),
      demand: { rating: { count: 5000, average: 4.8 }, ratingTrend: ratingTrend([["2026-01-01", 3], ["2026-01-02", 4]]) },
      profit: profit({ supplierCost: 10, sellingPrice: 30 }),
    });
    expect(result.score.scoreType).toBe("market_opportunity");
    expect(result.score.totalWeight).toBeCloseTo(1, 4);
    expect(result.tier).toBe("high");
    expect(result.score.value).toBeGreaterThanOrEqual(65);
  });

  it("ranks a heavily contested, thin-margin product as low opportunity", () => {
    const result = assessMarketOpportunity({
      competition: competition({
        competitorCount: 500,
        sourceCount: 20,
        competitorRatingCount: 1_000_000,
        ownPrice: 40,
        competitorPrices: [20, 20, 20],
      }),
      demand: { rating: { count: 1, average: 2.5 }, ratingTrend: ratingTrend([["2026-01-01", 4], ["2026-01-02", 2]]) },
      profit: profit({ supplierCost: 38, sellingPrice: 40 }),
    });
    expect(result.tier).toBe("low");
    expect(result.score.value).toBeLessThan(40);
  });

  it("reports tier 'unknown' when no opportunity signal carries data", () => {
    const result = assessMarketOpportunity({ competition: competition() });
    expect(result.score.totalWeight).toBe(0);
    expect(result.tier).toBe("unknown");
  });

  it("does not treat unobserved competition as a headroom bonus", () => {
    const empty = assessMarketOpportunity({ competition: competition() });
    const competitionSignal = empty.score.signals.find((signal) => signal.key === "competition_pressure");
    expect(competitionSignal?.present).toBe(false);
  });

  it("treats an observed empty market as full headroom", () => {
    const empty = assessMarketOpportunity({ competition: competition({ competitorCount: 0, sourceCount: 0 }) });
    const competitionSignal = empty.score.signals.find((signal) => signal.key === "competition_pressure");
    expect(competitionSignal?.present).toBe(true);
    expect(competitionSignal?.value).toBe(1);
  });

  it("is fully deterministic for identical inputs", () => {
    const input: OpportunityInput = {
      competition: competition({ competitorCount: 5, sourceCount: 2, ownPrice: 25, competitorPrices: [20, 30] }),
      demand: { rating: { count: 100 }, ratingTrend: ratingTrend([["2026-01-01", 1], ["2026-01-02", 1]]) },
      profit: profit(),
    };
    const a = assessMarketOpportunity(input);
    const b = assessMarketOpportunity(input);
    expect(b).toEqual(a);
  });
});

describe("demandFromProduct", () => {
  it("extracts rating count and average from a product", () => {
    expect(demandFromProduct(product())).toEqual({ rating: { count: 1200, average: 4.5 } });
  });

  it("returns an empty demand when the product has no rating", () => {
    expect(demandFromProduct(product({ rating: undefined }))).toEqual({});
  });
});

describe("opportunityFromProduct", () => {
  it("composes product rating, rating trend and profit into an assessment", () => {
    const p = product();
    const trend = ratingTrend([["2026-01-01", 3], ["2026-01-02", 5]]);
    const result = opportunityFromProduct(
      p,
      competition({ competitorCount: 2, sourceCount: 1 }),
      { trends: { rating: trend }, profit: profit() },
    );
    expect(result.tier).toBe("high");
    const momentum = result.score.signals.find((signal) => signal.key === "demand_momentum");
    expect(momentum?.present).toBe(true);
    expect(momentum?.detail).toBe("rating trend up");
  });

  it("derives demand from the product and profit from the product adapter", () => {
    const p = product({ rating: { average: 4.2, count: 800 } });
    const costs = profitInputFromProduct(p, { supplierCost: 12 });
    const result = assessMarketOpportunity({
      competition: competition({ competitorCount: 3, sourceCount: 1 }),
      demand: demandFromProduct(p),
      profit: computeProfit(costs),
    });
    expect(result.tier).toBe("high");
  });
});

describe("toOpportunityRows", () => {
  it("maps competition and opportunity scores to scores table rows", () => {
    const result = assessMarketOpportunity({
      competition: competition({ competitorCount: 2, sourceCount: 1 }),
      demand: { rating: { count: 500 }, ratingTrend: ratingTrend([["2026-01-01", 1], ["2026-01-02", 2]]) },
      profit: profit(),
    });
    const rows = toOpportunityRows(result, { productId: "p-1", productSourceId: "ps-1" });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.score_type)).toEqual(["competition", "market_opportunity"]);
    for (const row of rows) {
      expect(row.product_id).toBe("p-1");
      expect(row.product_source_id).toBe("ps-1");
      expect(row.value).toBeGreaterThanOrEqual(0);
      expect(row.min_value).toBe(0);
      expect(row.max_value).toBe(100);
      expect(row.version).toBe(1);
    }
    expect(rows[1].inputs).toMatchObject({ score_type: "market_opportunity" });
  });
});
