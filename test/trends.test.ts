import { describe, expect, it } from "vitest";
import { normalizeProduct } from "../src/products/normalize";
import type { Product } from "../src/products/types";
import {
  TREND_METRIC_TYPES,
  buildObservations,
  computeStats,
  extractProductMetrics,
  normalizeTimestamp,
  snapshotProduct,
  sortPoints,
  summarizeMetric,
  summarizeSeries,
  trendsFromObservations,
} from "../src/trends";
import type { TrendObservationRecord, TrendPoint } from "../src/trends";

const SCRAPED_AT = "2026-01-15T10:00:00.000Z";

function makeProduct(overrides: Record<string, unknown> = {}): Product {
  return normalizeProduct({
    raw: {
      externalId: "1005002",
      title: "Mini Projector",
      price: { amount: 59.99, currency: "usd", originalAmount: 89.99 },
      images: [{ url: "https://img.example.com/projector.jpg" }],
      rating: { average: 4.2, count: 88 },
      available: true,
      scrapedAt: SCRAPED_AT,
      ...overrides,
    },
    platform: "aliexpress",
    url: "https://www.aliexpress.com/item/1005002.html",
  });
}

/** A hand-built product so we can exercise invalid `scrapedAt` timestamps. */
function rawProduct(scrapedAt: string): Product {
  return {
    platform: "aliexpress",
    externalId: "1005002",
    url: "https://www.aliexpress.com/item/1005002.html",
    title: "Mini Projector",
    price: { amount: 59.99, currency: "USD" },
    images: [],
    scrapedAt,
  };
}

const OPTS = { productId: "p-1", productSourceId: "s-1", sourceId: "src-1" };

describe("extractProductMetrics", () => {
  it("extracts price, rating, rating count and availability from a product", () => {
    expect(extractProductMetrics(makeProduct())).toEqual({
      price: 59.99,
      currency: "USD",
      ratingAverage: 4.2,
      ratingCount: 88,
      availability: 1,
    });
  });

  it("returns nulls when rating and availability are missing", () => {
    expect(extractProductMetrics(makeProduct({ rating: undefined, available: undefined }))).toEqual({
      price: 59.99,
      currency: "USD",
      ratingAverage: null,
      ratingCount: null,
      availability: null,
    });
  });

  it("maps availability false to 0", () => {
    expect(extractProductMetrics(makeProduct({ available: false })).availability).toBe(0);
  });
});

describe("buildObservations", () => {
  it("builds one append-only row per present metric in fixed order", () => {
    const rows = buildObservations(makeProduct(), OPTS);
    expect(rows.map((row) => row.metric_type)).toEqual(["price", "rating", "rating_count", "availability"]);
    expect(rows.map((row) => row.metric_type)).toEqual([...TREND_METRIC_TYPES]);

    expect(rows[0]).toEqual({
      product_id: "p-1",
      product_source_id: "s-1",
      source_id: "src-1",
      metric_type: "price",
      value: 59.99,
      unit: "USD",
      captured_at: SCRAPED_AT,
      metadata: { platform: "aliexpress", externalId: "1005002" },
    });
    expect(rows[1]).toMatchObject({ metric_type: "rating", value: 4.2, unit: null });
    expect(rows[2]).toMatchObject({ metric_type: "rating_count", value: 88, unit: null });
    expect(rows[3]).toMatchObject({ metric_type: "availability", value: 1, unit: null });
  });

  it("omits metrics the product does not carry", () => {
    const rows = buildObservations(makeProduct({ rating: undefined, available: undefined }), OPTS);
    expect(rows.map((row) => row.metric_type)).toEqual(["price"]);
  });

  it("defaults captured_at to product.scrapedAt and honors an override", () => {
    const product = makeProduct();
    const defaulted = buildObservations(product, { productId: "p-1" });
    expect(defaulted[0].captured_at).toBe(SCRAPED_AT);

    const overridden = buildObservations(product, { productId: "p-1", capturedAt: "2026-02-01T00:00:00.000Z" });
    expect(overridden[0].captured_at).toBe("2026-02-01T00:00:00.000Z");
  });

  it("falls back to scrapedAt when the override is invalid and returns [] when none is valid", () => {
    const product = makeProduct();
    expect(buildObservations(product, { productId: "p-1", capturedAt: "not-a-date" })[0].captured_at).toBe(SCRAPED_AT);
    expect(buildObservations(rawProduct("garbage"), { productId: "p-1" })).toEqual([]);
  });

  it("merges caller metadata and is deterministic", () => {
    const product = makeProduct();
    const rows = buildObservations(product, { ...OPTS, metadata: { run: "manual" } });
    expect(rows[0].metadata).toEqual({ run: "manual", platform: "aliexpress", externalId: "1005002" });
    expect(buildObservations(product, OPTS)).toEqual(buildObservations(product, OPTS));
  });
});

