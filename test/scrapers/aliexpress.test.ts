import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { aliexpressScraper, extractItemId, fetchAliExpressPage, isAliExpressHost } from "../../src/scrapers/aliexpress";
import {
  currencyForTld,
  extractItemIdFromPathname,
  extractJsonLd,
  extractRdsBlocks,
  extractRunParams,
  isAliExpressItemPath,
  looksBlocked,
  parseAliExpressPage,
} from "../../src/scrapers/aliexpress-parser";
import { findScraper } from "../../src/scrapers/registry";
import { ScraperError } from "../../src/scrapers/types";

const ctx = {} as ExecutionContext;

const ITEM_ID = "1005001234567890";

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

function ldScript(obj: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
}

function runParamsScript(params: unknown): string {
  return `<script type="text/javascript">window.runParams = ${JSON.stringify(params)};</script>`;
}

function rdsInitScript(data: unknown): string {
  return `<script type="text/javascript">RDS.init(${JSON.stringify({ name: "PRODUCT", data })});</script>`;
}

function runParams(): Record<string, unknown> {
  return {
    data: {
      actionModule: { itemId: ITEM_ID },
      titleModule: { subject: "Wireless Earbuds Pro", skuTitle: "Wireless Earbuds Pro" },
      priceModule: {
        discountPrice: "12.99",
        formatedPrice: "US $25.99",
        formatedActivityPrice: "US $12.99",
        price: { value: 12.99, formatedAmount: "US $12.99", currency: "USD" },
      },
      headerModule: { currency: "USD" },
      imageModule: {
        imagePathList: ["//ae01.alicdn.com/kf/Habc.jpg", "//ae01.alicdn.com/kf/Hdef.jpg"],
      },
      skuModule: {
        productPriceCalcInfo: {
          rangePrice: [{ value: 12.99, formatedAmount: "US $12.99" }],
          rangeOriginalPrice: [{ value: 25.99, formatedAmount: "US $25.99" }],
        },
        productSKUPropertyList: [
          { skuPropertyName: "Color", skuPropertyValues: [{ propertyValueDefinitionName: "Black" }] },
        ],
      },
      storeModule: { storeName: "Cool Store", storeUrl: "//www.aliexpress.com/store/123" },
      specsModule: {
        props: [
          { attrName: "Brand", attrValue: "SoundCore" },
          { attrName: "Material", attrValue: "ABS" },
        ],
      },
      feedbackModule: { feedbackRating: { averageStar: "4.7", totalValidNum: "3210" } },
      descriptionModule: { descriptionUrl: `//www.aliexpress.com/item/${ITEM_ID}.html` },
      breadcrumbModule: { list: [{ name: "Consumer Electronics" }, { name: "Headphones" }] },
    },
  };
}

