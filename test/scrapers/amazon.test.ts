import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { amazonScraper, extractAsin, fetchAmazonPage, isAmazonHost } from "../../src/scrapers/amazon";
import {
  currencyForHost,
  extractAsinFromPathname,
  extractJsonLd,
  isAmazonProductPath,
  looksBlocked,
  parseAmazonPage,
} from "../../src/scrapers/amazon-parser";
import { findScraper } from "../../src/scrapers/registry";
import { ScraperError } from "../../src/scrapers/types";

const ctx = {} as ExecutionContext;

const ASIN = "B0B1234567";

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

function productLd(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Wireless Earbuds Pro",
    description: "High-fidelity wireless earbuds with active noise cancellation.",
    image: [
      "https://m.media-amazon.com/images/I/71abc.jpg",
      "https://m.media-amazon.com/images/I/71def.jpg",
    ],
    brand: { "@type": "Brand", name: "SoundCore" },
    aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", reviewCount: "1321" },
    offers: {
      "@type": "Offer",
      price: "49.99",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      seller: { "@type": "Organization", name: "Cool Store" },
    },
    ...overrides,
  };
}

function breadcrumbLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Electronics" },
      { "@type": "ListItem", position: 2, name: "Headphones" },
    ],
  };
}

function productPageHtml(options: { ld?: unknown[]; extra?: string; canonical?: string } = {}): string {
  const ld = options.ld ?? [productLd(), breadcrumbLd()];
  const canonical = options.canonical ?? `https://www.amazon.com/dp/${ASIN}`;
  const blocks = ld.map(ldScript).join("\n");
  return `<!doctype html><html><head>
    <link rel="canonical" href="${canonical}">
    ${blocks}
  </head><body>${options.extra ?? ""}</body></html>`;
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

describe("Amazon host and URL handling", () => {
  it("isAmazonHost accepts supported domains and subdomains", () => {
    expect(isAmazonHost("www.amazon.com")).toBe(true);
    expect(isAmazonHost("amazon.com")).toBe(true);
    expect(isAmazonHost("smile.amazon.com")).toBe(true);
    for (const domain of ["amazon.co.uk", "amazon.de", "amazon.fr", "amazon.it", "amazon.es", "amazon.ca", "amazon.sa"]) {
      expect(isAmazonHost(domain)).toBe(true);
      expect(isAmazonHost(`www.${domain}`)).toBe(true);
    }
  });

  it("isAmazonHost rejects unrelated and lookalike hosts", () => {
    for (const host of [
      "amazon.com.evil.com",
      "www.amazon.com.evil.com",
      "amazon.co.uk.evil.com",
      "evilamazon.com",
      "notamazon.com",
      "amazon.cab",
      "amazon.de.evil.de",
      "evil.com",
      "www.tiktok.com",
    ]) {
      expect(isAmazonHost(host)).toBe(false);
    }
  });

  it("extractAsinFromPathname handles product path prefixes, queries, and normalization", () => {
    expect(extractAsinFromPathname(`/dp/${ASIN}`)).toBe(ASIN);
    expect(extractAsinFromPathname(`/gp/product/${ASIN}`)).toBe(ASIN);
    expect(extractAsinFromPathname(`/gp/aw/d/${ASIN}`)).toBe(ASIN);
    expect(extractAsinFromPathname(`/exec/obidos/asin/${ASIN}`)).toBe(ASIN);
    expect(extractAsinFromPathname(`/dp/${ASIN}/ref=sr_1_1`)).toBe(ASIN);
    expect(extractAsinFromPathname(`/dp/${ASIN}/`)).toBe(ASIN);
    expect(extractAsinFromPathname(`/West-M200-Nano-Technology-Bluetooth-Energy-Efficient/dp/${ASIN}`)).toBe(ASIN);
    expect(extractAsinFromPathname(`/West-M200-Nano-Technology-Bluetooth-Energy-Efficient/dp/${ASIN}/ref=sr_1_1`)).toBe(ASIN);
    expect(extractAsinFromPathname("/dp/b0b1234567")).toBe("B0B1234567");
    expect(isAmazonProductPath(`/dp/${ASIN}`)).toBe(true);
    expect(isAmazonProductPath(`/gp/product/${ASIN}`)).toBe(true);
    expect(isAmazonProductPath(`/West-M200-Nano-Technology-Bluetooth-Energy-Efficient/dp/${ASIN}`)).toBe(true);
  });

  it("extractAsinFromPathname rejects invalid ASINs and non-product paths", () => {
    expect(extractAsinFromPathname("/dp/ABC")).toBeUndefined();
    expect(extractAsinFromPathname("/dp/B0B123456")).toBeUndefined();
    expect(extractAsinFromPathname("/dp/B0B123456789")).toBeUndefined();
    expect(extractAsinFromPathname("/b/?node=1")).toBeUndefined();
    expect(extractAsinFromPathname("/gp/help/customer/display.html")).toBeUndefined();
    expect(extractAsinFromPathname("/s?k=earbuds")).toBeUndefined();
    expect(extractAsinFromPathname("/")).toBeUndefined();
  });

  it("extractAsin reads the ASIN from full URLs", () => {
    expect(extractAsin(new URL(`https://www.amazon.com/dp/${ASIN}`))).toBe(ASIN);
    expect(extractAsin(new URL(`https://www.amazon.de/gp/product/${ASIN}`))).toBe(ASIN);
    expect(extractAsin(new URL(`https://www.amazon.com/dp/${ASIN}?tag=x-20&th=1`))).toBe(ASIN);
  });
});

describe("amazonScraper supports", () => {
  it("accepts product URLs on all supported domains and rejects everything else", () => {
    const cases: Array<[string, boolean]> = [
      [`https://www.amazon.com/dp/${ASIN}`, true],
      [`https://amazon.com/dp/${ASIN}`, true],
      [`https://www.amazon.com/gp/product/${ASIN}`, true],
      [`https://www.amazon.com/dp/${ASIN}?tag=x-20&th=1`, true],
      [`https://www.amazon.com/dp/${ASIN}/`, true],
      [`https://www.amazon.co.uk/dp/${ASIN}`, true],
      [`https://www.amazon.de/gp/product/${ASIN}`, true],
      [`https://www.amazon.fr/dp/${ASIN}`, true],
      [`https://www.amazon.it/dp/${ASIN}`, true],
      [`https://www.amazon.es/dp/${ASIN}`, true],
      [`https://www.amazon.ca/dp/${ASIN}`, true],
      [`https://www.amazon.sa/dp/${ASIN}`, true],
      [`https://www.amazon.sa/West-M200-Nano-Technology-Bluetooth-Energy-Efficient/dp/${ASIN}`, true],
      [`https://www.amazon.sa/West-M200-Nano-Technology-Bluetooth-Energy-Efficient/dp/${ASIN}?language=en_AE`, true],
      ["https://www.amazon.com/gp/product/XYZ", false],
      ["https://www.amazon.com/b/?node=1", false],
      ["https://www.amazon.com/gp/help/customer/display.html", false],
      ["https://www.amazon.com/s?k=earbuds", false],
      [`https://www.amazon.com.evil.com/dp/${ASIN}`, false],
      [`https://amazon.co.uk.evil.com/dp/${ASIN}`, false],
      ["https://www.evilamazon.com/dp/B0B1234567", false],
      ["https://www.aliexpress.com/item/1.html", false],
      ["https://www.tiktok.com/@shop/product/123", false],
    ];
    for (const [raw, expected] of cases) {
      expect(amazonScraper.supports(new URL(raw))).toBe(expected);
    }
  });
});

describe("parseAmazonPage (JSON-LD)", () => {
  it("maps a full product page into the normalize-ready shape", () => {
    const parsed = parseAmazonPage(productPageHtml(), { url: new URL(`https://www.amazon.com/dp/${ASIN}`) });

    expect(parsed.asin).toBe(ASIN);
    expect(parsed.title).toBe("Wireless Earbuds Pro");
    expect(parsed.description).toBe("High-fidelity wireless earbuds with active noise cancellation.");
    expect(parsed.price).toEqual({ amount: 49.99, currency: "USD" });
    expect(parsed.images).toEqual([
      { url: "https://m.media-amazon.com/images/I/71abc.jpg" },
      { url: "https://m.media-amazon.com/images/I/71def.jpg" },
    ]);
    expect(parsed.category).toEqual({ name: "Headphones", path: ["Electronics", "Headphones"] });
    expect(parsed.rating).toEqual({ average: 4.6, count: 1321 });
    expect(parsed.availability).toBe(true);
    expect(parsed.seller).toBe("Cool Store");
    expect(parsed.brand).toBe("SoundCore");
    expect(parsed.attributes).toEqual({ seller: "Cool Store", brand: "SoundCore" });
    expect(parsed.raw.name).toBe("Wireless Earbuds Pro");
    expect(parsed.raw.asin).toBe(ASIN);
  });

  it("derives the ASIN from the canonical link when no hint is given", () => {
    const parsed = parseAmazonPage(productPageHtml());
    expect(parsed.asin).toBe(ASIN);
  });

  it("falls back to the hint ASIN when the page has no canonical link", () => {
    const parsed = parseAmazonPage(productPageHtml({ canonical: "https://www.amazon.com/gp/help/customer/display.html" }), {
      asin: ASIN,
    });
    expect(parsed.asin).toBe(ASIN);
  });

  it("handles AggregateOffer low/high price with a list-price originalAmount", () => {
    const html = productPageHtml({
      ld: [
        productLd({
          name: "Blender X",
          offers: { "@type": "AggregateOffer", lowPrice: "89.99", highPrice: "129.99", priceCurrency: "USD", offerCount: "3" },
        }),
        breadcrumbLd(),
      ],
      extra: `<span class="a-text-price"><span class="a-offscreen">$129.99</span></span>`,
    });
    const parsed = parseAmazonPage(html);
    expect(parsed.price).toEqual({ amount: 89.99, currency: "USD", originalAmount: 129.99 });
  });

  it("is deterministic for the same fixture", () => {
    const html = productPageHtml();
    expect(parseAmazonPage(html)).toEqual(parseAmazonPage(html));
  });

  it("parses multiple JSON-LD blocks and skips malformed ones", () => {
    const html = `<html><head>
      <link rel="canonical" href="https://www.amazon.com/dp/${ASIN}">
      <script type="application/ld+json">${"{"}</script>
      ${ldScript(productLd())}
    </head><body></body></html>`;
    expect(extractJsonLd(html)).toHaveLength(1);
    expect(parseAmazonPage(html).title).toBe("Wireless Earbuds Pro");
  });
});

describe("parseAmazonPage (fallbacks)", () => {
  const fallbackHtml = (): string =>
    `<!doctype html><html><head>
      <link rel="canonical" href="https://www.amazon.co.uk/dp/${ASIN}">
      <title>x</title>
    </head><body>
      <span id="productTitle">Wireless Earbuds Pro UK</span>
      <span id="priceblock_ourprice">GBP 39.99</span>
      <div id="wayfinding-breadcrumbs_feature_div">
        <a href="/Electronics/b">Electronics</a> &gt;
        <a href="/Headphones/b">Headphones</a>
      </div>
      <span id="acrPopover" title="4.3 out of 5 stars"></span>
      <span id="acrCustomerReviewText">2,345 ratings</span>
      <img id="landingImage" src="https://m.media-amazon.com/images/I/71abc.jpg" data-old-hires="https://m.media-amazon.com/images/I/71abc-hires.jpg">
      <img class="a-dynamic-image" src="https://m.media-amazon.com/images/I/71def.jpg">
      <div id="outOfStock"></div>
      <span id="bylineInfo">Visit the Cool Store store</span>
    </body></html>`;

  it("parses without any JSON-LD using stable HTML selectors", () => {
    const parsed = parseAmazonPage(fallbackHtml());

    expect(parsed.asin).toBe(ASIN);
    expect(parsed.title).toBe("Wireless Earbuds Pro UK");
    expect(parsed.price).toEqual({ amount: 39.99, currency: "GBP" });
    expect(parsed.images).toEqual([
      { url: "https://m.media-amazon.com/images/I/71abc.jpg" },
      { url: "https://m.media-amazon.com/images/I/71def.jpg" },
    ]);
    expect(parsed.category).toEqual({ name: "Headphones", path: ["Electronics", "Headphones"] });
    expect(parsed.rating).toEqual({ average: 4.3, count: 2345 });
    expect(parsed.availability).toBe(false);
    expect(parsed.seller).toBe("Visit the Cool Store store");
    expect(parsed.attributes).toMatchObject({ seller: "Visit the Cool Store store" });
  });

  it("leaves missing optional fields undefined instead of fabricating them", () => {
    const html = productPageHtml({
      ld: [{ "@context": "https://schema.org", "@type": "Product", name: "Bare Product", offers: { "@type": "Offer", price: "5", priceCurrency: "USD" } }],
    });
    const parsed = parseAmazonPage(html);
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

  it("falls back to page selectors when JSON-LD is malformed", () => {
    const html = `<html><head>
      <link rel="canonical" href="https://www.amazon.com/dp/${ASIN}">
      <script type="application/ld+json">not json</script>
    </head><body>
      <span id="productTitle">Malformed LD Product</span>
      <span id="priceblock_ourprice">$19.99</span>
    </body></html>`;
    const parsed = parseAmazonPage(html);
    expect(parsed.title).toBe("Malformed LD Product");
    expect(parsed.price).toEqual({ amount: 19.99, currency: "USD" });
  });

  it("derives the currency from the host when JSON-LD has none", () => {
    for (const [hostname, currency] of [
      ["www.amazon.com", "USD"],
      ["www.amazon.co.uk", "GBP"],
      ["www.amazon.de", "EUR"],
      ["www.amazon.fr", "EUR"],
      ["www.amazon.it", "EUR"],
      ["www.amazon.es", "EUR"],
      ["www.amazon.ca", "CAD"],
      ["www.amazon.sa", "SAR"],
    ] as const) {
      expect(currencyForHost(hostname)).toBe(currency);
    }
    expect(currencyForHost("evil.com")).toBeUndefined();
    expect(currencyForHost(undefined)).toBeUndefined();
  });
});

describe("parseAmazonPage (Amazon.sa)", () => {
  const SA_URL = `https://www.amazon.sa/West-M200-Nano-Technology-Bluetooth-Energy-Efficient/dp/${ASIN}`;

  it("parses a slug-prefixed /dp/<ASIN> page and derives the ASIN from the canonical path", () => {
    const html = productPageHtml({
      canonical: SA_URL,
      ld: [
        {
          "@context": "https://schema.org",
          "@type": "Product",
          name: "West M200 Nano Technology Bluetooth Energy Efficient",
          offers: {
            "@type": "Offer",
            price: "129.00",
            priceCurrency: "SAR",
            availability: "https://schema.org/InStock",
          },
        },
      ],
    });
    const parsed = parseAmazonPage(html, { url: new URL(SA_URL) });

    expect(parsed.asin).toBe(ASIN);
    expect(parsed.title).toBe("West M200 Nano Technology Bluetooth Energy Efficient");
    expect(parsed.price).toEqual({ amount: 129, currency: "SAR" });
    expect(parsed.availability).toBe(true);
  });

  it("falls back to SAR from the amazon.sa host when JSON-LD has no currency", () => {
    const html = productPageHtml({
      canonical: SA_URL,
      ld: [{ "@type": "Product", name: "SAR Fallback Product", offers: { "@type": "Offer", price: "89.50" } }],
    });
    const parsed = parseAmazonPage(html);
    expect(parsed.asin).toBe(ASIN);
    expect(parsed.price).toEqual({ amount: 89.5, currency: "SAR" });
  });
});

describe("parseAmazonPage error handling", () => {
  it("throws NO_PRODUCT_DATA when no product data is present", () => {
    expectScraperErrorCode(() => parseAmazonPage("<html><body>nothing here</body></html>"), "NO_PRODUCT_DATA");
  });

  it("throws NO_PRODUCT_DATA when the title is missing", () => {
    const html = productPageHtml({
      ld: [{ "@type": "Product", offers: { "@type": "Offer", price: "10", priceCurrency: "USD" } }],
    });
    expectScraperErrorCode(() => parseAmazonPage(html), "NO_PRODUCT_DATA");
  });

  it("throws NO_PRODUCT_DATA when the price is missing", () => {
    const html = productPageHtml({
      ld: [{ "@type": "Product", name: "No Price Product", offers: {} }],
    });
    expectScraperErrorCode(() => parseAmazonPage(html), "NO_PRODUCT_DATA");
  });

  it("throws BLOCKED for a robot/captcha check page", () => {
    expectScraperErrorCode(
      () => parseAmazonPage("<html><body>To discuss automated access to Amazon data please contact api-services-support</body></html>"),
      "BLOCKED",
    );
  });

  it("looksBlocked detects challenge markers", () => {
    expect(looksBlocked("<html>Robot Check, enter the characters you see below</html>")).toBe(true);
    expect(looksBlocked("<html>a normal page</html>")).toBe(false);
  });
});

describe("amazonScraper scrape", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const productUrl = new URL(`https://www.amazon.com/dp/${ASIN}`);

  it("fetches the page and returns a normalized ScraperResult", async () => {
    stubFetch(() => new Response(productPageHtml(), { status: 200 }));
    const result = await amazonScraper.scrape(productUrl, {} as Env, ctx);

    expect(result.platform).toBe("amazon");
    expect(result.url).toBe(productUrl.href);
    expect(result.title).toBe("Wireless Earbuds Pro");
    expect(result.scrapedAt).toBeTruthy();
    expect(result.data).toMatchObject({
      externalId: ASIN,
      title: "Wireless Earbuds Pro",
      price: { amount: 49.99, currency: "USD" },
      source: "amazon",
      attributes: { seller: "Cool Store", brand: "SoundCore" },
    });
  });

  it("follows redirects to the final product page", async () => {
    let hops = 0;
    stubFetch((url) => {
      hops++;
      if (url.pathname === "/dp/" + ASIN.toLowerCase()) {
        return new Response(null, { status: 301, headers: { location: `https://www.amazon.com/dp/${ASIN}` } });
      }
      return new Response(productPageHtml(), { status: 200 });
    });
    const result = await amazonScraper.scrape(new URL(`https://www.amazon.com/dp/${ASIN.toLowerCase()}`), {} as Env, ctx);
    expect(hops).toBe(2);
    expect(result.url).toBe(productUrl.href);
  });

  it("sends a realistic user agent", async () => {
    let sentHeaders: Headers | undefined;
    stubFetch((_url, init) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(productPageHtml(), { status: 200 });
    });
    await amazonScraper.scrape(productUrl, {} as Env, ctx);
    expect(sentHeaders?.get("user-agent")).toContain("Chrome");
  });

  it("throws REDIRECT_UNTRUSTED when a redirect leaves amazon", async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }));
    await expect(amazonScraper.scrape(productUrl, {} as Env, ctx)).rejects.toMatchObject({ code: "REDIRECT_UNTRUSTED" });
  });

  it("throws HTTP_ERROR on a non-2xx response", async () => {
    stubFetch(() => new Response("forbidden", { status: 403 }));
    await expect(amazonScraper.scrape(productUrl, {} as Env, ctx)).rejects.toMatchObject({ code: "HTTP_ERROR" });
  });

  it("throws NO_PRODUCT_DATA when the page has no product data", async () => {
    stubFetch(() => new Response("<html><body>nothing</body></html>", { status: 200 }));
    await expect(amazonScraper.scrape(productUrl, {} as Env, ctx)).rejects.toMatchObject({ code: "NO_PRODUCT_DATA" });
  });

  it("throws BLOCKED on a robot check page", async () => {
    stubFetch(() => new Response("<html><body>Robot Check - please verify you are human</body></html>", { status: 200 }));
    await expect(amazonScraper.scrape(productUrl, {} as Env, ctx)).rejects.toMatchObject({ code: "BLOCKED" });
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
    stubFetch(() => new Response("<html><body>Robot Check</body></html>", { status: 200 }));

    const result = await amazonScraper.scrape(productUrl, browserEnv(quickAction), ctx);

    expect(quickAction).toHaveBeenCalledTimes(1);
    expect(quickAction).toHaveBeenCalledWith("content", expect.objectContaining({ url: productUrl.href }));
    expect(result.title).toBe("Wireless Earbuds Pro");
  });

  it("reports BLOCKED when the browser render also returns a challenge page", async () => {
    const quickAction = vi.fn(async (_action: string, _options: unknown) =>
      contentResponse("<html><body>Robot Check, verify you are human</body></html>"),
    );
    stubFetch(() => new Response("<html><body>Robot Check</body></html>", { status: 200 }));

    await expect(amazonScraper.scrape(productUrl, browserEnv(quickAction), ctx)).rejects.toMatchObject({ code: "BLOCKED" });
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

    await amazonScraper.scrape(productUrl, cacheEnv, waitUntilCtx);
    await amazonScraper.scrape(productUrl, cacheEnv, waitUntilCtx);

    expect(fetches).toBe(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.get).toHaveBeenCalledTimes(2);
  });
});

describe("scraper registry", () => {
  it("resolves Amazon URLs to the Amazon scraper", () => {
    expect(findScraper(new URL(`https://www.amazon.com/dp/${ASIN}`))?.platform).toBe("amazon");
    expect(findScraper(new URL("https://www.amazon.de/gp/product/B0B1234567"))?.platform).toBe("amazon");
  });

  it("still resolves TikTok URLs to the TikTok scraper", () => {
    expect(findScraper(new URL("https://www.tiktok.com/@shop/product/123456789"))?.platform).toBe("tiktok-shop");
  });

  it("returns undefined for unsupported URLs", () => {
    expect(findScraper(new URL("https://www.youtube.com/watch?v=abc123"))).toBeUndefined();
    expect(findScraper(new URL("https://www.amazon.com/b/?node=1"))).toBeUndefined();
  });

  it("fetchAmazonPage exposes a typed ResolvedPage for the integration layer", async () => {
    const productUrl = new URL(`https://www.amazon.com/dp/${ASIN}`);
    stubFetch(() => new Response(productPageHtml(), { status: 200 }));
    const page = await fetchAmazonPage(productUrl);
    expect(page.url.href).toBe(productUrl.href);
    expect(page.html).toContain("application/ld+json");
  });
});
