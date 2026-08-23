import { describe, expect, it } from "vitest";
import {
  clamp,
  computeScore,
  PRODUCT_QUALITY_SIGNALS,
  scoreProductQuality,
  toScoreRow,
} from "../src/scoring";
import type { Product, ProductCategory, ProductRating, ProductShipping } from "../src/products/types";
import type { ScoreSignalDefinition } from "../src/scoring/types";

const BASE_URL = "https://www.aliexpress.com/item/1005001.html";

function product(overrides: Partial<Product> = {}): Product {
  return {
    platform: "aliexpress",
    externalId: "1005001",
    url: BASE_URL,
    title: "Wireless Earbuds",
    price: { amount: 19.99, currency: "USD" },
    images: [{ url: "https://img.example.com/a.jpg" }],
    scrapedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function rating(overrides: Partial<ProductRating> = {}): ProductRating {
  return { average: 4.5, count: 120, ...overrides };
}

function shipping(overrides: Partial<ProductShipping> = {}): ProductShipping {
  return { free: true, deliveryMinDays: 3, deliveryMaxDays: 7, ...overrides };
}

function category(overrides: Partial<ProductCategory> = {}): ProductCategory {
  return { name: "Electronics", path: ["Electronics", "Audio"], ...overrides };
}

function signalOf(result: ReturnType<typeof scoreProductQuality>, key: string) {
  const signal = result.signals.find((s) => s.key === key);
  if (!signal) throw new Error(`missing signal ${key}`);
  return signal;
}

describe("clamp", () => {
  it("bounds values to the given range", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

describe("computeScore (engine)", () => {
  const flat = (value: number, present = true): ScoreSignalDefinition<string> => ({
    key: `k${value}`,
    label: `K ${value}`,
    weight: 1,
    evaluate: () => ({ present, value }),
  });

  it("aggregates present signals as a weighted mean bounded to 0-100", () => {
    const result = computeScore("x", [flat(0.25), flat(0.75)], { scoreType: "t", version: 3 });
    expect(result.value).toBe(50);
    expect(result.normalized).toBe(0.5);
    expect(result.minValue).toBe(0);
    expect(result.maxValue).toBe(100);
    expect(result.totalWeight).toBe(2);
    expect(result.scoreType).toBe("t");
    expect(result.version).toBe(3);
  });

  it("ignores missing signals in both numerator and denominator", () => {
    const result = computeScore("x", [flat(0.5), flat(0.9, false)], { scoreType: "t" });
    expect(result.value).toBe(50);
    expect(result.totalWeight).toBe(1);
    const present = result.signals.filter((s) => s.present);
    expect(present).toHaveLength(1);
  });

  it("returns 0 when no signal is present", () => {
    const result = computeScore("x", [flat(0.9, false), flat(0.9, false)], { scoreType: "t" });
    expect(result.value).toBe(0);
    expect(result.normalized).toBe(0);
    expect(result.totalWeight).toBe(0);
  });

  it("respects a custom min/max range and rounding", () => {
    const result = computeScore("x", [flat(0.5)], { scoreType: "t", minValue: 0, maxValue: 10, rounding: 1 });
    expect(result.value).toBe(5);
    expect(result.normalized).toBe(0.5);
    const rounded = computeScore("x", [flat(1 / 3)], { scoreType: "t", rounding: 2 });
    expect(rounded.value).toBe(33.33);
  });

  it("clamps out-of-range signal values into [0, 1]", () => {
    const result = computeScore("x", [flat(2), flat(-1)], { scoreType: "t" });
    expect(result.normalized).toBe(0.5);
  });

  it("exposes a serializable inputs breakdown with contributions", () => {
    const result = computeScore("x", [flat(0.5), flat(0.5, false)], { scoreType: "t", version: 7 });
    expect(result.inputs).toMatchObject({ score_type: "t", version: 7, normalized: 0.5 });
    expect(result.inputs.signals).toHaveLength(2);
    expect((result.inputs.signals as Array<{ present: boolean }>)[1].present).toBe(false);
  });
});

describe("scoreProductQuality", () => {
  it("scores a rich, fully-populated product near the top of the range", () => {
    const result = scoreProductQuality(
      product({
        description: "A detailed product description that is long enough to be useful.",
        category: category(),
        rating: rating(),
        shipping: shipping(),
        attributes: { brand: "Acme" },
        available: true,
        price: { amount: 19.99, currency: "USD", originalAmount: 39.99 },
      }),
    );
    expect(result.scoreType).toBe("product_quality");
    expect(result.version).toBe(1);
    expect(result.value).toBeGreaterThan(70);
    expect(result.normalized).toBeGreaterThan(0.7);
    expect(result.normalized).toBeLessThanOrEqual(1);
    expect(result.signals).toHaveLength(PRODUCT_QUALITY_SIGNALS.length);
  });

  it("scores a bare-minimum product deterministically and stays bounded", () => {
    const bare = product();
    const first = scoreProductQuality(bare);
    const second = scoreProductQuality(bare);
    expect(first).toEqual(second);
    expect(first.value).toBeGreaterThanOrEqual(0);
    expect(first.value).toBeLessThanOrEqual(100);
    const completeness = signalOf(first, "completeness");
    expect(completeness.present).toBe(true);
  });

  it("handles missing optional data without crashing (no rating, shipping, attributes)", () => {
    const result = scoreProductQuality(product({}));
    expect(result.value).toBeGreaterThanOrEqual(0);
    const ratingSignal = signalOf(result, "rating_average");
    expect(ratingSignal.present).toBe(false);
    const shippingSignal = signalOf(result, "shipping");
    expect(shippingSignal.present).toBe(false);
  });

  it("derives rating_average from the average and caps at 1", () => {
    const perfect = signalOf(scoreProductQuality(product({ rating: rating({ average: 5 }) })), "rating_average");
    expect(perfect.value).toBe(1);
    const low = signalOf(scoreProductQuality(product({ rating: rating({ average: 1 }) })), "rating_average");
    expect(low.value).toBeCloseTo(0.2, 4);
  });

  it("scales rating volume logarithmically and caps at 1", () => {
    const huge = signalOf(scoreProductQuality(product({ rating: rating({ count: 100_000 }) })), "rating_count");
    expect(huge.value).toBe(1);
    const none = signalOf(scoreProductQuality(product({ rating: rating({ count: 0 }) })), "rating_count");
    expect(none.present).toBe(false);
  });

  it("rewards free shipping over slower paid shipping", () => {
    const free = signalOf(scoreProductQuality(product({ shipping: shipping({ free: true }) })), "shipping");
    expect(free.value).toBe(1);
    const slow = signalOf(
      scoreProductQuality(product({ shipping: shipping({ free: false, deliveryMaxDays: 25 }) })),
      "shipping",
    );
    expect(slow.value).toBeLessThan(0.2);
    const unknown = signalOf(scoreProductQuality(product({ shipping: { free: false } })), "shipping");
    expect(unknown.value).toBe(0.5);
  });

  it("rewards a discount proportional to depth below the original price", () => {
    const fifty = signalOf(
      scoreProductQuality(product({ price: { amount: 10, currency: "USD", originalAmount: 20 } })),
      "price",
    );
    expect(fifty.value).toBe(0.5);
    const deeper = signalOf(
      scoreProductQuality(product({ price: { amount: 5, currency: "USD", originalAmount: 20 } })),
      "price",
    );
    expect(deeper.value).toBe(0.75);
    const none = signalOf(scoreProductQuality(product({ price: { amount: 10, currency: "USD" } })), "price");
    expect(none.present).toBe(false);
  });

  it("sets availability to 0 when out of stock and omits when unknown", () => {
    const out = signalOf(scoreProductQuality(product({ available: false })), "availability");
    expect(out.value).toBe(0);
    const unknown = signalOf(scoreProductQuality(product({ available: undefined })), "availability");
    expect(unknown.present).toBe(false);
  });

  it("scores completeness as a fraction of populated optional fields", () => {
    const full = signalOf(
      scoreProductQuality(
        product({
          description: "d",
          category: category(),
          rating: rating(),
          attributes: { brand: "Acme", size: "L" },
          images: [product().images[0], product().images[0]],
        }),
      ),
      "completeness",
    );
    expect(full.value).toBe(1);
    const empty = signalOf(scoreProductQuality(product({ images: [] })), "completeness");
    expect(empty.value).toBe(0);
  });

  it("handles a product with no images and no description", () => {
    const result = scoreProductQuality(product({ images: [] }));
    expect(signalOf(result, "images").present).toBe(false);
    expect(signalOf(result, "description").present).toBe(false);
    expect(result.value).toBeGreaterThanOrEqual(0);
  });

  it("reports brand presence only when attributes.brand is non-empty", () => {
    const withBrand = signalOf(scoreProductQuality(product({ attributes: { brand: "Acme" } })), "brand");
    expect(withBrand.value).toBe(1);
    const noBrand = signalOf(scoreProductQuality(product({ attributes: {} })), "brand");
    expect(noBrand.present).toBe(false);
  });

  it("reports category specificity from path depth", () => {
    const deep = signalOf(scoreProductQuality(product({ category: category({ path: ["a", "b", "c", "d"] }) })), "category");
    expect(deep.value).toBe(1);
    const shallow = signalOf(scoreProductQuality(product({ category: category({ path: [] }) })), "category");
    expect(shallow.value).toBe(0.5);
  });

  it("allows overriding engine options via scoreProductQuality", () => {
    const result = scoreProductQuality(product(), { scoreType: "custom", version: 9, rounding: 2 });
    expect(result.scoreType).toBe("custom");
    expect(result.version).toBe(9);
  });
});

describe("toScoreRow", () => {
  it("maps a score to the scores table row shape", () => {
    const score = scoreProductQuality(product({ description: "some description text", rating: rating() }));
    const row = toScoreRow(score, { productId: "prod-1", productSourceId: "obs-1" });
    expect(row).toMatchObject({
      product_id: "prod-1",
      product_source_id: "obs-1",
      score_type: "product_quality",
      value: score.value,
      min_value: 0,
      max_value: 100,
      version: 1,
    });
    expect(row.inputs).toMatchObject({ score_type: "product_quality", normalized: score.normalized });
  });

  it("defaults missing foreign keys to null", () => {
    const row = toScoreRow(scoreProductQuality(product()));
    expect(row.product_id).toBeNull();
    expect(row.product_source_id).toBeNull();
  });
});