function productPageHtml(options: { runParams?: unknown; ld?: unknown[]; extra?: string; canonical?: string } = {}): string {
  const rp = options.runParams ?? runParams();
  const ld = options.ld ?? [];
  const canonical = options.canonical ?? `https://www.aliexpress.com/item/${ITEM_ID}.html`;
  return `<!doctype html><html><head>
    <link rel="canonical" href="${canonical}">
    ${ld.map(ldScript).join("\n")}
  </head><body>
    ${runParamsScript(rp)}
    ${options.extra ?? ""}
  </body></html>`;
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

describe("AliExpress host and URL handling", () => {
  it("isAliExpressHost accepts aliexpress.com, subdomains, and country domains", () => {
    for (const host of [
      "aliexpress.com",
      "www.aliexpress.com",
      "ru.aliexpress.com",
      "pt.aliexpress.com",
      "aliexpress.co.uk",
      "www.aliexpress.co.uk",
      "aliexpress.de",
      "www.aliexpress.de",
      "aliexpress.fr",
      "aliexpress.us",
    ]) {
      expect(isAliExpressHost(host)).toBe(true);
    }
  });

  it("isAliExpressHost rejects unrelated and lookalike hosts", () => {
    for (const host of [
      "aliexpress.com.evil.com",
      "www.aliexpress.com.evil.com",
      "aliexpress.co.uk.evil.com",
      "evilaliexpress.com",
      "evil.com",
      "www.evil.com",
      "amazon.com",
      "www.tiktok.com",
      "aliexpress",
    ]) {
      expect(isAliExpressHost(host)).toBe(false);
    }
  });

  it("extractItemIdFromPathname handles item paths and normalization", () => {
    expect(extractItemIdFromPathname(`/item/${ITEM_ID}.html`)).toBe(ITEM_ID);
    expect(extractItemIdFromPathname(`/item/${ITEM_ID}`)).toBe(ITEM_ID);
    expect(extractItemIdFromPathname(`/item/${ITEM_ID}/`)).toBe(ITEM_ID);
    expect(isAliExpressItemPath(`/item/${ITEM_ID}.html`)).toBe(true);
  });

  it("extractItemIdFromPathname rejects short ids and non-item paths", () => {
    expect(extractItemIdFromPathname("/item/1.html")).toBeUndefined();
    expect(extractItemIdFromPathname("/item/123.html")).toBeUndefined();
    expect(extractItemIdFromPathname("/item/abc.html")).toBeUndefined();
    expect(extractItemIdFromPathname("/w/wholesale-earbuds.html")).toBeUndefined();
    expect(extractItemIdFromPathname("/category/203000000.html")).toBeUndefined();
    expect(extractItemIdFromPathname("/")).toBeUndefined();
  });

  it("extractItemId reads the item id from full URLs", () => {
    expect(extractItemId(new URL(`https://www.aliexpress.com/item/${ITEM_ID}.html`))).toBe(ITEM_ID);
    expect(extractItemId(new URL(`https://www.aliexpress.co.uk/item/${ITEM_ID}.html`))).toBe(ITEM_ID);
    expect(extractItemId(new URL(`https://www.aliexpress.com/item/${ITEM_ID}.html?spm=a2g0o.productlist`))).toBe(ITEM_ID);
  });
});

describe("aliexpressScraper supports", () => {
  it("accepts item URLs on all supported domains and rejects everything else", () => {
    const cases: Array<[string, boolean]> = [
      [`https://www.aliexpress.com/item/${ITEM_ID}.html`, true],
      [`https://aliexpress.com/item/${ITEM_ID}.html`, true],
      [`https://ru.aliexpress.com/item/${ITEM_ID}.html`, true],
      [`https://www.aliexpress.co.uk/item/${ITEM_ID}.html`, true],
      [`https://www.aliexpress.de/item/${ITEM_ID}.html`, true],
      [`https://www.aliexpress.us/item/${ITEM_ID}.html`, true],
      [`https://www.aliexpress.com/item/${ITEM_ID}.html?spm=x-1`, true],
      ["https://www.aliexpress.com/w/wholesale-earbuds.html", false],
      ["https://www.aliexpress.com/category/203000000.html", false],
      [`https://www.aliexpress.com/item/123.html`, false],
      [`https://aliexpress.com.evil.com/item/${ITEM_ID}.html`, false],
      ["https://www.evilaliexpress.com/item/123.html", false],
      ["https://www.amazon.com/dp/B0B1234567", false],
      ["https://www.tiktok.com/@shop/product/123", false],
    ];
    for (const [raw, expected] of cases) {
      expect(aliexpressScraper.supports(new URL(raw))).toBe(expected);
    }
  });
});

describe("parseAliExpressPage (runParams)", () => {
  it("maps a full product page into the normalize-ready shape", () => {
    const parsed = parseAliExpressPage(productPageHtml(), {
      url: new URL(`https://www.aliexpress.com/item/${ITEM_ID}.html`),
    });

    expect(parsed.itemId).toBe(ITEM_ID);
    expect(parsed.title).toBe("Wireless Earbuds Pro");
    expect(parsed.price).toEqual({ amount: 12.99, currency: "USD", originalAmount: 25.99 });
    expect(parsed.images).toEqual([
      { url: "https://ae01.alicdn.com/kf/Habc.jpg" },
      { url: "https://ae01.alicdn.com/kf/Hdef.jpg" },
    ]);
    expect(parsed.category).toEqual({
      name: "Headphones",
      path: ["Consumer Electronics", "Headphones"],
    });
    expect(parsed.rating).toEqual({ average: 4.7, count: 3210 });
    expect(parsed.seller).toBe("Cool Store");
    expect(parsed.brand).toBe("SoundCore");
    expect(parsed.attributes).toEqual({
      Brand: "SoundCore",
      Material: "ABS",
      seller: "Cool Store",
      brand: "SoundCore",
    });
    expect(parsed.raw.itemId).toBe(ITEM_ID);
    expect(parsed.raw.runParams).toMatchObject({ titleModule: { subject: "Wireless Earbuds Pro" } });
  });

  it("derives the item id from the canonical link when no hint is given", () => {
    const parsed = parseAliExpressPage(productPageHtml());
    expect(parsed.itemId).toBe(ITEM_ID);
  });

  it("derives the item id from actionModule when the page has no canonical link", () => {
    const parsed = parseAliExpressPage(productPageHtml({ canonical: "https://www.aliexpress.com/" }), {
      itemId: ITEM_ID,
    });
    expect(parsed.itemId).toBe(ITEM_ID);
  });

  it("is deterministic for the same fixture", () => {
    const html = productPageHtml();
    expect(parseAliExpressPage(html)).toEqual(parseAliExpressPage(html));
  });

  it("extracts modules from an RDS.init block when runParams is absent", () => {
    const html = `<html><head>
      <link rel="canonical" href="https://www.aliexpress.com/item/${ITEM_ID}.html">
    </head><body>${rdsInitScript(runParams()["data"])}</body></html>`;
    const parsed = parseAliExpressPage(html);
    expect(parsed.title).toBe("Wireless Earbuds Pro");
    expect(parsed.price).toEqual({ amount: 12.99, currency: "USD", originalAmount: 25.99 });
  });
});

describe("parseAliExpressPage (JSON-LD fallback)", () => {
  const productLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Wireless Earbuds Pro",
    description: "High-fidelity wireless earbuds with active noise cancellation.",
    image: ["https://ae01.alicdn.com/kf/Habc.jpg"],
    brand: { "@type": "Brand", name: "SoundCore" },
    aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", reviewCount: "1321" },
    offers: {
      "@type": "Offer",
      price: "49.99",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      seller: { "@type": "Organization", name: "Cool Store" },
    },
  };

  it("maps a JSON-LD product page without any runParams", () => {
    const html = productPageHtml({ runParams: { data: {} }, ld: [productLd] });
    const parsed = parseAliExpressPage(html);

    expect(parsed.itemId).toBe(ITEM_ID);
    expect(parsed.title).toBe("Wireless Earbuds Pro");
    expect(parsed.description).toBe("High-fidelity wireless earbuds with active noise cancellation.");
    expect(parsed.price).toEqual({ amount: 49.99, currency: "USD" });
    expect(parsed.images).toEqual([{ url: "https://ae01.alicdn.com/kf/Habc.jpg" }]);
    expect(parsed.rating).toEqual({ average: 4.6, count: 1321 });
    expect(parsed.availability).toBe(true);
    expect(parsed.seller).toBe("Cool Store");
    expect(parsed.brand).toBe("SoundCore");
    expect(parsed.attributes).toEqual({ seller: "Cool Store", brand: "SoundCore" });
  });

  it("parses multiple JSON-LD blocks and skips malformed ones", () => {
    const html = `<html><head>
      <link rel="canonical" href="https://www.aliexpress.com/item/${ITEM_ID}.html">
      <script type="application/ld+json">${"{"}</script>
      ${ldScript(productLd)}
    </head><body>${runParamsScript({ data: {} })}</body></html>`;
    expect(extractJsonLd(html)).toHaveLength(1);
    expect(parseAliExpressPage(html).title).toBe("Wireless Earbuds Pro");
  });
});

