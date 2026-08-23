import type { Product } from "../products/types";
import { clamp, computeScore } from "./engine";
import type { ComputeScoreOptions, ScoreResult, ScoreSignalDefinition } from "./types";

/**
 * Default product-quality signal definitions. Each signal consumes the
 * already-normalized `Product` (optionally enriched by the P1.2 enrichment
 * layer) and returns a normalized [0, 1] contribution plus an explainable
 * detail string. Weights sum to 1 so the final score is a weighted average
 * that stays bounded in [0, 100].
 */
export const PRODUCT_QUALITY_SIGNALS: readonly ScoreSignalDefinition<Product>[] = [
  completenessSignal(),
  descriptionSignal(),
  imageSignal(),
  ratingAverageSignal(),
  ratingCountSignal(),
  availabilitySignal(),
  shippingSignal(),
  priceSignal(),
  brandSignal(),
  categorySignal(),
];

/** Deterministic product-quality score for a normalized Product. */
export function scoreProductQuality(product: Product, options: ComputeScoreOptions = {}): ScoreResult {
  return computeScore(product, PRODUCT_QUALITY_SIGNALS, {
    scoreType: "product_quality",
    version: 1,
    ...options,
  });
}

function completenessSignal(): ScoreSignalDefinition<Product> {
  return {
    key: "completeness",
    label: "Data completeness",
    weight: 0.25,
    evaluate: (product) => {
      const checks = [
        typeof product.description === "string" && product.description.trim().length > 0,
        product.category?.name !== undefined && product.category.name.trim().length > 0,
        product.rating !== undefined,
        typeof product.attributes === "object" && product.attributes !== null && Object.keys(product.attributes).length > 0,
        typeof product.attributes?.brand === "string" && product.attributes.brand.trim().length > 0,
        product.images.length > 0,
      ];
      const present = checks.filter(Boolean).length;
      return {
        present: true,
        value: present / checks.length,
        detail: `${present}/${checks.length} optional fields present`,
      };
    },
  };
}

function descriptionSignal(): ScoreSignalDefinition<Product> {
  return {
    key: "description",
    label: "Description depth",
    weight: 0.1,
    evaluate: (product) => {
      const length = product.description?.trim().length ?? 0;
      if (length === 0) return { present: false, value: 0 };
      return {
        present: true,
        value: clamp(length / 200, 0, 1),
        detail: `${length} characters`,
      };
    },
  };
}

function imageSignal(): ScoreSignalDefinition<Product> {
  return {
    key: "images",
    label: "Image count",
    weight: 0.1,
    evaluate: (product) => {
      if (product.images.length === 0) return { present: false, value: 0 };
      return {
        present: true,
        value: clamp(product.images.length / 5, 0, 1),
        detail: `${product.images.length} images`,
      };
    },
  };
}

function ratingAverageSignal(): ScoreSignalDefinition<Product> {
  return {
    key: "rating_average",
    label: "Average rating",
    weight: 0.1,
    evaluate: (product) => {
      const average = product.rating?.average;
      if (typeof average !== "number" || !Number.isFinite(average) || average <= 0) {
        return { present: false, value: 0 };
      }
      return { present: true, value: clamp(average / 5, 0, 1), detail: `${average} / 5` };
    },
  };
}

function ratingCountSignal(): ScoreSignalDefinition<Product> {
  return {
    key: "rating_count",
    label: "Rating volume",
    weight: 0.05,
    evaluate: (product) => {
      const count = product.rating?.count;
      if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
        return { present: false, value: 0 };
      }
      const value = clamp(Math.log10(count + 1) / 3, 0, 1);
      return { present: true, value, detail: `${count} ratings` };
    },
  };
}

function availabilitySignal(): ScoreSignalDefinition<Product> {
  return {
    key: "availability",
    label: "Availability",
    weight: 0.1,
    evaluate: (product) => {
      if (product.available === undefined) return { present: false, value: 0 };
      return {
        present: true,
        value: product.available ? 1 : 0,
        detail: product.available ? "in stock" : "out of stock",
      };
    },
  };
}

function shippingSignal(): ScoreSignalDefinition<Product> {
  return {
    key: "shipping",
    label: "Shipping quality",
    weight: 0.1,
    evaluate: (product) => {
      const shipping = product.shipping;
      if (!shipping) return { present: false, value: 0 };
      if (shipping.free === true) return { present: true, value: 1, detail: "free shipping" };
      const maxDays = shipping.deliveryMaxDays;
      const minDays = shipping.deliveryMinDays;
      if (typeof maxDays === "number") {
        return { present: true, value: clamp(1 - maxDays / 30, 0, 1), detail: `up to ${maxDays} days` };
      }
      if (typeof minDays === "number") {
        return { present: true, value: clamp(1 - minDays / 30, 0, 1), detail: `from ${minDays} days` };
      }
      return { present: true, value: 0.5, detail: "shipping data present" };
    },
  };
}

function priceSignal(): ScoreSignalDefinition<Product> {
  return {
    key: "price",
    label: "Price attractiveness",
    weight: 0.1,
    evaluate: (product) => {
      const { amount, originalAmount } = product.price;
      if (typeof originalAmount !== "number" || originalAmount <= amount || originalAmount <= 0) {
        return { present: false, value: 0 };
      }
      const discount = (originalAmount - amount) / originalAmount;
      return {
        present: true,
        value: clamp(discount, 0, 1),
        detail: `${Math.round(discount * 100)}% below original`,
      };
    },
  };
}

function brandSignal(): ScoreSignalDefinition<Product> {
  return {
    key: "brand",
    label: "Brand present",
    weight: 0.05,
    evaluate: (product) => {
      const brand = product.attributes?.brand;
      if (typeof brand !== "string" || brand.trim().length === 0) return { present: false, value: 0 };
      return { present: true, value: 1, detail: brand.trim() };
    },
  };
}

function categorySignal(): ScoreSignalDefinition<Product> {
  return {
    key: "category",
    label: "Category specificity",
    weight: 0.05,
    evaluate: (product) => {
      const category = product.category;
      if (!category) return { present: false, value: 0 };
      const depth = category.path?.length ?? 0;
      if (depth > 0) return { present: true, value: clamp(depth / 3, 0, 1), detail: `path depth ${depth}` };
      return { present: true, value: 0.5, detail: `category: ${category.name}` };
    },
  };
}
