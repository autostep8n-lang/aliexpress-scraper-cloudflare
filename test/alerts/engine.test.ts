import { describe, expect, it } from "vitest";
import {
  COUNTRY_OPPORTUNITY_SCORE_TYPE,
  evaluateAlerts,
  evaluateCountryOpportunity,
  evaluateLifecycle,
  evaluateMarketOpportunity,
  MARKET_OPPORTUNITY_SCORE_TYPE,
  severityForAlertType,
} from "../../src/alerts/engine";
import type { AlertEngineInput } from "../../src/alerts/types";

const PRODUCT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function marketInput(overrides: Partial<AlertEngineInput> = {}): AlertEngineInput {
  return {
    marketOpportunities: [
      { productId: PRODUCT, scoreType: MARKET_OPPORTUNITY_SCORE_TYPE, value: 80, totalWeight: 0.4 },
    ],
    ...overrides,
  };
}

describe("severityForAlertType", () => {
  it("maps each alert family to its approved severity", () => {
    expect(severityForAlertType("high_market_opportunity")).toBe("critical");
    expect(severityForAlertType("high_country_opportunity")).toBe("warning");
    expect(severityForAlertType("lifecycle_review")).toBe("info");
  });
});

describe("evaluateMarketOpportunity", () => {
  it("alerts at or above the high threshold with real weight", () => {
    const alert = evaluateMarketOpportunity({
      productId: PRODUCT,
      scoreType: MARKET_OPPORTUNITY_SCORE_TYPE,
      value: 65,
      totalWeight: 0.25,
    });

    expect(alert).toMatchObject({
      productId: PRODUCT,
      alertType: "high_market_opportunity",
      severity: "critical",
      dedupKey: "market_opportunity:high",
      value: 65,
      tier: "high",
    });
    expect(alert?.inputs).toMatchObject({ total_weight: 0.25, threshold: 65 });
  });

  it("does not alert below the threshold", () => {
    const alert = evaluateMarketOpportunity({
      productId: PRODUCT,
      scoreType: MARKET_OPPORTUNITY_SCORE_TYPE,
      value: 64.99,
      totalWeight: 1,
    });
    expect(alert).toBeNull();
  });

  it("never coerces a zero or non-finite weight into a value", () => {
    const base = { productId: PRODUCT, scoreType: MARKET_OPPORTUNITY_SCORE_TYPE, value: 90 };
    expect(evaluateMarketOpportunity({ ...base, totalWeight: 0 })).toBeNull();
    expect(evaluateMarketOpportunity({ ...base, totalWeight: Number.NaN })).toBeNull();
  });

  it("skips non-finite values and other score types", () => {
    expect(
      evaluateMarketOpportunity({
        productId: PRODUCT,
        scoreType: MARKET_OPPORTUNITY_SCORE_TYPE,
        value: Number.NaN,
        totalWeight: 1,
      }),
    ).toBeNull();
    expect(
      evaluateMarketOpportunity({ productId: PRODUCT, scoreType: "competition", value: 90, totalWeight: 1 }),
    ).toBeNull();
  });

  it("skips an empty product id", () => {
    expect(
      evaluateMarketOpportunity({
        productId: "",
        scoreType: MARKET_OPPORTUNITY_SCORE_TYPE,
        value: 90,
        totalWeight: 1,
      }),
    ).toBeNull();
  });
});

describe("evaluateCountryOpportunity", () => {
  it("alerts for an eligible v1 country tiered high", () => {
    const alert = evaluateCountryOpportunity({
      productId: PRODUCT,
      country: "SA",
      scoreType: COUNTRY_OPPORTUNITY_SCORE_TYPE,
      value: 72,
      totalWeight: 0.5,
      tier: "high",
    });

    expect(alert).toMatchObject({
      alertType: "high_country_opportunity",
      dedupKey: "country_opportunity:SA:high",
      severity: "warning",
      country: "SA",
      value: 72,
      tier: "high",
    });
    expect(alert?.summary).toContain("SA");
  });

  it("requires a high tier", () => {
    const alert = evaluateCountryOpportunity({
      productId: PRODUCT,
      country: "SA",
      scoreType: COUNTRY_OPPORTUNITY_SCORE_TYPE,
      value: 99,
      totalWeight: 1,
      tier: "medium",
    });
    expect(alert).toBeNull();
  });

  it("rejects a non-v1 country", () => {
    const alert = evaluateCountryOpportunity({
      productId: PRODUCT,
      country: "UK",
      scoreType: COUNTRY_OPPORTUNITY_SCORE_TYPE,
      value: 99,
      totalWeight: 1,
      tier: "high",
    });
    expect(alert).toBeNull();
  });

  it("rejects other score types, zero weight and non-finite values", () => {
    expect(
      evaluateCountryOpportunity({
        productId: PRODUCT,
        country: "SA",
        scoreType: "generic",
        value: 99,
        totalWeight: 1,
        tier: "high",
      }),
    ).toBeNull();
    expect(
      evaluateCountryOpportunity({
        productId: PRODUCT,
        country: "SA",
        scoreType: COUNTRY_OPPORTUNITY_SCORE_TYPE,
        value: 99,
        totalWeight: 0,
        tier: "high",
      }),
    ).toBeNull();
    expect(
      evaluateCountryOpportunity({
        productId: PRODUCT,
        country: "SA",
        scoreType: COUNTRY_OPPORTUNITY_SCORE_TYPE,
        value: Number.NaN,
        totalWeight: 1,
        tier: "high",
      }),
    ).toBeNull();
  });
});

