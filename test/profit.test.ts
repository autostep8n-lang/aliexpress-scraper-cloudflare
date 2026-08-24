import { describe, expect, it } from "vitest";
import {
  MONEY_PRECISION,
  PERCENT_PRECISION,
  computeProfit,
  profitInputFromProduct,
  roundMoney,
  roundPercent,
  toProfitRows,
} from "../src/profit";
import type { ProfitInput } from "../src/profit";
import type { Product } from "../src/products/types";

function input(overrides: Partial<ProfitInput> = {}): ProfitInput {
  return {
    currency: "USD",
    sellingPrice: 50,
    supplierCost: 20,
    shippingCost: 5,
    platformFees: { rate: 0.02 },
    advertisingCost: 3,
    refundAllowance: { amount: 2 },
    ...overrides,
  };
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    platform: "aliexpress",
    externalId: "1005001",
    url: "https://www.aliexpress.com/item/1005001.html",
    title: "Wireless Earbuds",
    price: { amount: 49.99, currency: "USD" },
    images: [{ url: "https://img.example.com/a.jpg" }],
    scrapedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("rounding helpers", () => {
  it("rounds money to 4 decimals and percentages to 2 decimals", () => {
    expect(MONEY_PRECISION).toBe(4);
    expect(PERCENT_PRECISION).toBe(2);
    expect(roundMoney(0.30000000000000004)).toBe(0.3);
    expect(roundMoney(19.99999)).toBe(20);
    expect(roundPercent(61.29032258064516)).toBe(61.29);
    expect(roundPercent(37.93103448275862)).toBe(37.93);
  });
});

describe("normal profitable product", () => {
  it("aggregates all components into total cost and positive net profit", () => {
    const result = computeProfit(input());
    expect(result.complete).toBe(true);
    expect(result.sellingPrice).toBe(50);
    expect(result.supplierCost).toBe(20);
    expect(result.shippingCost).toBe(5);
    expect(result.platformFees).toBe(1);
    expect(result.advertisingCost).toBe(3);
    expect(result.refundAllowance).toBe(2);
    expect(result.totalCost).toBe(31);
    expect(result.netProfit).toBe(19);
    expect(result.breakEven).toBe(false);
  });

  it("exposes a full component breakdown in fixed order", () => {
    const result = computeProfit(input());
    expect(result.components.map((component) => component.key)).toEqual([
      "selling_price",
      "supplier_cost",
      "shipping_cost",
      "platform_fees",
      "advertising_cost",
      "refund_allowance",
    ]);
    expect(result.components.every((component) => component.present)).toBe(true);
    expect(result.components[0]).toMatchObject({ key: "selling_price", amount: 50 });
    expect(result.components[3]).toMatchObject({ key: "platform_fees", amount: 1, rate: 0.02 });
    expect(result.components[5]).toMatchObject({ key: "refund_allowance", amount: 2, fixedAmount: 2 });
  });
});

describe("break-even product", () => {
  it("reports zero net profit and breakEven true", () => {
    const result = computeProfit(
      input({
        sellingPrice: 30,
        supplierCost: 20,
        shippingCost: 5,
        platformFees: { amount: 2 },
        advertisingCost: 2,
        refundAllowance: { amount: 1 },
      }),
    );
    expect(result.totalCost).toBe(30);
    expect(result.netProfit).toBe(0);
    expect(result.breakEven).toBe(true);
    expect(result.profitMarginPct).toBe(0);
    expect(result.roi).toBe(0);
  });
});

describe("loss-making product", () => {
  it("reports a negative net profit with negative margin and ROI", () => {
    const result = computeProfit(
      input({
        sellingPrice: 40,
        supplierCost: 30,
        shippingCost: 10,
        platformFees: { rate: 0.05 },
        advertisingCost: 5,
        refundAllowance: { amount: 3 },
      }),
    );
    expect(result.totalCost).toBe(50);
    expect(result.netProfit).toBe(-10);
    expect(result.profitMarginPct).toBe(-25);
    expect(result.roi).toBe(-20);
    expect(result.breakEven).toBe(false);
  });
});

describe("missing supplier cost", () => {
  it("never invents a cost and reports incomplete profit", () => {
    const result = computeProfit(input({ supplierCost: undefined }));
    expect(result.supplierCost).toBeNull();
    expect(result.totalCost).toBeNull();
    expect(result.netProfit).toBeNull();
    expect(result.profitMarginPct).toBeNull();
    expect(result.roi).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.components.find((component) => component.key === "supplier_cost")?.present).toBe(false);
  });
});

