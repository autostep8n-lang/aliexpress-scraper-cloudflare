import type { Product, ProductPrice } from "./types";
import { SUPPORTED_PLATFORMS } from "./normalize";
import { isHttpUrl } from "../utils/url";

export interface ProductValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Structural validation for the normalized `Product` model. Returns a list of
 * human-readable errors; `valid` is true only when the list is empty.
 */
export function validateProduct(value: unknown): ProductValidationResult {
  const errors: string[] = [];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, errors: ["product must be an object"] };
  }
  const p = value as Record<string, unknown>;

  if (typeof p.platform !== "string" || !(SUPPORTED_PLATFORMS as readonly string[]).includes(p.platform)) {
    errors.push("invalid or missing platform");
  }

  if (typeof p.externalId !== "string" || p.externalId.trim() === "") {
    errors.push("externalId must be a non-empty string");
  }

  if (typeof p.url !== "string" || !isHttpUrl(p.url)) {
    errors.push("url must be a valid http(s) URL");
  }

  if (typeof p.title !== "string" || p.title.trim() === "") {
    errors.push("title must be a non-empty string");
  }

  if (!isValidPrice(p.price)) {
    errors.push("price must be an object with a non-negative numeric amount and a 3-letter currency");
  }

  if (p.images !== undefined) {
    if (!Array.isArray(p.images)) {
      errors.push("images must be an array");
    } else {
      p.images.forEach((img, index) => {
        const url = typeof img === "string" ? img : (img as { url?: unknown } | null)?.url;
        if (typeof url !== "string" || !isHttpUrl(url)) {
          errors.push(`images[${index}].url must be a valid http(s) URL`);
        }
      });
    }
  }

  if (typeof p.scrapedAt !== "string" || Number.isNaN(Date.parse(p.scrapedAt))) {
    errors.push("scrapedAt must be a valid ISO date string");
  }

  return { valid: errors.length === 0, errors };
}

function isValidPrice(value: unknown): value is ProductPrice {
  if (typeof value !== "object" || value === null) return false;
  const price = value as Record<string, unknown>;
  if (typeof price.amount !== "number" || !Number.isFinite(price.amount) || price.amount < 0) return false;
  if (typeof price.currency !== "string" || !/^[A-Z]{3}$/.test(price.currency)) return false;
  return true;
}

export function isProduct(value: unknown): value is Product {
  return validateProduct(value).valid;
}
