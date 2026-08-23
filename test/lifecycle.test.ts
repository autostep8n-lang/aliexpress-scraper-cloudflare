import { describe, expect, it } from "vitest";
import { summarizeMetric } from "../src/trends";
import type { TrendPoint, TrendSummary } from "../src/trends";
import {
  DEFAULT_THRESHOLDS,
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  buildEvidence,
  canTransition,
  deriveLifecycleStatus,
  evaluateLifecycle,
  fromRecord,
} from "../src/lifecycle";
import type {
  AvailabilityStatus,
  LifecycleStatus,
  ProductLifecycleInput,
} from "../src/lifecycle";

const NOW = "2026-03-01T00:00:00.000Z";
const MS_PER_DAY = 86_400_000;

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * MS_PER_DAY).toISOString();
}

function priceTrend(points: TrendPoint[]): TrendSummary {
  return summarizeMetric("price", points);
}

function availabilityTrend(points: TrendPoint[]): TrendSummary {
  return summarizeMetric("availability", points);
}

function makeInput(overrides: Partial<ProductLifecycleInput> = {}): ProductLifecycleInput {
  return {
    status: "discovered",
    availability: "in_stock",
    firstSeenAt: daysAgo(2),
    lastSeenAt: daysAgo(0),
    now: NOW,
    trends: {
      price: priceTrend([
        { at: daysAgo(1), value: 10 },
        { at: daysAgo(0), value: 11 },
      ]),
    },
    ...overrides,
  };
}

describe("LIFECYCLE_STATES", () => {
  it("matches the products.lifecycle_status schema constraint", () => {
    expect([...LIFECYCLE_STATES]).toEqual(["discovered", "active", "tracking", "inactive", "archived"]);
  });
});

describe("initial / new product", () => {
  it("keeps a freshly discovered product in discovered", () => {
    const decision = evaluateLifecycle(
      makeInput({
        firstSeenAt: daysAgo(1),
        trends: { price: priceTrend([{ at: daysAgo(0), value: 10 }]) },
      }),
    );
    expect(decision.to).toBe("discovered");
    expect(decision.transitioned).toBe(false);
    expect(decision.transition).toBeNull();
    expect(decision.evidence.hasTrendHistory).toBe(false);
  });

  it("promotes a new product to active once it has sufficient history", () => {
    const decision = evaluateLifecycle(
      makeInput({
        firstSeenAt: daysAgo(10),
        trends: {
          price: priceTrend([
            { at: daysAgo(9), value: 10 },
            { at: daysAgo(8), value: 12 },
          ]),
        },
      }),
    );
    expect(decision.to).toBe("active");
    expect(decision.transitioned).toBe(true);
    expect(decision.transition?.id).toBe("lifecycle.active");
  });

  it("stays discovered when out of stock but still inside the new window", () => {
    const decision = evaluateLifecycle(
      makeInput({
        availability: "out_of_stock",
        firstSeenAt: daysAgo(1),
        trends: { price: priceTrend([{ at: daysAgo(0), value: 10 }]) },
      }),
    );
    expect(decision.to).toBe("discovered");
  });
});

describe("active product", () => {
  it("keeps a healthy, recently seen, in-stock product active", () => {
    const decision = evaluateLifecycle(
      makeInput({
        status: "active",
        trends: {
          price: priceTrend([
            { at: daysAgo(5), value: 10 },
            { at: daysAgo(0), value: 12 },
          ]),
        },
      }),
    );
    expect(decision.to).toBe("active");
    expect(decision.transitioned).toBe(false);
    expect(decision.evidence.inStock).toBe(true);
    expect(decision.evidence.seenRecently).toBe(true);
  });

  it("treats unknown availability with recent observations as active", () => {
    const decision = evaluateLifecycle(makeInput({ availability: "unknown" }));
    expect(decision.to).toBe("active");
  });

  it("keeps an active product with a flat price active", () => {
    const decision = evaluateLifecycle(
      makeInput({
        status: "active",
        trends: {
          price: priceTrend([
            { at: daysAgo(5), value: 10 },
            { at: daysAgo(0), value: 10 },
          ]),
        },
      }),
    );
    expect(decision.to).toBe("active");
    expect(decision.evidence.priceDirection).toBe("flat");
  });
});