describe("missing selling price", () => {
  it("computes total cost but leaves profit-derived values null", () => {
    const result = computeProfit(input({ sellingPrice: undefined }));
    expect(result.sellingPrice).toBeNull();
    expect(result.totalCost).toBe(30);
    expect(result.netProfit).toBeNull();
    expect(result.profitMarginPct).toBeNull();
    expect(result.roi).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.components.find((component) => component.key === "selling_price")?.present).toBe(false);
  });
});

describe("zero selling price", () => {
  it("avoids division by zero on margin and reports the loss on ROI", () => {
    const result = computeProfit(input({ sellingPrice: 0 }));
    expect(result.sellingPrice).toBe(0);
    expect(result.totalCost).toBe(30);
    expect(result.netProfit).toBe(-30);
    expect(result.profitMarginPct).toBeNull();
    expect(result.roi).toBe(-100);
    expect(result.complete).toBe(true);
  });
});

describe("zero / undefined optional costs", () => {
  it("treats absent optional costs as zero and flags them absent", () => {
    const result = computeProfit(input({ shippingCost: undefined, platformFees: undefined, advertisingCost: undefined, refundAllowance: undefined }));
    expect(result.totalCost).toBe(20);
    expect(result.netProfit).toBe(30);
    expect(result.profitMarginPct).toBe(60);
    expect(result.roi).toBe(150);
    for (const key of ["shipping_cost", "platform_fees", "advertising_cost", "refund_allowance"] as const) {
      const component = result.components.find((c) => c.key === key);
      expect(component?.present).toBe(false);
      expect(component?.amount).toBe(0);
    }
  });

  it("treats an explicit zero cost as present", () => {
    const result = computeProfit(input({ shippingCost: 0 }));
    expect(result.shippingCost).toBe(0);
    expect(result.components.find((component) => component.key === "shipping_cost")).toMatchObject({
      present: true,
      amount: 0,
    });
  });
});

describe("shipping cost included", () => {
  it("adds shipping cost into total cost", () => {
    const result = computeProfit(input({ sellingPrice: 10, supplierCost: 5, shippingCost: 2, platformFees: undefined, advertisingCost: undefined, refundAllowance: undefined }));
    expect(result.totalCost).toBe(7);
    expect(result.netProfit).toBe(3);
    expect(result.components.find((component) => component.key === "shipping_cost")).toMatchObject({ present: true, amount: 2 });
  });
});

describe("payment/platform fees included", () => {
  it("combines fixed and rate-based fees", () => {
    const result = computeProfit(
      input({ sellingPrice: 100, supplierCost: 50, platformFees: { amount: 1, rate: 0.02 }, shippingCost: undefined, advertisingCost: undefined, refundAllowance: undefined }),
    );
    expect(result.platformFees).toBe(3);
    expect(result.totalCost).toBe(53);
    expect(result.netProfit).toBe(47);
  });

  it("treats an invalid rate as absent rather than computing garbage", () => {
    const result = computeProfit(input({ platformFees: { rate: 2 } }));
    expect(result.platformFees).toBe(0);
    expect(result.components.find((component) => component.key === "platform_fees")).toMatchObject({ present: false, amount: 0 });
  });
});

describe("advertising cost included", () => {
  it("adds advertising cost into total cost", () => {
    const result = computeProfit(input({ sellingPrice: 10, supplierCost: 4, advertisingCost: 2, shippingCost: undefined, platformFees: undefined, refundAllowance: undefined }));
    expect(result.totalCost).toBe(6);
    expect(result.netProfit).toBe(4);
    expect(result.components.find((component) => component.key === "advertising_cost")).toMatchObject({ present: true, amount: 2 });
  });
});

describe("refund/return allowance included", () => {
  it("adds a rate-based refund allowance", () => {
    const result = computeProfit(
      input({ sellingPrice: 100, supplierCost: 60, refundAllowance: { rate: 0.05 }, shippingCost: undefined, platformFees: undefined, advertisingCost: undefined }),
    );
    expect(result.refundAllowance).toBe(5);
    expect(result.totalCost).toBe(65);
    expect(result.netProfit).toBe(35);
  });
});

describe("correct profit margin", () => {
  it("computes margin as net profit over selling price", () => {
    const result = computeProfit(
      input({
        sellingPrice: 200,
        supplierCost: 100,
        shippingCost: 20,
        platformFees: { rate: 0.05 },
        advertisingCost: 10,
        refundAllowance: { amount: 5 },
      }),
    );
    expect(result.totalCost).toBe(145);
    expect(result.netProfit).toBe(55);
    expect(result.profitMarginPct).toBe(27.5);
  });

  it("returns a negative margin for losses", () => {
    expect(
      computeProfit(
        input({ sellingPrice: 40, supplierCost: 50, shippingCost: undefined, platformFees: undefined, advertisingCost: undefined, refundAllowance: undefined }),
      ).profitMarginPct,
    ).toBe(-25);
  });
});

