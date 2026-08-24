/**
 * Profit Engine - domain types.
 *
 * Deterministic, source-agnostic profitability calculation from explicitly
 * typed inputs. Cost components are optional; a missing component is never
 * invented, it is simply absent (and flagged `present: false` in the
 * breakdown). Derived values that cannot be computed from the available data
 * are `null`, following the project's existing missing-data conventions.
 */

/** A fee that can be a fixed amount and/or a rate of the selling price. */
export interface ProfitFee {
  /** Fixed amount per unit. */
  amount?: number;
  /** Rate as a fraction of the selling price (0.05 = 5%). */
  rate?: number;
}

/** Explicit, typed inputs to a profit calculation. */
export interface ProfitInput {
  /** Currency for every monetary value (echoed from the Product model). */
  currency: string;
  /** Customer selling price per unit. */
  sellingPrice?: number;
  /** Supplier/product acquisition cost per unit. */
  supplierCost?: number;
  /** Shipping cost per unit. */
  shippingCost?: number;
  /** Payment/platform fees (fixed and/or rate-based). */
  platformFees?: ProfitFee;
  /** Advertising/marketing cost per unit. */
  advertisingCost?: number;
  /** Refund/return allowance (fixed and/or rate-based). */
  refundAllowance?: ProfitFee;
}

/** Cost inputs the Product adapter accepts; selling price/currency come from the Product. */
export type ProductProfitCosts = Pick<
  ProfitInput,
  "supplierCost" | "shippingCost" | "platformFees" | "advertisingCost" | "refundAllowance"
>;

export type ProfitComponentKey =
  | "selling_price"
  | "supplier_cost"
  | "shipping_cost"
  | "platform_fees"
  | "advertising_cost"
  | "refund_allowance";

/** One component of the cost/revenue breakdown. */
export interface ProfitComponent {
  key: ProfitComponentKey;
  label: string;
  /** True when the input carried this component (even at zero). */
  present: boolean;
  /** Computed monetary value for this component (0 when absent). */
  amount: number;
  /** Fixed amount supplied (fee components only). */
  fixedAmount?: number;
  /** Rate supplied as a fraction of the selling price (fee components only). */
  rate?: number;
}

/**
 * Structured profit result, suitable for later dashboard, opportunity
 * scoring and product-ranking features. Derived values are `null` when the
 * underlying data is missing/incomplete; they are never invented.
 */
export interface ProfitResult {
  currency: string;
  /** Normalized selling price, or null when missing/invalid. */
  sellingPrice: number | null;
  /** Normalized supplier cost, or null when missing/invalid. */
  supplierCost: number | null;
  shippingCost: number;
  platformFees: number;
  advertisingCost: number;
  refundAllowance: number;
  /** Sum of all cost components; null when the supplier cost is unknown. */
  totalCost: number | null;
  /** `sellingPrice - totalCost`; null when either input is missing. */
  netProfit: number | null;
  /** `netProfit / sellingPrice * 100`; null when it cannot be derived. */
  profitMarginPct: number | null;
  /** `netProfit / totalCost * 100`; null when it cannot be derived. */
  roi: number | null;
  /** True when both selling price and supplier cost were present. */
  complete: boolean;
  /** True when a computable net profit is exactly zero. */
  breakEven: boolean;
  /** Per-component breakdown explaining how the result was derived. */
  components: ProfitComponent[];
  /** Serializable breakdown suitable for the `metrics.metadata` column. */
  inputs: Record<string, unknown>;
}