describe("rising / declining trend", () => {
  it("classifies a rising product as active", () => {
    const decision = evaluateLifecycle(
      makeInput({
        status: "tracking",
        trends: {
          price: priceTrend([
            { at: daysAgo(5), value: 20 },
            { at: daysAgo(0), value: 30 },
          ]),
        },
      }),
    );
    expect(decision.to).toBe("active");
    expect(decision.transition?.id).toBe("lifecycle.active");
  });

  it("classifies a >10% price decline as declining/tracking", () => {
    const decision = evaluateLifecycle(
      makeInput({
        status: "active",
        trends: {
          price: priceTrend([
            { at: daysAgo(5), value: 100 },
            { at: daysAgo(0), value: 80 },
          ]),
        },
      }),
    );
    expect(decision.to).toBe("tracking");
    expect(decision.transition?.id).toBe("lifecycle.declining_price");
    expect(decision.evidence.priceChangePct).toBeCloseTo(-0.2, 5);
  });

  it("does not downgrade a small price decline below the threshold", () => {
    const decision = evaluateLifecycle(
      makeInput({
        status: "active",
        trends: {
          price: priceTrend([
            { at: daysAgo(5), value: 100 },
            { at: daysAgo(0), value: 97 },
          ]),
        },
      }),
    );
    expect(decision.to).toBe("active");
  });

  it("classifies a product that went from available to unavailable as tracking", () => {
    const decision = evaluateLifecycle(
      makeInput({
        availability: "out_of_stock",
        trends: {
          price: priceTrend([
            { at: daysAgo(2), value: 10 },
            { at: daysAgo(0), value: 10 },
          ]),
          availability: availabilityTrend([
            { at: daysAgo(2), value: 1 },
            { at: daysAgo(0), value: 0 },
          ]),
        },
      }),
    );
    expect(decision.to).toBe("tracking");
    expect(decision.transition?.id).toBe("lifecycle.declining_availability");
  });
});

describe("stale / inactive / expired product", () => {
  it("marks a product not seen within staleDays as inactive", () => {
    const decision = evaluateLifecycle(makeInput({ lastSeenAt: daysAgo(31) }));
    expect(decision.to).toBe("inactive");
    expect(decision.transition?.id).toBe("lifecycle.stale");
  });

  it("archives a product not seen within expiredDays", () => {
    const decision = evaluateLifecycle(makeInput({ lastSeenAt: daysAgo(91) }));
    expect(decision.to).toBe("archived");
    expect(decision.transition?.id).toBe("lifecycle.expired");
  });

  it("marks a discontinued product inactive regardless of recency", () => {
    const decision = evaluateLifecycle(
      makeInput({ availability: "discontinued", lastSeenAt: daysAgo(1) }),
    );
    expect(decision.to).toBe("inactive");
    expect(decision.transition?.id).toBe("lifecycle.discontinued");
  });
});

describe("boundary conditions", () => {
  it("treats exactly staleDays as still recent", () => {
    const decision = evaluateLifecycle(makeInput({ lastSeenAt: daysAgo(DEFAULT_THRESHOLDS.staleDays) }));
    expect(decision.to).toBe("active");
    expect(decision.evidence.seenRecently).toBe(true);
  });

  it("treats exactly expiredDays as inactive, not yet archived", () => {
    const decision = evaluateLifecycle(makeInput({ lastSeenAt: daysAgo(DEFAULT_THRESHOLDS.expiredDays) }));
    expect(decision.to).toBe("inactive");
    expect(decision.transition?.id).toBe("lifecycle.stale");
  });

  it("treats exactly newWindowDays with insufficient history as still new", () => {
    const decision = evaluateLifecycle(
      makeInput({
        firstSeenAt: daysAgo(DEFAULT_THRESHOLDS.newWindowDays),
        status: "discovered",
        trends: { price: priceTrend([{ at: daysAgo(0), value: 10 }]) },
      }),
    );
    expect(decision.to).toBe("discovered");
  });

  it("promotes a product just past the new window with history to active", () => {
    const decision = evaluateLifecycle(
      makeInput({
        firstSeenAt: daysAgo(DEFAULT_THRESHOLDS.newWindowDays + 1),
        trends: {
          price: priceTrend([
            { at: daysAgo(DEFAULT_THRESHOLDS.newWindowDays + 2), value: 10 },
            { at: daysAgo(0), value: 10 },
          ]),
        },
      }),
    );
    expect(decision.to).toBe("active");
  });
});

