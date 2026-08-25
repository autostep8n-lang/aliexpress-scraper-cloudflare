import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractToken,
  fetchAliExpressProductMtop,
  mapMtopResult,
  needsTokenRetry,
  parseMtopPayload,
  regionForHost,
} from "../../src/scrapers/aliexpress-mtop";
import { ScraperError } from "../../src/scrapers/types";
import { md5 } from "../../src/utils/md5";

const ITEM_ID = "1005012410104961";

function mtopResult(itemId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    GLOBAL_DATA: {
      globalData: {
        productId: itemId,
        subject: "Portable Hair Straightener Comb 2600mAh",
        image: "https://ae-pic-a1.aliexpress-media.com/kf/Sabc.jpg",
        categoryPath: "66/200001168/201375716/200001211",
        category1: 66,
        productInfo: {
          productId: itemId,
          detailUrl: `https://www.aliexpress.com/item/${itemId}.html`,
          hasStock: true,
        },
        offlineInfo: { itemStatus: 0 },
        sellerName: "Shop1103920178 Store",
      },
    },
    PRODUCT_TITLE: { text: "Portable Hair Straightener Comb 2600mAh" },
    PRICE: {
      selectedSkuId: "12000058476050807",
      targetSkuPriceInfo: {
        originalPrice: { currency: "USD", formatedAmount: "$7.46", value: 7.46 },
        salePriceLocal: "$3.43|3.43|",
        salePriceString: "$3.43",
      },
      skuIdStrPriceInfoMap: {
        "12000058476050807": {
          originalPrice: { currency: "USD", formatedAmount: "$7.46", value: 7.46 },
          salePriceLocal: "$3.43|3.43|",
          salePriceString: "$3.43",
        },
      },
    },
    HEADER_IMAGE_PC: {
      mainImages: [
        { imageUrl: "https://ae-pic-a1.aliexpress-media.com/kf/S9e0501832f6b49698d4502e004a3a390a.jpeg" },
        { imageUrl: "//ae01.alicdn.com/kf/Habc.jpg" },
      ],
      imagePathList: ["https://ae-pic-a1.aliexpress-media.com/kf/S53722e550ca34479917a9e512f49ca0eE.jpg"],
    },
    PRODUCT_PROP_PC: {
      showedProps: [
        { attrName: "Brand", attrValue: "SoundCore" },
        { attrName: "Material", attrValue: "ABS" },
      ],
    },
    PC_RATING: { rating: 4.5, totalValidNum: 4 },
    SHOP_CARD_PC: { storeName: "Shop1103920178 Store" },
    ...overrides,
  };
}

function jsonpBody(result: Record<string, unknown>): string {
  return `callback(${JSON.stringify({
    api: "mtop.aliexpress.pdp.pc.query",
    data: { result },
    ret: ["SUCCESS::调用成功"],
    v: "1.0",
  })})`;
}

function tokenEmptyBody(): string {
  return JSON.stringify({
    api: "mtop.aliexpress.pdp.pc.query",
    data: {},
    ret: ["FAIL_SYS_TOKEN_EMPTY::令牌为空"],
    v: "1.0",
  });
}

const HINT = { url: new URL(`https://www.aliexpress.com/item/${ITEM_ID}.html`), itemId: ITEM_ID };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("regionForHost", () => {
  it("maps known TLDs to their localized regions", () => {
    expect(regionForHost("www.aliexpress.com")).toEqual({ site: "en", lang: "en_US", currency: "USD", country: "US" });
    expect(regionForHost("www.aliexpress.us")).toEqual({ site: "en", lang: "en_US", currency: "USD", country: "US" });
    expect(regionForHost("id.aliexpress.com")).toEqual({ site: "idn", lang: "id_ID", currency: "IDR", country: "ID" });
    expect(regionForHost("ar.aliexpress.com")).toEqual({ site: "ar", lang: "es_AR", currency: "ARS", country: "AR" });
    expect(regionForHost("es.aliexpress.com")).toEqual({ site: "es", lang: "es_ES", currency: "EUR", country: "ES" });
    expect(regionForHost("aliexpress.ru")).toEqual({ site: "ru", lang: "ru_RU", currency: "RUB", country: "RU" });
  });

  it("defaults unknown hosts to en_US/USD", () => {
    expect(regionForHost("unknown.example.com")).toEqual({ site: "en", lang: "en_US", currency: "USD", country: "US" });
  });
});

