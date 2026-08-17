import type { ScraperPlatform } from "../scrapers/types";

export interface ProductPrice {
  amount: number;
  currency: string;
  originalAmount?: number;
}

export interface ProductShipping {
  free?: boolean;
  cost?: ProductPrice;
  deliveryMinDays?: number;
  deliveryMaxDays?: number;
  fromCountry?: string;
}

export interface ProductCategory {
  id?: string;
  name: string;
  path?: string[];
}

export interface ProductRating {
  average?: number;
  count?: number;
}

export interface ProductImage {
  url: string;
  alt?: string;
}

/**
 * Normalized product domain model. Every scraper will produce this shape so
 * downstream consumers (storage, pricing, scoring, APIs) work uniformly.
 */
export interface Product {
  platform: ScraperPlatform;
  externalId: string;
  url: string;
  title: string;
  description?: string;
  price: ProductPrice;
  images: ProductImage[];
  category?: ProductCategory;
  rating?: ProductRating;
  shipping?: ProductShipping;
  attributes?: Record<string, string>;
  available?: boolean;
  scrapedAt: string;
  source?: string;
}
