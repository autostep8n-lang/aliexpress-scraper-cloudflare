import { describe, expect, it } from "vitest";
import { parseTiktokSearchPage } from "../../src/scrapers/tiktok-search-parser";
import { ScraperError } from "../../src/scrapers/types";

function searchItem(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId: id,
    title: `Product ${id}`,
    price: 19.99,
    salePrice: 14.99,
    currency: "USD",
    images: [
      {
        url: `https://p16-sign-sg.tiktokcdn.com/obj/${id}.jpg`,
        urlList: [`https://p16-sign-sg.tiktokcdn.com/obj/${id}.jpg`],
      },
    ],
    sellerId: `seller-${id}`,
    sellerName: `Store ${id}`,
    sales: 120,
    itemAvailable: true,
    ...overrides,
  };
}

function searchPageHtml(items: Record<string, unknown>[], total?: number): string {
  const payload = {
    __DEFAULT_SCOPE__: {
      "webapp.search-layout": {
        searchData: {
          data: {
            items,
            ...(total !== undefined ? { total } : {}),
          },
        },
      },
    },
  };
  return `<!doctype html><html><head>
    <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script>
  </head><body></body></html>`;
}

function expectScraperErrorCode(fn: () => unknown, code: string): void {
  let error: unknown;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ScraperError);
  expect((error as ScraperError).code).toBe(code);
}

describe("parseTiktokSearchPage", () => {
  const searchUrl = new URL("https://shop.tiktok.com/search?q=earbuds");

  it("extracts every product card into the discovery shape", () => {
    const page = parseTiktokSearchPage(searchPageHtml([searchItem("111"), searchItem("222"), searchItem("333")], 42), searchUrl);

    expect(page.products).toHaveLength(3);
    expect(page.total).toBe(42);

    const first = page.products[0];
    expect(first.externalId).toBe("111");
    expect(first.title).toBe("Product 111");
    expect(first.price).toEqual({ amount: 14.99, currency: "USD" });
    expect(first.images).toEqual([
      { url: "https://p16-sign-sg.tiktokcdn.com/obj/111.jpg", alt: "Product 111" },
    ]);
    expect(first.attributes).toMatchObject({ sellerId: "seller-111", sellerName: "Store 111", sales: "120" });
    expect(first.available).toBe(true);
    expect(first.canonicalUrl).toBe("https://www.tiktok.com/@shop/product/111");
    expect(first.raw.productId).toBe("111");
  });

  it("deduplicates products that appear more than once in the SSR payload", () => {
    const page = parseTiktokSearchPage(searchPageHtml([searchItem("111"), searchItem("111")]), searchUrl);
    expect(page.products).toHaveLength(1);
  });

  it("skips items without a numeric product id", () => {
    const page = parseTiktokSearchPage(searchPageHtml([searchItem("111"), searchItem("abc", { title: "Video" })]), searchUrl);
    expect(page.products.map((p) => p.externalId)).toEqual(["111"]);
  });

  it("skips items missing a title or price", () => {
    const noTitle = searchItem("222", { title: undefined, productTitle: undefined });
    const noPrice = searchItem("333", { price: undefined, salePrice: undefined, minPrice: undefined, priceInfo: undefined });
    const page = parseTiktokSearchPage(searchPageHtml([searchItem("111"), noTitle, noPrice]), searchUrl);
    expect(page.products.map((p) => p.externalId)).toEqual(["111"]);
  });

  it("falls back to item fields when priceInfo carries the price", () => {
    const page = parseTiktokSearchPage(
      searchPageHtml([searchItem("555", { price: undefined, salePrice: undefined, currency: undefined, priceInfo: { currency: "GBP", price: "9.99" } })]),
      searchUrl,
    );
    expect(page.products[0].price).toEqual({ amount: 9.99, currency: "GBP" });
  });

  it("keeps total undefined when no plausible count exists", () => {
    const page = parseTiktokSearchPage(searchPageHtml([searchItem("111")]), searchUrl);
    expect(page.total).toBeUndefined();
  });

  it("returns an empty list for a page with no products", () => {
    const page = parseTiktokSearchPage(searchPageHtml([]), searchUrl);
    expect(page.products).toEqual([]);
  });

  it("throws BLOCKED for a challenge or captcha page", () => {
    expectScraperErrorCode(
      () => parseTiktokSearchPage("<html><body>Please verify you are human. Captcha required.</body></html>"),
      "BLOCKED",
    );
  });

  it("throws NO_PRODUCT_DATA when no SSR json is present", () => {
    expectScraperErrorCode(() => parseTiktokSearchPage("<html><body>empty app shell</body></html>"), "NO_PRODUCT_DATA");
  });
});