describe("extractToken", () => {
  it("reads the _m_h5_tk token from a Set-Cookie header", () => {
    expect(extractToken(`_m_h5_tk=641dd17c1b34a2a36b417422edb239d3_1787672719000; Domain=.aliexpress.com; Path=/; HttpOnly`)).toBe(
      "641dd17c1b34a2a36b417422edb239d3",
    );
  });

  it("returns undefined when the cookie is absent", () => {
    expect(extractToken(undefined)).toBeUndefined();
    expect(extractToken("Other=value; Path=/")).toBeUndefined();
  });
});

describe("needsTokenRetry", () => {
  it("detects token-missing responses", () => {
    expect(needsTokenRetry('{"ret":["FAIL_SYS_TOKEN_EMPTY::令牌为空"]}')).toBe(true);
    expect(needsTokenRetry('{"ret":["FAIL_SYS_TOKEN_EXOIRED::令牌过期"]}')).toBe(true);
    expect(needsTokenRetry('{"ret":["FAIL_SYS_TOKEN_ILLEGAL::令牌非法"]}')).toBe(true);
  });

  it("does not retry on success or unrelated errors", () => {
    expect(needsTokenRetry('{"ret":["SUCCESS::调用成功"]}')).toBe(false);
    expect(needsTokenRetry('{"ret":["FAIL_SYS_USER_VALIDATE"]}')).toBe(false);
  });
});

describe("mapMtopResult", () => {
  it("maps a full product result into the normalize-ready shape", () => {
    const parsed = mapMtopResult(mtopResult(ITEM_ID), HINT);

    expect(parsed.itemId).toBe(ITEM_ID);
    expect(parsed.title).toBe("Portable Hair Straightener Comb 2600mAh");
    expect(parsed.price).toEqual({ amount: 3.43, currency: "USD", originalAmount: 7.46 });
    expect(parsed.images).toHaveLength(3);
    expect(parsed.images[0].url).toBe("https://ae-pic-a1.aliexpress-media.com/kf/S9e0501832f6b49698d4502e004a3a390a.jpeg");
    expect(parsed.images[1].url).toBe("https://ae01.alicdn.com/kf/Habc.jpg");
    expect(parsed.seller).toBe("Shop1103920178 Store");
    expect(parsed.brand).toBe("SoundCore");
    expect(parsed.attributes["Material"]).toBe("ABS");
    expect(parsed.rating).toEqual({ average: 4.5, count: 4 });
    expect(parsed.availability).toBe(true);
    expect(parsed.category).toEqual({ id: "200001211", name: "200001211", path: ["66", "200001168", "201375716", "200001211"] });
    expect(parsed.raw["productUrl"]).toBe(`https://www.aliexpress.com/item/${ITEM_ID}.html`);
  });

  it("parses IDR-style salePriceLocal", () => {
    const result = mtopResult(ITEM_ID);
    const price = result["PRICE"] as {
      targetSkuPriceInfo: { salePriceLocal: string; originalPrice: { currency: string; value: number } };
    };
    price.targetSkuPriceInfo.salePriceLocal = "Rp343,297|343297|";
    price.targetSkuPriceInfo.originalPrice = { currency: "IDR", value: 460000 };
    const parsed = mapMtopResult(result, HINT);
    expect(parsed.price).toEqual({ amount: 343297, currency: "IDR", originalAmount: 460000 });
  });

  it("falls back to the selected SKU entry when targetSkuPriceInfo has no price", () => {
    const result = mtopResult(ITEM_ID);
    const price = result["PRICE"] as {
      targetSkuPriceInfo: Record<string, unknown>;
      skuIdStrPriceInfoMap: Record<string, { salePriceLocal: string }>;
    };
    delete price.targetSkuPriceInfo["salePriceLocal"];
    price.skuIdStrPriceInfoMap["12000058476050807"].salePriceLocal = "$4.00|4.00|";
    const parsed = mapMtopResult(result, HINT);
    expect(parsed.price.amount).toBe(4.0);
  });

  it("throws NO_PRODUCT_DATA when the title is missing", () => {
    const result = mtopResult(ITEM_ID);
    (result["PRODUCT_TITLE"] as { text: string }).text = "";
    (result["GLOBAL_DATA"] as { globalData: { subject: string } }).globalData.subject = "";
    try {
      mapMtopResult(result, HINT);
      throw new Error("expected NO_PRODUCT_DATA");
    } catch (err) {
      expect(err).toBeInstanceOf(ScraperError);
      expect((err as ScraperError).code).toBe("NO_PRODUCT_DATA");
    }
  });
});

