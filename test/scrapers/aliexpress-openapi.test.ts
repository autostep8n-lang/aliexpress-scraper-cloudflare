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
