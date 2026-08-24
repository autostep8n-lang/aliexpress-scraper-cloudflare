/**
 * Profit Engine - deterministic calculation.
 *
 * Pure and deterministic: no I/O, no external calls, no wall-clock time, and
 * identical inputs always produce identical outputs. Missing or invalid cost
 * components are excluded (never invented), division by zero is guarded, and
 * monetary values are rounded to 4 decimal places to match the project's
 * `numeric(18,4)` price columns.
 */

import type { Product } from "../products/types";
import type {
  ProfitComponent,
  ProfitComponentKey,
  ProfitFee,
  ProfitInput,
  ProfitResult,
  ProductProfitCosts,
} from "./types";

/** Decimal places for monetary values (matches `numeric(18,4)` prices). */
export const MONEY_PRECISION = 4;
/** Decimal places for percentage outputs (margin, ROI). */
export const PERCENT_PRECISION = 2;

/** Fixed breakdown order used for `components` and persistence metadata. */
export const PROFIT_COMPONENT_DEFINITIONS: readonly { key: ProfitComponentKey; label: string }[] = [
  { key: "selling_price", label: "Selling price" },
  { key: "supplier_cost", label: "Supplier cost" },
  { key: "shipping_cost", label: "Shipping cost" },
  { key: "platform_fees", label: "Payment/platform fees" },
  { key: "advertising_cost", label: "Advertising/marketing cost" },
  { key: "refund_allowance", label: "Refund/return allowance" },
];

export function roundMoney(value: number): number {
  return round(value, MONEY_PRECISION);
}

