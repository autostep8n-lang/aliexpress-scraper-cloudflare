import {
  PRODUCT_SET_MUTATION,
  SHOP_CURRENCY_QUERY,
  ShopifyClientError,
  type ShopifyConfig,
  type ShopifyProductSetIdentifiers,
  type ShopifyProductSetInput,
  type ShopifyProductSetResult,
} from "./types";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

interface GraphQlError {
  message?: string;
  extensions?: { code?: string };
}

interface GraphQlEnvelope<T> {
  data?: T;
  errors?: GraphQlError[];
}

interface ShopCurrencyData {
  shop?: { currencyCode?: string };
}

interface ProductSetData {
  productSet?: {
    product?: {
      id?: string;
      variants?: { nodes?: Array<{ id?: string }> };
    };
    userErrors?: Array<{ field?: string[] | null; message?: string; code?: string }>;
  };
}

export async function fetchShopCurrency(config: ShopifyConfig): Promise<string> {
  const body = await graphqlRequest<ShopCurrencyData>(config, SHOP_CURRENCY_QUERY, {}, "SHOPIFY_SHOP_FAILED");
  const currency = body.data?.shop?.currencyCode;
  if (typeof currency !== "string" || !currency.trim()) {
    throw new ShopifyClientError("SHOPIFY_SHOP_FAILED", "shop currencyCode missing");
  }
  return currency;
}

export async function productSet(
  config: ShopifyConfig,
  input: ShopifyProductSetInput,
  identifier?: ShopifyProductSetIdentifiers,
): Promise<ShopifyProductSetResult> {
  const variables: Record<string, unknown> = {
    synchronous: true,
    input,
  };
  if (identifier) {
    variables.identifier = identifier;
  }
  const body = await graphqlRequest<ProductSetData>(config, PRODUCT_SET_MUTATION, variables, "SHOPIFY_EXPORT_FAILED");
  const payload = body.data?.productSet;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    const first = userErrors[0];
    throw new ShopifyClientError(
      "SHOPIFY_EXPORT_FAILED",
      first.message || "productSet userErrors",
    );
  }
  const productId = payload?.product?.id;
  if (typeof productId !== "string" || !productId) {
    throw new ShopifyClientError("SHOPIFY_EXPORT_FAILED", "productSet did not return a product id");
  }
  const variantId = payload?.product?.variants?.nodes?.[0]?.id;
  return {
    productId,
    variantId: typeof variantId === "string" && variantId ? variantId : null,
  };
}

async function graphqlRequest<T>(
  config: ShopifyConfig,
  query: string,
  variables: Record<string, unknown>,
  failureCode: "SHOPIFY_SHOP_FAILED" | "SHOPIFY_EXPORT_FAILED",
): Promise<GraphQlEnvelope<T>> {
  let response: Response;
  try {
    response = await fetch(config.graphqlUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "X-Shopify-Access-Token": config.adminToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ShopifyClientError("SHOPIFY_TIMEOUT", "shopify request timed out");
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ShopifyClientError(failureCode, `shopify request failed: ${message}`);
  }

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new ShopifyClientError("SHOPIFY_AUTH_ERROR", `shopify rejected credentials (HTTP ${response.status})`);
  }
  if (response.status === 429) {
    await response.body?.cancel();
    throw new ShopifyClientError("SHOPIFY_RATE_LIMITED", "shopify rate limited (HTTP 429)");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ShopifyClientError(failureCode, `shopify HTTP ${response.status}`);
  }

  const text = await readLimitedText(response);
  let parsed: GraphQlEnvelope<T>;
  try {
    parsed = JSON.parse(text) as GraphQlEnvelope<T>;
  } catch {
    throw new ShopifyClientError(failureCode, "shopify returned invalid JSON");
  }

  const graphQlCode = firstGraphQlCode(parsed.errors);
  if (graphQlCode === "ACCESS_DENIED" || graphQlCode === "UNAUTHORIZED") {
    throw new ShopifyClientError("SHOPIFY_AUTH_ERROR", parsed.errors?.[0]?.message || "shopify access denied");
  }
  if (graphQlCode === "THROTTLED") {
    throw new ShopifyClientError("SHOPIFY_RATE_LIMITED", parsed.errors?.[0]?.message || "shopify throttled");
  }
  if (parsed.errors && parsed.errors.length > 0 && parsed.data == null) {
    throw new ShopifyClientError(failureCode, parsed.errors[0]?.message || "shopify GraphQL error");
  }
  return parsed;
}

function firstGraphQlCode(errors: GraphQlError[] | undefined): string | undefined {
  const code = errors?.[0]?.extensions?.code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

async function readLimitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ShopifyClientError("SHOPIFY_EXPORT_FAILED", "shopify response exceeded size limit");
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}