describe("normalizeTimestamp", () => {
  it("accepts valid ISO timestamps and rejects garbage", () => {
    expect(normalizeTimestamp(SCRAPED_AT)).toBe(SCRAPED_AT);
    expect(normalizeTimestamp("not-a-date")).toBeNull();
  });
});

describe("sortPoints", () => {
  it("sorts ascending and drops invalid points", () => {
    const points: TrendPoint[] = [
      { at: "2026-01-03T00:00:00.000Z", value: 3 },
      { at: "garbage", value: 99 },
      { at: "2026-01-01T00:00:00.000Z", value: 1 },
      { at: "2026-01-02T00:00:00.000Z", value: Number.NaN },
      { at: "2026-01-02T00:00:00.000Z", value: 2 },
    ];
    expect(sortPoints(points)).toEqual([
      { at: "2026-01-01T00:00:00.000Z", value: 1 },
      { at: "2026-01-02T00:00:00.000Z", value: 2 },
      { at: "2026-01-03T00:00:00.000Z", value: 3 },
    ]);
  });

  it("breaks timestamp ties deterministically by value", () => {
    const t = "2026-01-01T00:00:00.000Z";
    expect(sortPoints([{ at: t, value: 2 }, { at: t, value: 1 }])).toEqual([
      { at: t, value: 1 },
      { at: t, value: 2 },
    ]);
  });
});

describe("computeStats", () => {
  it("handles an empty series", () => {
    expect(computeStats([])).toEqual({
      count: 0,
      first: null,
      last: null,
      change: null,
      direction: "unknown",
      min: null,
      max: null,
      spanMs: null,
      velocityPerDay: null,
    });
  });

  it("handles a single point", () => {
    const point = { at: "2026-01-01T00:00:00.000Z", value: 10 };
    const stats = computeStats([point]);
    expect(stats.count).toBe(1);
    expect(stats.first).toEqual(point);
    expect(stats.last).toEqual(point);
    expect(stats.min).toEqual(point);
    expect(stats.max).toEqual(point);
    expect(stats.change).toBeNull();
    expect(stats.direction).toBe("unknown");
    expect(stats.spanMs).toBeNull();
    expect(stats.velocityPerDay).toBeNull();
  });

  it("derives change, direction, span and velocity per day", () => {
    const stats = computeStats([
      { at: "2026-01-01T00:00:00.000Z", value: 10 },
      { at: "2026-01-03T00:00:00.000Z", value: 20 },
    ]);
    expect(stats.count).toBe(2);
    expect(stats.first).toEqual({ at: "2026-01-01T00:00:00.000Z", value: 10 });
    expect(stats.last).toEqual({ at: "2026-01-03T00:00:00.000Z", value: 20 });
    expect(stats.change).toBe(10);
    expect(stats.direction).toBe("up");
    expect(stats.spanMs).toBe(172_800_000);
    expect(stats.velocityPerDay).toBe(5);
  });

  it("detects downward and flat directions", () => {
    expect(computeStats([
      { at: "2026-01-01T00:00:00.000Z", value: 30 },
      { at: "2026-01-02T00:00:00.000Z", value: 10 },
    ]).direction).toBe("down");
    expect(computeStats([
      { at: "2026-01-01T00:00:00.000Z", value: 5 },
      { at: "2026-01-02T00:00:00.000Z", value: 5 },
    ])).toMatchObject({ change: 0, direction: "flat", velocityPerDay: 0 });
  });

  it("returns null velocity when the series has no time span", () => {
    const t = "2026-01-01T00:00:00.000Z";
    expect(computeStats([{ at: t, value: 5 }, { at: t, value: 7 }]).velocityPerDay).toBeNull();
  });

  it("picks the earliest observation on min/max ties", () => {
    const stats = computeStats([
      { at: "2026-01-01T00:00:00.000Z", value: 5 },
      { at: "2026-01-02T00:00:00.000Z", value: 3 },
      { at: "2026-01-03T00:00:00.000Z", value: 8 },
      { at: "2026-01-04T00:00:00.000Z", value: 3 },
    ]);
    expect(stats.min).toEqual({ at: "2026-01-02T00:00:00.000Z", value: 3 });
    expect(stats.max).toEqual({ at: "2026-01-03T00:00:00.000Z", value: 8 });
  });
});