export function roundPercent(value: number): number {
  return round(value, PERCENT_PRECISION);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Money/rate values that are missing or invalid become null (never invented). */
function normalizeMoney(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function normalizeRate(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

/**
 * Computes the profit breakdown for one product. All calculations are
 * deterministic; the caller supplies `now`-free, typed inputs.
 */
export function computeProfit(input: ProfitInput): ProfitResult {
  const sellingPrice = normalizeMoney(input.sellingPrice);
  const supplierCost = normalizeMoney(input.supplierCost);
  const shippingCost = normalizeMoney(input.shippingCost) ?? 0;
  const advertisingCost = normalizeMoney(input.advertisingCost) ?? 0;
  const platformFee = resolveFee(input.platformFees, sellingPrice);
  const refundFee = resolveFee(input.refundAllowance, sellingPrice);

  const hasSellingPrice = sellingPrice !== null;
  const hasSupplierCost = supplierCost !== null;

  let totalCost: number | null = null;
  let netProfit: number | null = null;
  let profitMarginPct: number | null = null;
  let roi: number | null = null;
  let breakEven = false;

  if (hasSupplierCost) {
    totalCost = roundMoney(supplierCost + shippingCost + platformFee.amount + advertisingCost + refundFee.amount);
    if (sellingPrice !== null) {
      netProfit = roundMoney(sellingPrice - totalCost);
      if (sellingPrice > 0) {
        profitMarginPct = roundPercent((netProfit / sellingPrice) * 100);
      }
      if (totalCost > 0) {
        roi = roundPercent((netProfit / totalCost) * 100);
      }
      breakEven = netProfit === 0;
    }
  }

  const values: Record<
    ProfitComponentKey,
    { present: boolean; amount: number; fee?: { fixedAmount: number | null; rate: number | null } }
  > = {
    selling_price: { present: hasSellingPrice, amount: sellingPrice ?? 0 },
    supplier_cost: { present: hasSupplierCost, amount: supplierCost ?? 0 },
    shipping_cost: { present: isPresent(input.shippingCost), amount: shippingCost },
    platform_fees: { present: platformFee.present, amount: platformFee.amount, fee: { fixedAmount: platformFee.fixedAmount, rate: platformFee.rate } },
    advertising_cost: { present: isPresent(input.advertisingCost), amount: advertisingCost },
    refund_allowance: { present: refundFee.present, amount: refundFee.amount, fee: { fixedAmount: refundFee.fixedAmount, rate: refundFee.rate } },
  };
  const components: ProfitComponent[] = PROFIT_COMPONENT_DEFINITIONS.map((definition) => {
    const value = values[definition.key];
    const component: ProfitComponent = {
      key: definition.key,
      label: definition.label,
      present: value.present,
      amount: roundMoney(value.amount),
    };
    if (value.fee?.fixedAmount !== null && value.fee?.fixedAmount !== undefined) {
      component.fixedAmount = roundMoney(value.fee.fixedAmount);
    }
    if (value.fee?.rate !== null && value.fee?.rate !== undefined) {
      component.rate = value.fee.rate;
    }
    return component;
  });

  return {
    currency: input.currency,
    sellingPrice: moneyOrNull(sellingPrice),
    supplierCost: moneyOrNull(supplierCost),
    shippingCost: roundMoney(shippingCost),
    platformFees: roundMoney(platformFee.amount),
    advertisingCost: roundMoney(advertisingCost),
    refundAllowance: roundMoney(refundFee.amount),
    totalCost,
    netProfit,
    profitMarginPct,
    roi,
    complete: hasSellingPrice && hasSupplierCost,
    breakEven,
    components,
    inputs: buildInputs(input, { sellingPrice, supplierCost, shippingCost, advertisingCost, platformFee, refundFee }),
  };
}

/**
 * Builds a `ProfitInput` from the existing unified Product model, taking the
 * selling price and currency from the product and combining them with the
 * caller's explicitly supplied cost estimates. Never guesses a cost.
 */
export function profitInputFromProduct(product: Product, costs: ProductProfitCosts = {}): ProfitInput {
  return {
    currency: product.price.currency,
    sellingPrice: product.price.amount,
    ...costs,
  };
}

export interface ProfitRowRefs {
  productId?: string;
  productSourceId?: string | null;
}

/**
 * Maps a profit result to rows of the existing `metrics` table (see
 * supabase/migrations/20260817000007_metrics.sql). Pure and deterministic: it
 * never touches Supabase, it only produces the rows a caller may persist.
 * Only derived values that could actually be computed are emitted.
 */
export function toProfitRows(result: ProfitResult, refs: ProfitRowRefs = {}): Array<Record<string, unknown>> {
  const base = {
    product_id: refs.productId ?? null,
    product_source_id: refs.productSourceId ?? null,
    source_id: null,
    metadata: result.inputs,
  };
  const rows: Array<Record<string, unknown>> = [];
  if (result.totalCost !== null) {
    rows.push({ ...base, metric_type: "total_cost", value: result.totalCost, unit: result.currency });
  }
  if (result.netProfit !== null) {
    rows.push({ ...base, metric_type: "net_profit", value: result.netProfit, unit: result.currency });
  }
  if (result.profitMarginPct !== null) {
    rows.push({ ...base, metric_type: "profit_margin_pct", value: result.profitMarginPct, unit: "%" });
  }
  if (result.roi !== null) {
    rows.push({ ...base, metric_type: "roi", value: result.roi, unit: "%" });
  }
  return rows;
}

function resolveFee(
  fee: ProfitFee | undefined,
  sellingPrice: number | null,
): { present: boolean; fixedAmount: number | null; rate: number | null; amount: number } {
  const fixedAmount = normalizeMoney(fee?.amount);
  const rate = normalizeRate(fee?.rate);
  if (fixedAmount === null && rate === null) {
    return { present: false, fixedAmount: null, rate: null, amount: 0 };
  }
  const rateAmount = rate !== null && sellingPrice !== null ? sellingPrice * rate : 0;
  return { present: true, fixedAmount, rate, amount: (fixedAmount ?? 0) + rateAmount };
}

function isPresent(value: number | undefined): boolean {
  return normalizeMoney(value) !== null;
}

function moneyOrNull(value: number | null): number | null {
  return value === null ? null : roundMoney(value);
}

function buildInputs(
  input: ProfitInput,
  normalized: {
    sellingPrice: number | null;
    supplierCost: number | null;
    shippingCost: number;
    advertisingCost: number;
    platformFee: { fixedAmount: number | null; rate: number | null };
    refundFee: { fixedAmount: number | null; rate: number | null };
  },
): Record<string, unknown> {
  return {
    currency: input.currency,
    selling_price: moneyOrNull(normalized.sellingPrice),
    supplier_cost: moneyOrNull(normalized.supplierCost),
    shipping_cost: roundMoney(normalized.shippingCost),
    platform_fee_amount: moneyOrNull(normalized.platformFee.fixedAmount),
    platform_fee_rate: normalized.platformFee.rate,
    advertising_cost: roundMoney(normalized.advertisingCost),
    refund_allowance_amount: moneyOrNull(normalized.refundFee.fixedAmount),
    refund_allowance_rate: normalized.refundFee.rate,
  };
}