describe("parseAliExpressPage (HTML fallbacks)", () => {
  const fallbackHtml = (): string =>
    `<!doctype html><html><head>
      <link rel="canonical" href="https://www.aliexpress.co.uk/item/${ITEM_ID}.html">
      <title>Wireless Earbuds Pro UK</title>
      <meta property="og:title" content="Wireless Earbuds Pro UK">
      <meta property="og:image" content="https://ae01.alicdn.com/kf/Habc.jpg">
      <meta property="og:price:amount" content="39.99">
      <meta property="og:price:currency" content="GBP">
      <meta name="description" content="Budget earbuds from a UK store.">
    </head><body>
      <span class="price--currentPriceText">GBP 39.99</span>
      <img src="https://ae01.alicdn.com/kf/Hdef.jpg">
    </body></html>`;

  it("parses without any runParams or JSON-LD using stable page metadata", () => {
    const parsed = parseAliExpressPage(fallbackHtml());

    expect(parsed.itemId).toBe(ITEM_ID);
    expect(parsed.title).toBe("Wireless Earbuds Pro UK");
    expect(parsed.description).toBe("Budget earbuds from a UK store.");
    expect(parsed.price).toEqual({ amount: 39.99, currency: "GBP" });
    expect(parsed.images).toEqual([
      { url: "https://ae01.alicdn.com/kf/Habc.jpg" },
      { url: "https://ae01.alicdn.com/kf/Hdef.jpg" },
    ]);
  });

  it("leaves missing optional fields undefined instead of fabricating them", () => {
    const parsed = parseAliExpressPage(
      productPageHtml({
        runParams: {
          data: {
            actionModule: { itemId: ITEM_ID },
            titleModule: { subject: "Bare Product" },
            priceModule: { discountPrice: "5" },
          },
        },
      }),
      { itemId: ITEM_ID },
    );
    expect(parsed.title).toBe("Bare Product");
    expect(parsed.price).toEqual({ amount: 5, currency: "USD" });
    expect(parsed.description).toBeUndefined();
    expect(parsed.category).toBeUndefined();
    expect(parsed.rating).toBeUndefined();
    expect(parsed.availability).toBeUndefined();
    expect(parsed.seller).toBeUndefined();
    expect(parsed.brand).toBeUndefined();
    expect(parsed.images).toEqual([]);
    expect(parsed.attributes).toEqual({});
  });

  it("derives the currency from the host when nothing else carries it", () => {
    for (const [hostname, currency] of [
      ["www.aliexpress.com", "USD"],
      ["www.aliexpress.co.uk", "GBP"],
      ["www.aliexpress.de", "EUR"],
      ["www.aliexpress.ru", "RUB"],
      ["www.aliexpress.jp", "JPY"],
    ] as const) {
      expect(currencyForTld(hostname)).toBe(currency);
    }
    expect(currencyForTld("evil.com")).toBeUndefined();
    expect(currencyForTld(undefined)).toBeUndefined();
  });
});