describe("summarizeMetric / summarizeSeries", () => {
  it("returns stats plus a sorted series for the metric type", () => {
    const summary = summarizeMetric("price", [
      { at: "2026-01-03T00:00:00.000Z", value: 30 },
      { at: "2026-01-01T00:00:00.000Z", value: 10 },
    ]);
    expect(summary.metricType).toBe("price");
    expect(summary.count).toBe(2);
    expect(summary.direction).toBe("up");
    expect(summary.series).toEqual({
      metricType: "price",
      points: [
        { at: "2026-01-01T00:00:00.000Z", value: 10 },
        { at: "2026-01-03T00:00:00.000Z", value: 30 },
      ],
    });
  });

  it("is independent of input order", () => {
    const p1 = { at: "2026-01-01T00:00:00.000Z", value: 10 };
    const p2 = { at: "2026-01-02T00:00:00.000Z", value: 20 };
    const p3 = { at: "2026-01-03T00:00:00.000Z", value: 30 };
    expect(summarizeMetric("price", [p3, p1, p2])).toEqual(summarizeMetric("price", [p1, p2, p3]));
  });

  it("summarizeSeries delegates to summarizeMetric", () => {
    const series = {
      metricType: "rating" as const,
      points: [
        { at: "2026-01-01T00:00:00.000Z", value: 4 },
        { at: "2026-01-02T00:00:00.000Z", value: 5 },
      ],
    };
    expect(summarizeSeries(series)).toEqual(summarizeMetric("rating", series.points));
  });
});

describe("snapshotProduct", () => {
  it("returns the productId, capturedAt and append-only observations", () => {
    const snapshot = snapshotProduct(makeProduct(), OPTS);
    expect(snapshot.productId).toBe("p-1");
    expect(snapshot.capturedAt).toBe(SCRAPED_AT);
    expect(snapshot.observations).toEqual(buildObservations(makeProduct(), OPTS));
  });

  it("reports an empty capturedAt when nothing could be built", () => {
    const snapshot = snapshotProduct(rawProduct("garbage"), { productId: "p-1" });
    expect(snapshot.capturedAt).toBe("");
    expect(snapshot.observations).toEqual([]);
  });
});

describe("trendsFromObservations", () => {
  function record(partial: { metric_type: string } & Record<string, unknown>): TrendObservationRecord {
    return {
      id: "id",
      created_at: "2026-01-01T00:00:00.000Z",
      product_id: "p-1",
      product_source_id: null,
      source_id: null,
      value: 0,
      unit: null,
      captured_at: "2026-01-01T00:00:00.000Z",
      metadata: {},
      ...partial,
    } as TrendObservationRecord;
  }

  it("groups rows into sorted series and summaries per metric", () => {
    const records = [
      record({ id: "a", metric_type: "price", value: 20, unit: "USD", captured_at: "2026-01-03T00:00:00.000Z" }),
      record({ id: "b", metric_type: "price", value: 10, unit: "USD", captured_at: "2026-01-01T00:00:00.000Z" }),
      record({ id: "c", metric_type: "rating", value: 4.5, captured_at: "2026-01-02T00:00:00.000Z" }),
    ];
    const { series, summaries } = trendsFromObservations(records);

    expect(summaries.map((summary) => summary.metricType)).toEqual([...TREND_METRIC_TYPES]);
    expect(series[0]).toEqual({
      metricType: "price",
      points: [
        { at: "2026-01-01T00:00:00.000Z", value: 10 },
        { at: "2026-01-03T00:00:00.000Z", value: 20 },
      ],
    });
    expect(summaries[0]).toMatchObject({ metricType: "price", count: 2, change: 10, direction: "up", velocityPerDay: 5 });
    expect(summaries[1]).toMatchObject({ metricType: "rating", count: 1, direction: "unknown" });
    expect(summaries[2]).toMatchObject({ metricType: "rating_count", count: 0 });
    expect(summaries[3]).toMatchObject({ metricType: "availability", count: 0 });
  });

  it("skips unknown metric types, invalid timestamps and non-finite values", () => {
    const records = [
      record({ id: "a", metric_type: "sales", value: 9, captured_at: "2026-01-01T00:00:00.000Z" }),
      record({ id: "b", metric_type: "price", value: 10, captured_at: "garbage" }),
      record({ id: "c", metric_type: "price", value: "not-a-number", captured_at: "2026-01-01T00:00:00.000Z" }),
    ];
    const { summaries } = trendsFromObservations(records);
    expect(summaries[0]).toMatchObject({ metricType: "price", count: 0 });
  });
});
