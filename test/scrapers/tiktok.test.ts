import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { looksBlocked, parseTiktokPage } from "../../src/scrapers/tiktok-parser";
import { isTiktokHost, isTiktokProductPath, tiktokScraper } from "../../src/scrapers/tiktok";
import { ScraperError } from "../../src/scrapers/types";

const ctx = {} as ExecutionContext;

function productItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId: "123456789",
    title: "Wireless Earbuds Pro",
    description: "High-fidelity wireless earbuds with active noise cancellation.",
    price: 19.99,
    salePrice: 14.99,
    compareAtPrice: 29.99,
    currency: "USD",
    images: [
      { url: "https://p16-sign-sg.tiktokcdn.com/obj/1.jpg", urlList: ["https://p16-sign-sg.tiktokcdn.com/obj/1.jpg"] },
      { url: "https://p16-sign-sg.tiktokcdn.com/obj/2.jpg" },
    ],
    category: { id: "c1", name: "Electronics", path: ["Home", "Electronics"] },
    rating: { ratingScore: 4.7, ratingCount: 321 },
    itemAvailable: true,
    freeShipping: true,
    stock: 5,
    sellerId: "seller-1",
    sellerName: "Cool Store",
    shopName: "Cool Store Official",
    sales: 1200,
    productType: "1",
    isOfficialStore: true,
    ...overrides,
  };
}