describe("evaluateLifecycle", () => {
  it("emits review alerts for inactive and archived", () => {
    expect(evaluateLifecycle({ productId: PRODUCT, lifecycleStatus: "inactive" })).toMatchObject([
      { alertType: "lifecycle_review", dedupKey: "lifecycle:inactive", severity: "info" },
    ]);
    expect(evaluateLifecycle({ productId: PRODUCT, lifecycleStatus: "archived" })).toMatchObject([
      { alertType: "lifecycle_review", dedupKey: "lifecycle:archived" },
    ]);
  });

  it("emits nothing for healthy or transient states", () => {
    for (const status of ["discovered", "active", "tracking", ""]) {
      expect(evaluateLifecycle({ productId: PRODUCT, lifecycleStatus: status })).toEqual([]);
    }
  });
});

describe("evaluateAlerts", () => {
  it("combines every evidence family", () => {
    const alerts = evaluateAlerts({
      marketOpportunities: [
        { productId: PRODUCT, scoreType: MARKET_OPPORTUNITY_SCORE_TYPE, value: 80, totalWeight: 0.5 },
      ],
      countryOpportunities: [
        {
          productId: PRODUCT,
          country: "SA",
          scoreType: COUNTRY_OPPORTUNITY_SCORE_TYPE,
          value: 70,
          totalWeight: 0.5,
          tier: "high",
        },
      ],
      lifecycles: [{ productId: PRODUCT, lifecycleStatus: "archived" }],
    });

    expect(alerts.map((alert) => alert.dedupKey)).toEqual([
      "country_opportunity:SA:high",
      "market_opportunity:high",
      "lifecycle:archived",
    ]);
  });

  it("deduplicates by product x type x dedup key deterministically", () => {
    const alerts = evaluateAlerts({
      lifecycles: [
        { productId: PRODUCT, lifecycleStatus: "inactive" },
        { productId: PRODUCT, lifecycleStatus: "inactive" },
      ],
    });
    expect(alerts).toHaveLength(1);
  });

  it("is order-independent and strongest-evidence wins", () => {
    const forward = evaluateAlerts({
      countryOpportunities: [
        {
          productId: PRODUCT,
          country: "SA",
          scoreType: COUNTRY_OPPORTUNITY_SCORE_TYPE,
          value: 70,
          totalWeight: 0.5,
          tier: "high",
        },
        {
          productId: PRODUCT,
          country: "SA",
          scoreType: COUNTRY_OPPORTUNITY_SCORE_TYPE,
          value: 95,
          totalWeight: 0.5,
          tier: "high",
        },
      ],
    });
    const reverse = evaluateAlerts({
      countryOpportunities: [
        {
          productId: PRODUCT,
          country: "SA",
          scoreType: COUNTRY_OPPORTUNITY_SCORE_TYPE,
          value: 95,
          totalWeight: 0.5,
          tier: "high",
        },
        {
          productId: PRODUCT,
          country: "SA",
          scoreType: COUNTRY_OPPORTUNITY_SCORE_TYPE,
          value: 70,
          totalWeight: 0.5,
          tier: "high",
        },
      ],
    });

    expect(forward).toEqual(reverse);
    expect(forward).toHaveLength(1);
    expect(forward[0].value).toBe(95);
  });

  it("sorts by product, then type, then dedup key", () => {
    const alerts = evaluateAlerts({
      marketOpportunities: [
        { productId: OTHER, scoreType: MARKET_OPPORTUNITY_SCORE_TYPE, value: 90, totalWeight: 1 },
        { productId: PRODUCT, scoreType: MARKET_OPPORTUNITY_SCORE_TYPE, value: 90, totalWeight: 1 },
      ],
      lifecycles: [{ productId: OTHER, lifecycleStatus: "archived" }],
    });
    expect(alerts.map((alert) => `${alert.productId}:${alert.dedupKey}`)).toEqual([
      `${PRODUCT}:market_opportunity:high`,
      `${OTHER}:market_opportunity:high`,
      `${OTHER}:lifecycle:archived`,
    ]);
  });

  it("is pure: identical input yields deeply equal output and no mutation", () => {
    const input: AlertEngineInput = marketInput();
    const snapshot = JSON.parse(JSON.stringify(input));
    const first = evaluateAlerts(input);
    const second = evaluateAlerts(input);
    expect(first).toEqual(second);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it("yields nothing for empty or invalid input", () => {
    expect(evaluateAlerts({})).toEqual([]);
    expect(evaluateAlerts({ marketOpportunities: [], countryOpportunities: [], lifecycles: [] })).toEqual([]);
  });
});
