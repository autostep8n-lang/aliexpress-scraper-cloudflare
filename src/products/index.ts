export { enrichProduct, DEFAULT_KEYS } from "./enrich";
export type { EnrichmentKeys, EnrichProductOptions } from "./enrich";
export {
  normalizeProduct,
  SUPPORTED_PLATFORMS,
  ProductNormalizationError,
  asString,
  toFiniteNumber,
  normalizeCategory,
  normalizeRating,
  normalizeShipping,
  normalizeAttributes,
  normalizeAvailability,
} from "./normalize";
export type { NormalizeProductOptions } from "./normalize";
export { isProduct, validateProduct } from "./validation";
export type {
  Product,
  ProductCategory,
  ProductImage,
  ProductPrice,
  ProductRating,
  ProductShipping,
} from "./types";
