import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAliExpressProductOpenApi,
  hasOpenApiCredentials,
  openApiSign,
  openApiTimestamp,
  parseOpenApiPayload,
} from "../../src/scrapers/aliexpress-openapi";
import { persistAliExpressToken } from "../../src/scrapers/aliexpress-oauth";
import { DS_BUSINESS_ENDPOINT, dsHmacSign } from "../../src/scrapers/aliexpress-sign";
import { ScraperError } from "../../src/scrapers/types";
import { md5 } from "../../src/utils/md5";
import type { Env } from "../../src/env";

const APP_KEY = "test-app-key";
const APP_SECRET = "test-app-secret";
const ITEM_ID = "1005012410104961";
const ACCESS_TOKEN = "test-access-token";

class MemoryKV {
  private readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const envWithoutCreds = {} as unknown as Env;

const HINT = { url: new URL(`https://www.aliexpress.com/item/${ITEM_ID}.html`), itemId: ITEM_ID };

function successBody(): string {
  return JSON.stringify({
    "aliexpress.ds.product.get_response": {
      result: {
        productDetailModel: {
          productId: ITEM_ID,
          subject: "Portable Hair Straightener Comb 2600mAh",
          productPrice: 3.43,
          originalPrice: 7.46,
          currencyCode: "USD",
          imageUrls: [
            "https://ae-pic-a1.aliexpress-media.com/kf/S9e0501832f6b49698d4502e004a3a390a.jpeg",
            "https://ae-pic-a1.aliexpress-media.com/kf/S53722e550ca34479917a9e512f49ca0eE.jpg",
          ],
          properties: {
            productProps: [
              { name: "Brand", value: "SoundCore" },
              { name: "Material", value: "ABS" },
            ],
          },
          storeInfo: { storeName: "Shop1103920178 Store" },
          evarating: { evarating: 4.5, feedbackNum: 4 },
        },
      },
    },
  });
}

function errorBody(code: string, msg: string): string {
  return JSON.stringify({ error_response: { code, msg } });
}

function dsSuccessBody(overrides: {
  subject?: string;
  productId?: string;
  baseCurrency?: string;
  skus?: Array<Record<string, unknown>>;
  imageUrls?: unknown;
  properties?: unknown;
  storeName?: string;
  ratingAverage?: unknown;
  ratingCount?: unknown;
} = {}): string {
  const skuList =
    overrides.skus ??
    [
      {
        sku_price: "9.99",
        offer_sale_price: "8.50",
        currency_code: "USD",
        sku_available_stock: 12,
        sku_id: "111",
        id: "111",
        sku_attr: "14:350850",
        ae_sku_property_dtos: {},
      },
    ];
  return JSON.stringify({
    aliexpress_ds_product_get_response: {
      result: {
        ae_item_base_info_dto: {
          product_id: overrides.productId ?? ITEM_ID,
          subject: overrides.subject ?? "Wireless Earbuds Test Title",
          currency_code: overrides.baseCurrency ?? "EUR",
          avg_evaluation_rating: overrides.ratingAverage ?? "4.6",
          evaluation_count: overrides.ratingCount ?? "18",
        },
        ae_item_sku_info_dtos: {
          ae_item_sku_info_d_t_o: skuList,
        },
        ae_multimedia_info_dto: {
          image_urls:
            overrides.imageUrls ?? [
              "https://example.test/a.jpg",
              "https://example.test/b.jpg",
            ],
        },
        ae_store_info: {
          store_name: overrides.storeName ?? "Example Store",
        },
        ae_item_properties: {
          ae_item_property:
            overrides.properties ?? [
              { attr_name: "Brand", attr_value: "SoundCore" },
              { attr_name: "Material", attr_value: "ABS" },
            ],
        },
        package_info_dto: {},
        logistics_info_dto: {},
        product_id_converter_result: {},
        has_whole_sale: false,
      },
    },
  });
}

async function envWithToken(): Promise<Env> {
  const kv = new MemoryKV();
  const env = {
    ALIEXPRESS_OPENAPI_KEY: APP_KEY,
    ALIEXPRESS_OPENAPI_SECRET: APP_SECRET,
    SCRAPE_CACHE: kv as unknown as KVNamespace,
  } as unknown as Env;
  await persistAliExpressToken(env, {
    accessToken: ACCESS_TOKEN,
    refreshToken: "test-refresh-token",
    expiresAt: Date.now() + 3600_000,
    refreshExpiresAt: Date.now() + 86400_000,
  });
  return env;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openApiSign", () => {
  it("sorts all params except sign and MD5s secret + keyvalue pairs", () => {
    const params: Record<string, string> = {
      method: "aliexpress.ds.product.get",
      app_key: APP_KEY,
      timestamp: "2026-08-25 00:00:00",
      format: "json",
      v: "1.0",
      sign_method: "md5",
      product_id: ITEM_ID,
    };
    const sorted = Object.keys(params)
      .sort()
      .map((key) => `${key}${params[key]}`)
      .join("");
    expect(openApiSign(APP_SECRET, params)).toBe(md5(APP_SECRET + sorted));
  });

  it("excludes a pre-existing sign key from the signed string", () => {
    const params = { a: "1", sign: "should-not-matter", b: "2" };
    expect(openApiSign("s", params)).toBe(md5("s" + "a1" + "b2"));
  });
});

