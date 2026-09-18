import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchShopCurrency, productSet } from "../../src/shopify/client";
import { PRODUCT_SET_MUTATION, SHOP_CURRENCY_QUERY, ShopifyClientError } from "../../src/shopify/types";
import type { ShopifyConfig, ShopifyProductSetInput } from "../../src/shopify/types";

const config: ShopifyConfig = {
  shopDomain: "example.myshopify.com",
  adminToken: "shpat-test",
  apiVersion: "2026-07",
  graphqlUrl: "https://example.myshopify.com/admin/api/2026-07/graphql.json",
};

const input: ShopifyProductSetInput = {
  title: "Wireless Earbuds",
  descriptionHtml: "A",
  status: "DRAFT",
  productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
  variants: [{ optionValues: [{ optionName: "Title", name: "Default Title" }], price: "12.5" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Shopify GraphQL client", () => {
  it("queries shop currency and sends the access token header", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { shop: { currencyCode: "USD" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchShopCurrency(config)).resolves.toBe("USD");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [request, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(request).toBe(config.graphqlUrl);
    expect((init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpat-test");
    expect(JSON.parse(String(init.body))).toEqual({ query: SHOP_CURRENCY_QUERY, variables: {} });
  });

  it("creates with productSet and no identifier, then updates with identifier.id", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      expect(body.query).toBe(PRODUCT_SET_MUTATION);
      expect(body.variables.synchronous).toBe(true);
      return new Response(
        JSON.stringify({
          data: {
            productSet: {
              product: {
                id: "gid://shopify/Product/1",
                variants: { nodes: [{ id: "gid://shopify/ProductVariant/9" }] },
              },
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await productSet(config, input);
    expect(created).toEqual({ productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/9" });
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).variables.identifier).toBeUndefined();

    await productSet(config, input, { id: "gid://shopify/Product/1" });
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)).variables.identifier).toEqual({
      id: "gid://shopify/Product/1",
    });
  });

  it("maps HTTP 401/403 to SHOPIFY_AUTH_ERROR, 429 to RATE_LIMITED, timeout to TIMEOUT", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    await expect(fetchShopCurrency(config)).rejects.toMatchObject({ code: "SHOPIFY_AUTH_ERROR" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("slow down", { status: 429 })),
    );
    await expect(fetchShopCurrency(config)).rejects.toMatchObject({ code: "SHOPIFY_RATE_LIMITED" });

    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeout;
      }),
    );
    await expect(fetchShopCurrency(config)).rejects.toBeInstanceOf(ShopifyClientError);
    await expect(fetchShopCurrency(config)).rejects.toMatchObject({ code: "SHOPIFY_TIMEOUT" });
  });
});
