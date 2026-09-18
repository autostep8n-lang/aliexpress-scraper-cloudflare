export const SHOPIFY_API_VERSION = "2026-07";
export const SHOPIFY_MAX_IMAGES = 10;
export const DEFAULT_VARIANT_OPTION_NAME = "Title";
export const DEFAULT_VARIANT_OPTION_VALUE = "Default Title";

export type ShopifyListingStatus = "draft" | "exported" | "error";

export interface ShopifyFileInput {
  originalSource: string;
  contentType: "IMAGE";
  alt?: string;
}

export interface ShopifyVariantInput {
  optionValues: Array<{ optionName: string; name: string }>;
  price: string;
  sku?: string;
  id?: string;
}

export interface ShopifyProductSetInput {
  title: string;
  descriptionHtml: string;
  status: "DRAFT";
  vendor?: string;
  productOptions: Array<{ name: string; values: Array<{ name: string }> }>;
  variants: ShopifyVariantInput[];
  files?: ShopifyFileInput[];
}

export interface ShopifyProductSetIdentifiers {
  id: string;
}

export interface ShopifyMappedProduct {
  input: ShopifyProductSetInput;
  sourceCurrency: string;
  imageCount: number;
}

export interface ShopifyConfig {
  shopDomain: string;
  adminToken: string;
  apiVersion: string;
  graphqlUrl: string;
}

export type ShopifyClientCode =
  | "SHOPIFY_AUTH_ERROR"
  | "SHOPIFY_RATE_LIMITED"
  | "SHOPIFY_TIMEOUT"
  | "SHOPIFY_SHOP_FAILED"
  | "SHOPIFY_EXPORT_FAILED";

export class ShopifyClientError extends Error {
  readonly code: ShopifyClientCode;

  constructor(code: ShopifyClientCode, message: string) {
    super(message);
    this.name = "ShopifyClientError";
    this.code = code;
  }
}

export interface ShopifyShopCurrency {
  currencyCode: string;
}

export interface ShopifyProductSetResult {
  productId: string;
  variantId: string | null;
}

export const SHOP_CURRENCY_QUERY = `query { shop { currencyCode } }`;

export const PRODUCT_SET_MUTATION = `mutation ProductSet($synchronous: Boolean!, $identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
  productSet(synchronous: $synchronous, identifier: $identifier, input: $input) {
    product {
      id
      status
      variants(first: 1) {
        nodes {
          id
          sku
          price
        }
      }
    }
    userErrors {
      field
      message
      code
    }
  }
}`;
