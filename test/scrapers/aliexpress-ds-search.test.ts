import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import {
  dsCountryCode,
  dsCurrencyForCountry,
  dsLocalForCountry,
  parseDsTextSearchPayload,
  searchAliExpressDsText,
} from "../../src/scrapers/aliexpress-ds-search";
import { persistAliExpressToken } from "../../src/scrapers/aliexpress-oauth";
import { DS_BUSINESS_ENDPOINT, dsHmacSign } from "../../src/scrapers/aliexpress-sign";
import { ScraperError } from "../../src/scrapers/types";

const APP_KEY = "test-app-key";
const APP_SECRET = "test-app-secret";
const ACCESS_TOKEN = "test-access-token";
const ITEM_A = "1005012410104961";
const ITEM_B = "1005012410104962";

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

function successBody(): string {
  return JSON.stringify({
    "aliexpress.ds.text.search_response": {
      result: {
        data: {
          total: 2,
          products: [
            { itemId: ITEM_A, title: "Earbuds A" },
            { itemId: ITEM_B, title: "Earbuds B" },
          ],
        },
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
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600_000,
    refreshExpiresAt: Date.now() + 86400_000,
  });
  return env;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dsCountryCode / currency / local", () => {
  it("defaults to US and maps GB", () => {
    expect(dsCountryCode()).toBe("US");
    expect(dsCountryCode("gb")).toBe("GB");
    expect(dsCountryCode("UK")).toBe("GB");
    expect(dsCurrencyForCountry("GB")).toBe("GBP");
    expect(dsLocalForCountry("US")).toBe("en_US");
  });
});

describe("parseDsTextSearchPayload", () => {
  it("extracts itemIds from data.products", () => {
    const parsed = parseDsTextSearchPayload(successBody());
    expect(parsed.products.map((p) => p.itemId)).toEqual([ITEM_A, ITEM_B]);
    expect(parsed.total).toBe(2);
  });

  it("extracts itemIds from official underscore envelope aliexpress_ds_text_search_response.data.products", () => {
    const parsed = parseDsTextSearchPayload(
      JSON.stringify({
        code: "0",
        aliexpress_ds_text_search_response: {
          data: {
            totalCount: 2,
            products: [
              { itemId: ITEM_A, title: "Earbuds A" },
              { itemId: ITEM_B, title: "Earbuds B" },
            ],
          },
        },
      }),
    );
    expect(parsed.products.map((p) => p.itemId)).toEqual([ITEM_A, ITEM_B]);
    expect(parsed.total).toBe(2);
  });

  it("maps IllegalAccessToken to PROVIDER_AUTH_ERROR", () => {
    try {
      parseDsTextSearchPayload(JSON.stringify({ error_response: { code: "IllegalAccessToken", msg: "expired" } }));
      throw new Error("expected PROVIDER_AUTH_ERROR");
    } catch (err) {
      expect((err as ScraperError).code).toBe("PROVIDER_AUTH_ERROR");
    }
  });

  it("throws PROVIDER_INVALID_RESPONSE on non-JSON", () => {
    try {
      parseDsTextSearchPayload("<html>");
      throw new Error("expected PROVIDER_INVALID_RESPONSE");
    } catch (err) {
      expect((err as ScraperError).code).toBe("PROVIDER_INVALID_RESPONSE");
    }
  });
});

describe("searchAliExpressDsText", () => {
  it("throws PROVIDER_CREDENTIALS_MISSING without secrets", async () => {
    try {
      await searchAliExpressDsText({} as Env, { keyWord: "earbuds" });
      throw new Error("expected PROVIDER_CREDENTIALS_MISSING");
    } catch (err) {
      expect((err as ScraperError).code).toBe("PROVIDER_CREDENTIALS_MISSING");
    }
  });

  it("posts HMAC-SHA256 signed search with required local/countryCode/currency", async () => {
    const env = await envWithToken();
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      expect(href).toBe(DS_BUSINESS_ENDPOINT);
      const params = new URLSearchParams(String(init?.body ?? ""));
      expect(params.get("method")).toBe("aliexpress.ds.text.search");
      expect(params.get("app_key")).toBe(APP_KEY);
      expect(params.get("access_token")).toBe(ACCESS_TOKEN);
      expect(params.get("local")).toBe("en_US");
      expect(params.get("countryCode")).toBe("US");
      expect(params.get("currency")).toBe("USD");
      expect(params.get("keyWord")).toBe("earbuds");
      expect(params.get("sign_method")).toBe("sha256");
      const unsigned = Object.fromEntries([...params.entries()].filter(([key]) => key !== "sign"));
      expect(params.get("sign")).toBe(await dsHmacSign(APP_SECRET, unsigned));
      return new Response(successBody(), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchStub);

    const result = await searchAliExpressDsText(env, { keyWord: "earbuds", countryCode: "US", pageSize: 20 });
    expect(result.products).toHaveLength(2);
    expect(result.products[0]?.itemId).toBe(ITEM_A);
  });
});