describe("missing / insufficient history", () => {
  it("treats a product with no trend history inside the new window as discovered", () => {
    const decision = evaluateLifecycle(makeInput({ trends: {} }));
    expect(decision.to).toBe("discovered");
    expect(decision.evidence.hasTrendHistory).toBe(false);
  });

  it("classifies an in-stock product with no history past the new window as active", () => {
    const decision = evaluateLifecycle(makeInput({ firstSeenAt: daysAgo(20), trends: {} }));
    expect(decision.to).toBe("active");
  });

  it("keeps an out-of-stock product with no history under observation", () => {
    const decision = evaluateLifecycle(
      makeInput({ firstSeenAt: daysAgo(20), availability: "out_of_stock", trends: {} }),
    );
    expect(decision.to).toBe("tracking");
  });
});

describe("invalid / edge data", () => {
  it("never classifies based on unparseable timestamps", () => {
    const decision = evaluateLifecycle(
      makeInput({ firstSeenAt: "garbage", lastSeenAt: "garbage", availability: "in_stock" }),
    );
    expect(decision.evidence.daysSinceFirstSeen).toBeNull();
    expect(decision.evidence.daysSinceLastSeen).toBeNull();
    expect(decision.evidence.seenRecently).toBe(false);
    expect(decision.to).toBe("tracking");
  });

  it("guards against a zero first price when computing decline", () => {
    const decision = evaluateLifecycle(
      makeInput({
        status: "active",
        trends: {
          price: priceTrend([
            { at: daysAgo(5), value: 0 },
            { at: daysAgo(0), value: 5 },
          ]),
        },
      }),
    );
    expect(decision.evidence.priceChangePct).toBeNull();
    expect(decision.to).toBe("active");
  });

  it("ignores non-price metric trends when no price history exists", () => {
    const decision = evaluateLifecycle(
      makeInput({
        firstSeenAt: daysAgo(1),
        status: "discovered",
        trends: {
          rating: summarizeMetric("rating", [
            { at: daysAgo(1), value: 4.5 },
            { at: daysAgo(0), value: 3.0 },
          ]),
        },
      }),
    );
    expect(decision.to).toBe("discovered");
    expect(decision.evidence.priceCount).toBe(0);
  });
});

describe("lifecycle transitions", () => {
  it("keeps an archived product terminal", () => {
    const decision = evaluateLifecycle(
      makeInput({ status: "archived", lastSeenAt: daysAgo(95), availability: "out_of_stock" }),
    );
    expect(decision.to).toBe("archived");
    expect(decision.transitioned).toBe(false);
  });

  it("revives an archived product observed in stock again", () => {
    const decision = evaluateLifecycle(
      makeInput({ status: "archived", lastSeenAt: daysAgo(2) }),
    );
    expect(decision.to).toBe("active");
    expect(decision.transition?.id).toBe("lifecycle.revive");
  });

  it("keeps an archived product terminal when observed but unavailable", () => {
    const decision = evaluateLifecycle(
      makeInput({ status: "archived", lastSeenAt: daysAgo(2), availability: "out_of_stock" }),
    );
    expect(decision.to).toBe("archived");
    expect(decision.transitioned).toBe(false);
  });

  it("reactivates an inactive product that is observed in stock", () => {
    const decision = evaluateLifecycle(makeInput({ status: "inactive", lastSeenAt: daysAgo(1) }));
    expect(decision.to).toBe("active");
    expect(decision.transition?.id).toBe("lifecycle.active");
  });

  it("moves an inactive product back under observation when still unavailable", () => {
    const decision = evaluateLifecycle(
      makeInput({ status: "inactive", lastSeenAt: daysAgo(1), availability: "out_of_stock" }),
    );
    expect(decision.to).toBe("tracking");
  });

  it("every produced transition is documented in LIFECYCLE_TRANSITIONS", () => {
    const statuses: LifecycleStatus[] = [...LIFECYCLE_STATES];
    const availabilities: AvailabilityStatus[] = [
      "in_stock",
      "out_of_stock",
      "preorder",
      "discontinued",
      "unknown",
    ];
    for (const status of statuses) {
      for (const availability of availabilities) {
        for (const daysSeen of [0, 1, 31, 91]) {
          const decision = evaluateLifecycle(
            makeInput({ status, availability, lastSeenAt: daysAgo(daysSeen) }),
          );
          expect(canTransition(status, decision.to)).toBe(true);
        }
      }
    }
  });
});