describe("parseAliExpressPage error handling", () => {
  it("throws NO_PRODUCT_DATA when no product data is present", () => {
    expectScraperErrorCode(() => parseAliExpressPage("<html><body>nothing here</body></html>"), "NO_PRODUCT_DATA");
  });

  it("throws NO_PRODUCT_DATA when the title is missing", () => {
    const html = productPageHtml({
      runParams: { data: { actionModule: { itemId: ITEM_ID }, priceModule: { discountPrice: "10" } } },
    });
    expectScraperErrorCode(() => parseAliExpressPage(html), "NO_PRODUCT_DATA");
  });

  it("throws NO_PRODUCT_DATA when the price is missing", () => {
    const html = productPageHtml({
      runParams: { data: { actionModule: { itemId: ITEM_ID }, titleModule: { subject: "No Price Product" } } },
    });
    expectScraperErrorCode(() => parseAliExpressPage(html), "NO_PRODUCT_DATA");
  });

  it("throws BLOCKED for an anti-bot check page", () => {
    expectScraperErrorCode(
      () => parseAliExpressPage("<html><body>Please verify you are human to continue</body></html>"),
      "BLOCKED",
    );
  });

  it("looksBlocked detects challenge markers", () => {
    expect(looksBlocked("<html>Captcha required. Unusual traffic detected.</html>")).toBe(true);
    expect(looksBlocked("<html>a normal page</html>")).toBe(false);
  });
});