describe("parseMtopPayload", () => {
  it("parses a successful JSONP envelope", () => {
    const parsed = parseMtopPayload(jsonpBody(mtopResult(ITEM_ID)), HINT);
    expect(parsed.itemId).toBe(ITEM_ID);
    expect(parsed.title).toBe("Portable Hair Straightener Comb 2600mAh");
  });

  it("maps a real captured mtop SUCCESS payload into the normalize-ready shape", async () => {
    const real = (await import("../../test/fixtures/aliexpress-mtop-real.json")) as { default: Record<string, unknown> };
    const body = JSON.stringify(real.default);
    const parsed = parseMtopPayload(body, { url: new URL("https://www.aliexpress.com/item/1005012410104961.html"), itemId: "1005012410104961" });

    expect(parsed.itemId).toBe("1005012410104961");
    expect(parsed.title).toContain("1 Buah Sisir Pelurus Rambut Portabel 2600mAh");
    expect(parsed.price).toEqual({ amount: 343297, currency: "IDR", originalAmount: 746269 });
    expect(parsed.images.length).toBeGreaterThanOrEqual(6);
    expect(parsed.seller).toBe("Shop1103920178 Store");
    expect(parsed.rating).toEqual({ average: 4.5, count: 4 });
    expect(parsed.availability).toBe(true);
  });

  it("throws BLOCKED on the TMD punish challenge", () => {
    const body = JSON.stringify({
      api: "mtop.aliexpress.pdp.pc.query",
      ret: ["FAIL_SYS_USER_VALIDATE", "RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],
      data: {
        url: "https://acs.aliexpress.com:443//h5/mtop.aliexpress.pdp.pc.query/1.0/_____tmd_____/punish?x5secdata=abc",
      },
      v: "1.0",
    });
    try {
      parseMtopPayload(body, HINT);
      throw new Error("expected BLOCKED");
    } catch (err) {
      expect(err).toBeInstanceOf(ScraperError);
      const typed = err as ScraperError;
      expect(typed.code).toBe("BLOCKED");
      expect(typed.message).toMatch(/RGV587_ERROR::SM/);
    }
  });

  it("throws BLOCKED when the gateway refuses the request token", () => {
    try {
      parseMtopPayload(tokenEmptyBody(), HINT);
      throw new Error("expected BLOCKED");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("BLOCKED");
    }
  });

  it("throws MTop_API_ERROR on a non-SUCCESS, non-token response", () => {
    const body = JSON.stringify({ api: "mtop.aliexpress.pdp.pc.query", data: {}, ret: ["FAIL_SYS_ILLEGAL_ARGUMENT::参数错误"], v: "1.0" });
    try {
      parseMtopPayload(body, HINT);
      throw new Error("expected MTop_API_ERROR");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("MTop_API_ERROR");
    }
  });

  it("throws NO_PRODUCT_DATA when the envelope has no result module", () => {
    const body = JSON.stringify({ api: "mtop.aliexpress.pdp.pc.query", data: {}, ret: ["SUCCESS::调用成功"], v: "1.0" });
    try {
      parseMtopPayload(body, HINT);
      throw new Error("expected NO_PRODUCT_DATA");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("NO_PRODUCT_DATA");
    }
  });
});

describe("fetchAliExpressProductMtop", () => {
  it("bootstraps the token, re-signs, and returns the product", async () => {
    const TOKEN = "641dd17c1b34a2a36b417422edb239d3";
    const calls: Array<{ url: string; cookie: string | null; sign: string; t: string; data: string; appKey: string }> = [];
    let callCount = 0;

    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(input));
      calls.push({
        url: parsed.href,
        cookie: new Headers(init?.headers).get("cookie"),
        sign: parsed.searchParams.get("sign") ?? "",
        t: parsed.searchParams.get("t") ?? "",
        data: parsed.searchParams.get("data") ?? "",
        appKey: parsed.searchParams.get("appKey") ?? "",
      });
      callCount += 1;
      if (callCount === 1) {
        return new Response(tokenEmptyBody(), {
          status: 200,
          headers: {
            "set-cookie": `_m_h5_tk=${TOKEN}_1787672719000; Domain=.aliexpress.com; Path=/; HttpOnly`,
          },
        });
      }
      return new Response(jsonpBody(mtopResult(ITEM_ID)), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchStub);

    const parsed = await fetchAliExpressProductMtop(ITEM_ID, HINT.url);

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(calls[0].appKey).toBe("12574478");
    expect(calls[0].cookie).toBeNull();
    expect(calls[0].sign).toBe(md5(`&${calls[0].t}&12574478&${calls[0].data}`));
    expect(calls[1].cookie).toBe(`_m_h5_tk=${TOKEN}`);
    expect(calls[1].sign).toBe(md5(`${TOKEN}&${calls[1].t}&12574478&${calls[1].data}`));

    const payload = JSON.parse(decodeURIComponent(calls[1].data)) as Record<string, string>;
    expect(payload.productId).toBe(ITEM_ID);
    expect(payload._currency).toBe("USD");

    expect(parsed.itemId).toBe(ITEM_ID);
    expect(parsed.title).toBe("Portable Hair Straightener Comb 2600mAh");
    expect(parsed.price).toEqual({ amount: 3.43, currency: "USD", originalAmount: 7.46 });
  });

  it("propagates a BLOCKED punish response from the signed retry", async () => {
    const TOKEN = "641dd17c1b34a2a36b417422edb239d3";
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(input));
      void parsed;
      const cookie = new Headers(init?.headers).get("cookie");
      if (!cookie) {
        return new Response(tokenEmptyBody(), {
          status: 200,
          headers: { "set-cookie": `_m_h5_tk=${TOKEN}_1787672719000; Path=/; HttpOnly` },
        });
      }
      return new Response(
        JSON.stringify({
          api: "mtop.aliexpress.pdp.pc.query",
          ret: ["FAIL_SYS_USER_VALIDATE", "RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],
          data: { url: "https://acs.aliexpress.com:443//h5/mtop.aliexpress.pdp.pc.query/1.0/_____tmd_____/punish?x5secdata=abc" },
          v: "1.0",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchStub);

    try {
      await fetchAliExpressProductMtop(ITEM_ID, HINT.url);
      throw new Error("expected BLOCKED");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("BLOCKED");
    }
  });

  it("surfaces a typed MTop_HTTP_ERROR when the gateway is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    try {
      await fetchAliExpressProductMtop(ITEM_ID, HINT.url);
      throw new Error("expected MTop_HTTP_ERROR");
    } catch (err) {
      const typed = err as ScraperError;
      expect(typed.code).toBe("MTop_HTTP_ERROR");
    }
  });
});