describe("openApiTimestamp", () => {
  it("formats UTC+8 time as yyyy-MM-dd HH:mm:ss", () => {
    const date = new Date("2026-08-25T00:00:00.000Z");
    expect(openApiTimestamp(date)).toBe("2026-08-25 08:00:00");
  });

  it("rolls the date across midnight correctly", () => {
    const date = new Date("2026-08-25T17:00:00.000Z");
    expect(openApiTimestamp(date)).toBe("2026-08-26 01:00:00");
  });
});

describe("hasOpenApiCredentials", () => {
  it("is false when secrets are not configured", () => {
    expect(hasOpenApiCredentials(envWithoutCreds)).toBe(false);
  });

  it("is true when both secrets are configured", () => {
    expect(
      hasOpenApiCredentials({
        ALIEXPRESS_OPENAPI_KEY: APP_KEY,
        ALIEXPRESS_OPENAPI_SECRET: APP_SECRET,
      } as unknown as Env),
    ).toBe(true);
  });
});

describe("parseOpenApiPayload", () => {
  it("maps a success response into the normalize-ready shape", () => {
    const parsed = parseOpenApiPayload(successBody(), HINT);
    expect(parsed.itemId).toBe(ITEM_ID);
    expect(parsed.title).toBe("Portable Hair Straightener Comb 2600mAh");
    expect(parsed.price).toEqual({ amount: 3.43, currency: "USD", originalAmount: 7.46 });
    expect(parsed.images).toHaveLength(2);
    expect(parsed.seller).toBe("Shop1103920178 Store");
    expect(parsed.brand).toBe("SoundCore");
    expect(parsed.attributes["Material"]).toBe("ABS");
    expect(parsed.rating).toEqual({ average: 4.5, count: 4 });
  });

  it("maps auth-style errors to PROVIDER_AUTH_ERROR", () => {
    try {
      parseOpenApiPayload(errorBody("400", "Invalid signature"), HINT);
      throw new Error("expected PROVIDER_AUTH_ERROR");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("PROVIDER_AUTH_ERROR");
    }
  });

  it("maps IllegalAccessToken to PROVIDER_AUTH_ERROR", () => {
    try {
      parseOpenApiPayload(errorBody("IllegalAccessToken", "The specified access token is invalid or expired"), HINT);
      throw new Error("expected PROVIDER_AUTH_ERROR");
    } catch (err) {
      expect((err as ScraperError).code).toBe("PROVIDER_AUTH_ERROR");
    }
  });

  it("maps rate-limit style errors to PROVIDER_QUOTA_ERROR", () => {
    try {
      parseOpenApiPayload(errorBody("400", "API frequency limit exceeded"), HINT);
      throw new Error("expected PROVIDER_QUOTA_ERROR");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("PROVIDER_QUOTA_ERROR");
    }
  });

  it("maps other errors to PROVIDER_API_ERROR", () => {
    try {
      parseOpenApiPayload(errorBody("400", "Invalid parameter"), HINT);
      throw new Error("expected PROVIDER_API_ERROR");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("PROVIDER_API_ERROR");
    }
  });

  it("throws NO_PRODUCT_DATA when the payload has no product detail model", () => {
    const body = JSON.stringify({ "aliexpress.ds.product.get_response": { result: {} } });
    try {
      parseOpenApiPayload(body, HINT);
      throw new Error("expected NO_PRODUCT_DATA");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("NO_PRODUCT_DATA");
    }
  });

  it("throws PROVIDER_INVALID_RESPONSE on non-JSON", () => {
    try {
      parseOpenApiPayload("<html>502</html>", HINT);
      throw new Error("expected PROVIDER_INVALID_RESPONSE");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("PROVIDER_INVALID_RESPONSE");
    }
  });

  it("maps the underscore DS envelope into the normalize-ready shape", () => {
    const parsed = parseOpenApiPayload(dsSuccessBody(), HINT);
    expect(parsed.itemId).toBe(ITEM_ID);
    expect(parsed.title).toBe("Wireless Earbuds Test Title");
    expect(parsed.price).toEqual({ amount: 8.5, currency: "USD", originalAmount: 9.99 });
    expect(parsed.images).toEqual([{ url: "https://example.test/a.jpg" }, { url: "https://example.test/b.jpg" }]);
    expect(parsed.seller).toBe("Example Store");
    expect(parsed.brand).toBe("SoundCore");
    expect(parsed.attributes["Material"]).toBe("ABS");
    expect(parsed.rating).toEqual({ average: 4.6, count: 18 });
  });

  it("prefers SKU offer_sale_price and falls back to sku_price", () => {
    const preferred = parseOpenApiPayload(dsSuccessBody(), HINT);
    expect(preferred.price.amount).toBe(8.5);
    const fallback = parseOpenApiPayload(
      dsSuccessBody({
        skus: [{ sku_price: "9.99", currency_code: "USD" }],
      }),
      HINT,
    );
    expect(fallback.price).toEqual({ amount: 9.99, currency: "USD" });
  });

  it("uses the first SKU with a parseable sale price", () => {
    const parsed = parseOpenApiPayload(
      dsSuccessBody({
        skus: [
          { offer_sale_price: "", sku_price: "", currency_code: "USD" },
          { offer_sale_price: "3.21", currency_code: "USD" },
        ],
      }),
      HINT,
    );
    expect(parsed.price.amount).toBe(3.21);
  });

  it("falls back to base_info currency_code when SKU currency is missing", () => {
    const parsed = parseOpenApiPayload(
      dsSuccessBody({
        baseCurrency: "EUR",
        skus: [{ offer_sale_price: "8.50" }],
      }),
      HINT,
    );
    expect(parsed.price.currency).toBe("EUR");
  });

  it("splits semicolon-separated image_urls", () => {
    const parsed = parseOpenApiPayload(
      dsSuccessBody({ imageUrls: "https://example.test/a.jpg;https://example.test/b.jpg" }),
      HINT,
    );
    expect(parsed.images).toEqual([{ url: "https://example.test/a.jpg" }, { url: "https://example.test/b.jpg" }]);
  });

  it("maps a single ae_item_property object using name/value fallbacks", () => {
    const parsed = parseOpenApiPayload(
      dsSuccessBody({ properties: { name: "Color", value: "Black" } }),
      HINT,
    );
    expect(parsed.attributes["Color"]).toBe("Black");
  });

  it("keeps dotted productDetailModel mapping unchanged", () => {
    const parsed = parseOpenApiPayload(successBody(), HINT);
    expect(parsed.title).toBe("Portable Hair Straightener Comb 2600mAh");
    expect(parsed.price).toEqual({ amount: 3.43, currency: "USD", originalAmount: 7.46 });
    expect(parsed.seller).toBe("Shop1103920178 Store");
  });

  it("throws NO_PRODUCT_DATA when DS subject is missing", () => {
    try {
      parseOpenApiPayload(dsSuccessBody({ subject: "" }), HINT);
      throw new Error("expected NO_PRODUCT_DATA");
    } catch (err) {
      expect((err as ScraperError).code).toBe("NO_PRODUCT_DATA");
      expect((err as ScraperError).message).toBe("AliExpress Open Platform response is missing a product title");
    }
  });

  it("throws NO_PRODUCT_DATA when no SKU has a parseable price", () => {
    try {
      parseOpenApiPayload(dsSuccessBody({ skus: [{ offer_sale_price: "", sku_price: "" }] }), HINT);
      throw new Error("expected NO_PRODUCT_DATA");
    } catch (err) {
      expect((err as ScraperError).code).toBe("NO_PRODUCT_DATA");
      expect((err as ScraperError).message).toBe("AliExpress Open Platform response is missing a price");
    }
  });
});