describe("aliexpressScraper scrape", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const productUrl = new URL(`https://www.aliexpress.com/item/${ITEM_ID}.html`);

  it("fetches the page and returns a normalized ScraperResult", async () => {
    stubFetch(() => new Response(productPageHtml(), { status: 200 }));
    const result = await aliexpressScraper.scrape(productUrl, {} as Env, ctx);

    expect(result.platform).toBe("aliexpress");
    expect(result.url).toBe(productUrl.href);
    expect(result.title).toBe("Wireless Earbuds Pro");
    expect(result.scrapedAt).toBeTruthy();
    expect(result.data).toMatchObject({
      externalId: ITEM_ID,
      title: "Wireless Earbuds Pro",
      price: { amount: 12.99, currency: "USD", originalAmount: 25.99 },
      source: "aliexpress",
      attributes: { Brand: "SoundCore", Material: "ABS", seller: "Cool Store", brand: "SoundCore" },
    });
  });

  it("follows redirects to the final product page", async () => {
    let hops = 0;
    stubFetch((url) => {
      hops++;
      if (url.pathname === "/item/9999999999.html") {
        return new Response(null, {
          status: 301,
          headers: { location: `https://www.aliexpress.com/item/${ITEM_ID}.html` },
        });
      }
      return new Response(productPageHtml(), { status: 200 });
    });
    const result = await aliexpressScraper.scrape(
      new URL("https://www.aliexpress.com/item/9999999999.html"),
      {} as Env,
      ctx,
    );
    expect(hops).toBe(2);
    expect(result.url).toBe(productUrl.href);
  });

  it("sends a realistic user agent", async () => {
    let sentHeaders: Headers | undefined;
    stubFetch((_url, init) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(productPageHtml(), { status: 200 });
    });
    await aliexpressScraper.scrape(productUrl, {} as Env, ctx);
    expect(sentHeaders?.get("user-agent")).toContain("Chrome");
  });

  it("throws REDIRECT_UNTRUSTED when a redirect leaves aliexpress", async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }));
    await expect(aliexpressScraper.scrape(productUrl, {} as Env, ctx)).rejects.toMatchObject({
      code: "REDIRECT_UNTRUSTED",
    });
  });

  it("throws HTTP_ERROR on a non-2xx response", async () => {
    stubFetch(() => new Response("forbidden", { status: 403 }));
    await expect(aliexpressScraper.scrape(productUrl, {} as Env, ctx)).rejects.toMatchObject({ code: "HTTP_ERROR" });
  });

  it("throws NO_PRODUCT_DATA when the page has no product data", async () => {
    stubFetch(() => new Response("<html><body>nothing</body></html>", { status: 200 }));
    await expect(aliexpressScraper.scrape(productUrl, {} as Env, ctx)).rejects.toMatchObject({
      code: "NO_PRODUCT_DATA",
    });
  });

  it("throws BLOCKED on an anti-bot check page", async () => {
    stubFetch(() => new Response("<html><body>Please verify you are human</body></html>", { status: 200 }));
    await expect(aliexpressScraper.scrape(productUrl, {} as Env, ctx)).rejects.toMatchObject({ code: "BLOCKED" });
  });

  function browserEnv(quickAction: (action: string, options: unknown) => Promise<Response>): Env {
    return { BROWSER: { quickAction } } as unknown as Env;
  }

  function contentResponse(result: string, finalUrl?: string): Response {
    return new Response(
      JSON.stringify({ success: true, result, meta: { status: 200, title: "x", ...(finalUrl ? { finalUrl } : {}) } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  it("recovers a BLOCKED page by rendering it with the BROWSER binding", async () => {
    const quickAction = vi.fn(async (_action: string, _options: unknown) => contentResponse(productPageHtml()));
    stubFetch(() => new Response("<html><body>Captcha</body></html>", { status: 200 }));

    const result = await aliexpressScraper.scrape(productUrl, browserEnv(quickAction), ctx);

    expect(quickAction).toHaveBeenCalledTimes(1);
    expect(quickAction).toHaveBeenCalledWith("content", expect.objectContaining({ url: productUrl.href }));
    expect(result.title).toBe("Wireless Earbuds Pro");
  });

  it("reports BLOCKED when the browser render also returns a challenge page", async () => {
    const quickAction = vi.fn(async (_action: string, _options: unknown) =>
      contentResponse("<html><body>Captcha, verify you are human</body></html>"),
    );
    stubFetch(() => new Response("<html><body>Captcha</body></html>", { status: 200 }));

    await expect(aliexpressScraper.scrape(productUrl, browserEnv(quickAction), ctx)).rejects.toMatchObject({
      code: "BLOCKED",
    });
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
      return new Response(productPageHtml(), { status: 200 });
    });

    await aliexpressScraper.scrape(productUrl, cacheEnv, waitUntilCtx);
    await aliexpressScraper.scrape(productUrl, cacheEnv, waitUntilCtx);

    expect(fetches).toBe(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.get).toHaveBeenCalledTimes(2);
  });
});

