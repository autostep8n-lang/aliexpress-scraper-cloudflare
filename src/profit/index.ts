/**
 * Profit Engine - public entry point.
 *
 * Deterministic, source-agnostic product profitability: selling price,
 * supplier cost, shipping, payment/platform fees, advertising and refund
 * allowance aggregate into total cost, net profit, profit margin and ROI.
 * Missing components are never invented (they surface as absent breakdown
 * entries and null derived values); monetary values follow the project's
 * `numeric(18,4)` precision. No I/O, no wall-clock time.
 */

export {
  computeProfit,
  MONEY_PRECISION,
  PERCENT_PRECISION,
  PROFIT_COMPONENT_DEFINITIONS,
  profitInputFromProduct,
  roundMoney,
  roundPercent,
  toProfitRows,
} from "./engine";
export type { ProfitRowRefs } from "./engine";

export type {
  ProfitComponent,
  ProfitComponentKey,
  ProfitFee,
  ProfitInput,
  ProfitResult,
  ProductProfitCosts,
} from "./types";