describe("fetchAliExpressProductOpenApi", () => {
  it("throws PROVIDER_CREDENTIALS_MISSING when secrets are absent", async () => {
    try {
      await fetchAliExpressProductOpenApi(envWithoutCreds, ITEM_ID, HINT.url);
      throw new Error("expected PROVIDER_CREDENTIALS_MISSING");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("PROVIDER_CREDENTIALS_MISSING");
    }
  });

  it("posts a HMAC-SHA256 signed form body with access_token and ship_to_country", async () => {
    const env = await envWithToken();
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      expect(href).toBe(DS_BUSINESS_ENDPOINT);
      const body = init?.body?.toString() ?? "";
      const params = new URLSearchParams(body);
      expect(params.get("method")).toBe("aliexpress.ds.product.get");
      expect(params.get("app_key")).toBe(APP_KEY);
      expect(params.get("product_id")).toBe(ITEM_ID);
      expect(params.get("ship_to_country")).toBe("US");
      expect(params.get("access_token")).toBe(ACCESS_TOKEN);
      expect(params.get("format")).toBe("json");
      expect(params.get("sign_method")).toBe("sha256");
      const sign = params.get("sign") ?? "";
      expect(sign).toMatch(/^[0-9A-F]{64}$/);
      const unsigned = Object.fromEntries([...params.entries()].filter(([key]) => key !== "sign"));
      expect(sign).toBe(await dsHmacSign(APP_SECRET, unsigned));
      expect(sign).not.toBe(openApiSign(APP_SECRET, unsigned));
      return new Response(successBody(), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchStub);

    const parsed = await fetchAliExpressProductOpenApi(env, ITEM_ID, HINT.url);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(parsed.itemId).toBe(ITEM_ID);
    expect(parsed.title).toBe("Portable Hair Straightener Comb 2600mAh");
  });

  it("surfaces a typed PROVIDER_NETWORK_ERROR when unreachable", async () => {
    const env = await envWithToken();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    try {
      await fetchAliExpressProductOpenApi(env, ITEM_ID, HINT.url);
      throw new Error("expected PROVIDER_NETWORK_ERROR");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("PROVIDER_NETWORK_ERROR");
    }
  });

  it("surfaces a typed PROVIDER_HTTP_ERROR on non-2xx", async () => {
    const env = await envWithToken();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error", { status: 502 })));
    try {
      await fetchAliExpressProductOpenApi(env, ITEM_ID, HINT.url);
      throw new Error("expected PROVIDER_HTTP_ERROR");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("PROVIDER_HTTP_ERROR");
    }
  });
});