describe("scraper registry", () => {
  it("resolves AliExpress URLs to the AliExpress scraper", () => {
    expect(findScraper(new URL(`https://www.aliexpress.com/item/${ITEM_ID}.html`))?.platform).toBe("aliexpress");
    expect(findScraper(new URL(`https://www.aliexpress.co.uk/item/${ITEM_ID}.html`))?.platform).toBe("aliexpress");
  });

  it("still resolves Amazon and TikTok URLs to their scrapers", () => {
    expect(findScraper(new URL("https://www.amazon.com/dp/B0B1234567"))?.platform).toBe("amazon");
    expect(findScraper(new URL("https://www.tiktok.com/@shop/product/123456789"))?.platform).toBe("tiktok-shop");
  });

  it("returns undefined for unsupported URLs", () => {
    expect(findScraper(new URL("https://www.youtube.com/watch?v=abc123"))).toBeUndefined();
    expect(findScraper(new URL("https://www.aliexpress.com/w/wholesale-earbuds.html"))).toBeUndefined();
  });

  it("extractRunParams and extractRdsBlocks expose the embedded JSON layers", () => {
    const html = productPageHtml();
    expect(extractRunParams(html)).toMatchObject({ data: { titleModule: { subject: "Wireless Earbuds Pro" } } });
    expect(extractRunParams("<html><body>no data here</body></html>")).toBeUndefined();
    expect(extractRdsBlocks(rdsInitScript(runParams()["data"]))).toHaveLength(1);
  });

  it("fetchAliExpressPage exposes a typed ResolvedPage for the integration layer", async () => {
    const productUrl = new URL(`https://www.aliexpress.com/item/${ITEM_ID}.html`);
    stubFetch(() => new Response(productPageHtml(), { status: 200 }));
    const page = await fetchAliExpressPage(productUrl);
    expect(page.url.href).toBe(productUrl.href);
    expect(page.html).toContain("window.runParams");
  });
});
