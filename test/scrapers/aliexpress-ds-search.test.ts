import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import {
  dsCountryCode,
  dsCurrencyForCountry,
  dsLocalForCountry,
  dsSearchResponseDiagnostics,
  dsTextSearchEnvelopeDiagnostic,
  dsTextSearchUnderscoreResponseDiagnostic,
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

  it("falls back to aliexpress_ds_text_search_response when the dotted key is absent", () => {
    const parsed = parseDsTextSearchPayload(
      JSON.stringify({
        aliexpress_ds_text_search_response: {
          data: {
            total: 2,
            products: [
              { itemId: ITEM_A, title: "Earbuds A" },
              { product_id: ITEM_B, title: "Earbuds B" },
            ],
          },
        },
      }),
    );
    expect(parsed.products.map((p) => p.itemId)).toEqual([ITEM_A, ITEM_B]);
    expect(parsed.total).toBe(2);
  });

  it("prefers the dotted response when both envelopes are present", () => {
    const parsed = parseDsTextSearchPayload(
      JSON.stringify({
        "aliexpress.ds.text.search_response": {
          result: { data: { products: [{ itemId: ITEM_A }] } },
        },
        aliexpress_ds_text_search_response: {
          data: { products: [{ itemId: ITEM_B }] },
        },
      }),
    );
    expect(parsed.products.map((p) => p.itemId)).toEqual([ITEM_A]);
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

  it("logs underscore-response keys/types without leaking credentials or changing parse results", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const sign = "deadbeefsign";
    const payload = {
      access_token: ACCESS_TOKEN,
      app_key: APP_KEY,
      sign,
      aliexpress_ds_text_search_response: {
        code: "0",
        data: {
          totalCount: 1,
          items: { page: 1 },
          products: [{ product_id: ITEM_A, title: "Secret title", access_token: ACCESS_TOKEN }],
        },
        result: { pageSize: 20 },
      },
    };
    try {
      const parsed = parseDsTextSearchPayload(JSON.stringify(payload));
      expect(parsed.products.map((p) => p.itemId)).toEqual([ITEM_A]);
      const serialized = logs.join("\n");
      expect(serialized).toContain("aliexpress.ds.text.search.response");
      expect(serialized).toContain("aliexpress.ds.text.search.underscore_response");
      expect(serialized).toContain("hasUnderscoreResponse");
      expect(serialized).not.toContain(ACCESS_TOKEN);
      expect(serialized).not.toContain(APP_KEY);
      expect(serialized).not.toContain(APP_SECRET);
      expect(serialized).not.toContain(sign);
      expect(serialized).not.toContain("Secret title");
      expect(serialized).not.toContain(ITEM_A);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("dsTextSearchUnderscoreResponseDiagnostic", () => {
  it("reports keys, products type/length, and nested container keys without values", () => {
    const diagnostic = dsTextSearchUnderscoreResponseDiagnostic({
      access_token: ACCESS_TOKEN,
      aliexpress_ds_text_search_response: {
        data: {
          total: 2,
          products: [
            { itemId: ITEM_A, title: "Earbuds A", access_token: ACCESS_TOKEN },
            { itemId: ITEM_B, title: "Earbuds B" },
          ],
        },
        result: { cursor: "next" },
        items: { group: "hot" },
      },
    });
    const serialized = JSON.stringify(diagnostic);
    expect(diagnostic).toMatchObject({
      present: true,
      keys: expect.arrayContaining(["data", "result", "items"]),
      dataKeys: expect.arrayContaining(["total", "products"]),
      resultKeys: ["cursor"],
      productsType: "array",
      productsLength: 2,
      firstProductKeys: expect.arrayContaining(["itemId", "title"]),
      nestedContainerKeys: {
        result: ["cursor"],
        items: ["group"],
      },
    });
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(APP_KEY);
    expect(serialized).not.toContain(APP_SECRET);
    expect(serialized).not.toContain(ITEM_A);
    expect(serialized).not.toContain("Earbuds A");
  });

  it("reports present false without the underscore envelope", () => {
    const diagnostic = dsTextSearchUnderscoreResponseDiagnostic({
      "aliexpress.ds.text.search_response": { result: { data: { products: [] } } },
    });
    expect(diagnostic).toEqual({ present: false });
  });

  it("envelope diagnostic reports flags without credential values", () => {
    const diagnostic = dsTextSearchEnvelopeDiagnostic({
      access_token: ACCESS_TOKEN,
      app_key: APP_KEY,
      sign: "abc",
      aliexpress_ds_text_search_response: { data: {} },
    });
    const serialized = JSON.stringify(diagnostic);
    expect(diagnostic).toMatchObject({
      hasDottedResponse: false,
      hasUnderscoreResponse: true,
      hasErrorResponse: false,
    });
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(APP_KEY);
    expect(serialized).not.toContain("abc");
  });
});

describe("dsSearchResponseDiagnostics", () => {
  it("reports official underscore envelope keys without leaking secrets", () => {
    const body = JSON.stringify({
      code: "0",
      aliexpress_ds_text_search_response: { data: { products: [] } },
      access_token: ACCESS_TOKEN,
    });
    const fields = dsSearchResponseDiagnostics(200, body);
    expect(fields.httpStatus).toBe(200);
    expect(fields.bodyLength).toBe(body.length);
    expect(fields.topLevelKeys).toEqual(["code", "aliexpress_ds_text_search_response", "access_token"]);
    expect(fields.hasUnderscoreResponse).toBe(true);
    expect(fields.hasDottedResponse).toBe(false);
    expect(fields.hasErrorResponse).toBe(false);
    expect(fields.providerCode).toBe("0");
    expect(JSON.stringify(fields)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(fields)).not.toContain(APP_SECRET);
  });

  it("reports error_response code and msg only", () => {
    const fields = dsSearchResponseDiagnostics(
      200,
      JSON.stringify({ error_response: { code: "IllegalTimestamp", msg: "timestamp invalid" } }),
    );
    expect(fields.hasErrorResponse).toBe(true);
    expect(fields.providerCode).toBe("IllegalTimestamp");
    expect(fields.providerMsg).toBe("timestamp invalid");
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
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });

    const result = await searchAliExpressDsText(env, { keyWord: "earbuds", countryCode: "US", pageSize: 20 });
    expect(result.products).toHaveLength(2);
    expect(result.products[0]?.itemId).toBe(ITEM_A);
    const joined = logs.join("\n");
    expect(joined).toContain("aliexpress.ds.text.search.response");
    expect(joined).not.toContain(ACCESS_TOKEN);
    expect(joined).not.toContain(APP_SECRET);
    expect(joined).not.toContain(APP_KEY);
    spy.mockRestore();
  });
});