function productPageHtml(item: Record<string, unknown>): string {
  const payload = {
    __DEFAULT_SCOPE__: {
      "webapp.product-detail": {
        productInfo: { item },
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

function stubFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
    return Promise.resolve(handler(url, init));
  });
}

describe("parseTiktokPage", () => {
  it("maps a full product page into the normalize-ready shape", () => {
    const parsed = parseTiktokPage(productPageHtml(productItem()), new URL("https://www.tiktok.com/@shop/product/123456789"));

    expect(parsed.externalId).toBe("123456789");
    expect(parsed.title).toBe("Wireless Earbuds Pro");
    expect(parsed.description).toBe("High-fidelity wireless earbuds with active noise cancellation.");
    expect(parsed.price).toEqual({ amount: 14.99, currency: "USD", originalAmount: 29.99 });
    expect(parsed.images).toEqual([
      { url: "https://p16-sign-sg.tiktokcdn.com/obj/1.jpg", alt: "Wireless Earbuds Pro" },
      { url: "https://p16-sign-sg.tiktokcdn.com/obj/2.jpg", alt: "Wireless Earbuds Pro" },
    ]);
    expect(parsed.category).toEqual({ id: "c1", name: "Electronics", path: ["Home", "Electronics"] });
    expect(parsed.rating).toEqual({ average: 4.7, count: 321 });
    expect(parsed.shipping).toEqual({ free: true });
    expect(parsed.available).toBe(true);
    expect(parsed.attributes).toMatchObject({
      sellerId: "seller-1",
      sellerName: "Cool Store",
      shopName: "Cool Store Official",
      sales: "1200",
      productType: "1",
      isOfficialStore: "true",
    });
    expect(parsed.raw.productId).toBe("123456789");
  });

  it("reads priceInfo variants and string prices", () => {
    const parsed = parseTiktokPage(
      productPageHtml(
        productItem({
          price: undefined,
          salePrice: undefined,
          compareAtPrice: undefined,
          currency: undefined,
          priceInfo: { currency: "GBP", price: "9.99", originalPrice: "19.99" },
        }),
      ),
    );
    expect(parsed.price).toEqual({ amount: 9.99, currency: "GBP", originalAmount: 19.99 });
  });

  it("does not set originalAmount when it is below the current price", () => {
    const parsed = parseTiktokPage(productPageHtml(productItem({ compareAtPrice: 5 })));
    expect(parsed.price).toEqual({ amount: 14.99, currency: "USD" });
  });

  it("extracts the window.__UNIVERSAL_DATA_FOR_REHYDRATION__ assignment form", () => {
    const payload = {
      __DEFAULT_SCOPE__: {
        "webapp.product-detail": {
          productInfo: { item: productItem() },
        },
      },
    };
    const html = `<html><head><script>window.__UNIVERSAL_DATA_FOR_REHYDRATION__ = ${JSON.stringify(payload)};</script></head></html>`;
    const parsed = parseTiktokPage(html);
    expect(parsed.externalId).toBe("123456789");
  });

  it("falls back to the URL when the item has no id", () => {
    const item = productItem();
    delete item.productId;
    const parsed = parseTiktokPage(productPageHtml(item), new URL("https://www.tiktok.com/@shop/product/999888777"));
    expect(parsed.externalId).toBe("999888777");
  });

  it("throws NO_PRODUCT_DATA when no SSR json is present", () => {
    expectScraperErrorCode(() => parseTiktokPage("<html><body>nothing here</body></html>"), "NO_PRODUCT_DATA");
  });

  it("throws BLOCKED for a challenge or captcha page", () => {
    expectScraperErrorCode(
      () => parseTiktokPage("<html><body>Please verify you are human. Captcha required.</body></html>"),
      "BLOCKED",
    );
  });

  it("throws NO_PRODUCT_DATA when json has no recognizable product", () => {
    expectScraperErrorCode(() => parseTiktokPage(productPageHtml({ id: "abc", title: "A video" })), "NO_PRODUCT_DATA");
  });

  it("detects challenge markers with looksBlocked", () => {
    expect(looksBlocked("<html>Access Denied, recaptcha verify</html>")).toBe(true);
    expect(looksBlocked("<html>a normal page</html>")).toBe(false);
  });
});

describe("tiktokScraper supports", () => {
  it("accepts product and short-link urls and rejects everything else", () => {
    const cases: Array<[string, boolean]> = [
      ["https://www.tiktok.com/@shop/product/123", true],
      ["https://tiktok.com/@user/product/123", true],
      ["https://shop.tiktok.com/view/product/123", true],
      ["https://www.shop.tiktok.com/view/product/123", true],
      ["https://vm.tiktok.com/abc", true],
      ["https://www.tiktok.com/t/abc", true],
      ["https://www.tiktok.com/@user/video/123", false],
      ["https://www.tiktok.com/foryou", false],
      ["https://www.tiktok.com/@user", false],
      ["https://www.aliexpress.com/item/1.html", false],
      ["https://www.amazon.com/dp/B0ABC123", false],
      ["https://tiktok.com.evil.com/@user/product/1", false],
    ];
    for (const [raw, expected] of cases) {
      expect(tiktokScraper.supports(new URL(raw))).toBe(expected);
    }
  });

  it("isTiktokHost and isTiktokProductPath behave as expected", () => {
    expect(isTiktokHost("www.tiktok.com")).toBe(true);
    expect(isTiktokHost("shop.tiktok.com")).toBe(true);
    expect(isTiktokHost("evil.com")).toBe(false);
    expect(isTiktokProductPath("/view/product/123")).toBe(true);
    expect(isTiktokProductPath("/@shop/product/123")).toBe(true);
    expect(isTiktokProductPath("/@shop/video/123")).toBe(false);
  });
});

describe("tiktokScraper scrape", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const productUrl = new URL("https://www.tiktok.com/@shop/product/123456789");

  it("fetches the page and returns a normalized ScraperResult", async () => {
    stubFetch(() => new Response(productPageHtml(productItem()), { status: 200 }));
    const result = await tiktokScraper.scrape(productUrl, {} as Env, ctx);

    expect(result.platform).toBe("tiktok-shop");
    expect(result.url).toBe("https://www.tiktok.com/@shop/product/123456789");
    expect(result.title).toBe("Wireless Earbuds Pro");
    expect(result.scrapedAt).toBeTruthy();
    expect(result.data).toMatchObject({
      externalId: "123456789",
      title: "Wireless Earbuds Pro",
      price: { amount: 14.99, currency: "USD", originalAmount: 29.99 },
      source: "tiktok-shop",
      attributes: { sales: "1200", sellerName: "Cool Store" },
    });
  });

  it("follows short-link redirects to the product page", async () => {
    let hops = 0;
    stubFetch((url) => {
      hops++;
      if (url.hostname === "vm.tiktok.com") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.tiktok.com/@shop/product/123456789" },
        });
      }
      return new Response(productPageHtml(productItem()), { status: 200 });
    });

    const result = await tiktokScraper.scrape(new URL("https://vm.tiktok.com/abc"), {} as Env, ctx);
    expect(hops).toBe(2);
    expect(result.url).toBe("https://www.tiktok.com/@shop/product/123456789");
  });

  it("sends a realistic user agent", async () => {
    let sentHeaders: Headers | undefined;
    stubFetch((_url, init) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(productPageHtml(productItem()), { status: 200 });
    });
    await tiktokScraper.scrape(productUrl, {} as Env, ctx);
    expect(sentHeaders?.get("user-agent")).toContain("Chrome");
  });

  it("throws NOT_PRODUCT_PAGE when a short link resolves to a video", async () => {
    stubFetch((url) => {
      if (url.hostname === "vm.tiktok.com") {
        return new Response(null, { status: 302, headers: { location: "https://www.tiktok.com/@user/video/999" } });
      }
      return new Response("<html></html>", { status: 200 });
    });
    await expect(tiktokScraper.scrape(new URL("https://vm.tiktok.com/abc"), {} as Env, ctx)).rejects.toMatchObject({
      code: "NOT_PRODUCT_PAGE",
    });
  });

  it("throws REDIRECT_UNTRUSTED when a redirect leaves tiktok.com", async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }));
    await expect(tiktokScraper.scrape(new URL("https://vm.tiktok.com/abc"), {} as Env, ctx)).rejects.toMatchObject({
      code: "REDIRECT_UNTRUSTED",
    });
  });

  it("throws HTTP_ERROR on a non-2xx response", async () => {
    stubFetch(() => new Response("forbidden", { status: 403 }));
    await expect(tiktokScraper.scrape(productUrl, {} as Env, ctx)).rejects.toMatchObject({ code: "HTTP_ERROR" });
  });

  it("throws NO_PRODUCT_DATA when the page has no SSR json", async () => {
    stubFetch(() => new Response("<html><body>nothing</body></html>", { status: 200 }));
    await expect(tiktokScraper.scrape(productUrl, {} as Env, ctx)).rejects.toMatchObject({ code: "NO_PRODUCT_DATA" });
  });

  it("throws BLOCKED on a captcha page", async () => {
    stubFetch(() => new Response("<html><body>Captcha required to continue.</body></html>", { status: 200 }));
    await expect(tiktokScraper.scrape(productUrl, {} as Env, ctx)).rejects.toMatchObject({ code: "BLOCKED" });
  });

  it("reuses the SCRAPE_CACHE for repeat scrapes of the same page", async () => {
    const store = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string): Promise<string | null> => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string): Promise<void> => {
        store.set(key, value);
      }),
    } as unknown as KVNamespace;
    const cacheEnv = { SCRAPE_CACHE: cache } as Env;
    const waitUntilCtx = { waitUntil: (promise: Promise<unknown>): void => void promise } as unknown as ExecutionContext;

    let fetches = 0;
    stubFetch(() => {
      fetches++;
      return new Response(productPageHtml(productItem()), { status: 200 });
    });

    await tiktokScraper.scrape(productUrl, cacheEnv, waitUntilCtx);
    await tiktokScraper.scrape(productUrl, cacheEnv, waitUntilCtx);

    expect(fetches).toBe(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.get).toHaveBeenCalledTimes(2);
  });
});