describe("canTransition", () => {
  it("accepts documented transitions and self-transitions", () => {
    expect(canTransition("active", "tracking")).toBe(true);
    expect(canTransition("discovered", "active")).toBe(true);
    expect(canTransition("inactive", "archived")).toBe(true);
    expect(canTransition("archived", "active")).toBe(true);
    expect(canTransition("discovered", "archived")).toBe(true);
    expect(canTransition("tracking", "tracking")).toBe(true);
  });

  it("rejects undocumented transitions", () => {
    expect(canTransition("archived", "tracking")).toBe(false);
    expect(canTransition("archived", "inactive")).toBe(false);
    expect(canTransition("active", "discovered")).toBe(false);
    expect(canTransition("tracking", "discovered")).toBe(false);
  });

  it("is exhaustive over the documented transition table", () => {
    for (const spec of LIFECYCLE_TRANSITIONS) {
      expect(canTransition(spec.from, spec.to)).toBe(true);
    }
  });
});

describe("determinism", () => {
  it("produces identical decisions for identical inputs", () => {
    const input = makeInput({
      status: "active",
      availability: "out_of_stock",
      trends: {
        price: priceTrend([
          { at: daysAgo(5), value: 100 },
          { at: daysAgo(0), value: 70 },
        ]),
        availability: availabilityTrend([
          { at: daysAgo(5), value: 1 },
          { at: daysAgo(0), value: 0 },
        ]),
      },
    });
    expect(evaluateLifecycle(input)).toEqual(evaluateLifecycle(input));
    expect(deriveLifecycleStatus(input)).toBe(deriveLifecycleStatus(input));
  });
});

describe("fromRecord adapter", () => {
  it("maps a persisted record plus trends into a decision", () => {
    const decision = fromRecord(
      {
        lifecycleStatus: "active",
        availabilityStatus: "out_of_stock",
        lastSeenAt: daysAgo(1),
      },
      {
        price: priceTrend([
          { at: daysAgo(5), value: 100 },
          { at: daysAgo(0), value: 70 },
        ]),
      },
      NOW,
    );
    expect(decision.to).toBe("tracking");
    expect(decision.transition?.id).toBe("lifecycle.declining_price");
  });

  it("defaults a missing lifecycle status to discovered", () => {
    const decision = fromRecord(
      { availabilityStatus: "in_stock", lastSeenAt: daysAgo(0) },
      { price: priceTrend([{ at: daysAgo(0), value: 10 }]) },
      NOW,
    );
    expect(decision.from).toBe("discovered");
    expect(decision.to).toBe("discovered");
  });

  it("falls back to lastSeenAt when firstSeenAt is absent", () => {
    const decision = fromRecord(
      { availabilityStatus: "in_stock", lastSeenAt: daysAgo(0) },
      {},
      NOW,
    );
    expect(decision.evidence.daysSinceFirstSeen).toBe(decision.evidence.daysSinceLastSeen);
  });
});

describe("buildEvidence", () => {
  it("exposes the derived evidence used by rules", () => {
    const evidence = buildEvidence(makeInput({ lastSeenAt: daysAgo(3) }));
    expect(evidence.daysSinceLastSeen).toBeCloseTo(3, 5);
    expect(evidence.seenRecently).toBe(true);
    expect(evidence.inStock).toBe(true);
    expect(evidence.discontinued).toBe(false);
    expect(evidence.priceCount).toBe(2);
    expect(evidence.priceDirection).toBe("up");
    expect(evidence.priceChange).toBe(1);
    expect(evidence.priceChangePct).toBeCloseTo(0.1, 5);
    expect(evidence.hasTrendHistory).toBe(true);
  });
});