describe("correct ROI", () => {
  it("computes ROI as net profit over total cost", () => {
    const result = computeProfit(
      input({
        sellingPrice: 200,
        supplierCost: 100,
        shippingCost: 20,
        platformFees: { rate: 0.05 },
        advertisingCost: 10,
        refundAllowance: { amount: 5 },
      }),
    );
    expect(result.netProfit).toBe(55);
    expect(result.roi).toBe(37.93);
  });

  it("returns null ROI when total cost is zero", () => {
    expect(
      computeProfit(
        input({ sellingPrice: 0, supplierCost: 0, shippingCost: undefined, platformFees: undefined, advertisingCost: undefined, refundAllowance: undefined }),
      ).roi,
    ).toBeNull();
  });
});

describe("deterministic repeated calculations", () => {
  it("returns identical results for identical inputs", () => {
    const a = computeProfit(input());
    const b = computeProfit(input());
    expect(a).toEqual(b);
    expect(a.inputs).toEqual(b.inputs);
  });
});

describe("floating-point / monetary precision edge cases", () => {
  it("rounds float drift to exact money values", () => {
    const result = computeProfit(
      input({ sellingPrice: 0.3, supplierCost: 0.1, shippingCost: 0.2, platformFees: undefined, advertisingCost: undefined, refundAllowance: undefined }),
    );
    expect(result.totalCost).toBe(0.3);
    expect(result.netProfit).toBe(0);
    expect(result.breakEven).toBe(true);
  });

  it("preserves 4-decimal monetary precision", () => {
    const result = computeProfit(
      input({ sellingPrice: 19.99, supplierCost: 12.3456, shippingCost: 1.2345, platformFees: undefined, advertisingCost: undefined, refundAllowance: undefined }),
    );
    expect(result.totalCost).toBe(13.5801);
    expect(result.netProfit).toBe(6.4099);
  });

  it("treats non-finite and negative monetary inputs as missing", () => {
    const result = computeProfit(input({ sellingPrice: Number.NaN, supplierCost: -5 }));
    expect(result.sellingPrice).toBeNull();
    expect(result.supplierCost).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.totalCost).toBeNull();
  });

  it("exposes a serializable inputs breakdown", () => {
    const result = computeProfit(input());
    expect(result.inputs).toMatchObject({
      currency: "USD",
      selling_price: 50,
      supplier_cost: 20,
      shipping_cost: 5,
      platform_fee_rate: 0.02,
      advertising_cost: 3,
      refund_allowance_amount: 2,
    });
  });
});

describe("profitInputFromProduct", () => {
  it("derives selling price and currency from the unified Product model", () => {
    const built = profitInputFromProduct(product({ price: { amount: 49.99, currency: "USD" } }), {
      supplierCost: 25,
      shippingCost: 5,
    });
    expect(built).toEqual({ currency: "USD", sellingPrice: 49.99, supplierCost: 25, shippingCost: 5 });
    const result = computeProfit(built);
    expect(result.totalCost).toBe(30);
    expect(result.netProfit).toBe(19.99);
  });

  it("defaults to no cost inputs when only the product is given", () => {
    const built = profitInputFromProduct(product({ price: { amount: 10, currency: "USD" } }));
    expect(built).toEqual({ currency: "USD", sellingPrice: 10 });
    expect(computeProfit(built).complete).toBe(false);
  });
});

describe("toProfitRows", () => {
  it("maps a complete result to metrics table rows", () => {
    const result = computeProfit(input());
    const rows = toProfitRows(result, { productId: "prod-1", productSourceId: "obs-1" });
    expect(rows.map((row) => row.metric_type)).toEqual(["total_cost", "net_profit", "profit_margin_pct", "roi"]);
    expect(rows[0]).toMatchObject({ product_id: "prod-1", product_source_id: "obs-1", metric_type: "total_cost", value: 31, unit: "USD" });
    expect(rows[1]).toMatchObject({ metric_type: "net_profit", value: 19, unit: "USD" });
    expect(rows[2]).toMatchObject({ metric_type: "profit_margin_pct", value: 38, unit: "%" });
    expect(rows[3]).toMatchObject({ metric_type: "roi", value: 61.29, unit: "%" });
    expect(rows[0].metadata).toMatchObject({ currency: "USD" });
  });

  it("emits no rows when profit-derived values cannot be computed", () => {
    const incomplete = computeProfit(input({ supplierCost: undefined }));
    expect(toProfitRows(incomplete, { productId: "prod-1" })).toEqual([]);
  });
});
