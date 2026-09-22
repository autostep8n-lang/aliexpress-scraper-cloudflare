import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { aliexpressDiscovery } from "../../src/discovery/aliexpress";
import { persistAliExpressToken } from "../../src/scrapers/aliexpress-oauth";
import { DS_BUSINESS_ENDPOINT } from "../../src/scrapers/aliexpress-sign";
import { ScraperError } from "../../src/scrapers/types";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const APP_KEY = "test-app-key";
const APP_SECRET = "test-app-secret";
const ACCESS_TOKEN = "test-access-token";
const ITEM_A = "1005012410104961";
const ITEM_B = "1005012410104962";

const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext;

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

function searchBody(ids: string[]): string {
  return JSON.stringify({
    "aliexpress.ds.text.search_response": {
      result: {
        data: {
          total: ids.length,
          products: ids.map((itemId) => ({ itemId, title: `Search ${itemId}` })),
        },
      },
    },
  });
}

function productBody(itemId: string, title = `Product ${itemId}`): string {
  return JSON.stringify({
    "aliexpress.ds.product.get_response": {
      result: {
        productDetailModel: {
          productId: itemId,
          subject: title,
          productPrice: 19.99,
          currencyCode: "USD",
          imageUrls: [`https://ae-pic-a1.aliexpress-media.com/kf/${itemId}.jpg`],
        },
      },
    },
  });
}

async function configuredEnv(): Promise<Env> {
  const kv = new MemoryKV();
  const env = {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: SECRET_KEY,
    ALIEXPRESS_OPENAPI_KEY: APP_KEY,
    ALIEXPRESS_OPENAPI_SECRET: APP_SECRET,
    SCRAPE_CACHE: kv as unknown as KVNamespace,
  } as Env;
  await persistAliExpressToken(env, {
    accessToken: ACCESS_TOKEN,
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600_000,
    refreshExpiresAt: Date.now() + 86400_000,
  });
  return env;
}

function dsFetch(server: MockPostgrest, opts: { searchIds: string[]; failGet?: string }): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL((input as Request).url);
    if (url.href === DS_BUSINESS_ENDPOINT || url.hostname === "api-sg.aliexpress.com") {
      const params = new URLSearchParams(String(init?.body ?? ""));
      const method = params.get("method");
      if (method === "aliexpress.ds.text.search") {
        return Promise.resolve(new Response(searchBody(opts.searchIds), { status: 200 }));
      }
      if (method === "aliexpress.ds.product.get") {
        const productId = params.get("product_id") ?? "";
        if (opts.failGet && productId === opts.failGet) {
          return Promise.resolve(
            new Response(JSON.stringify({ error_response: { code: "400", msg: "Invalid parameter" } }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response(productBody(productId), { status: 200 }));
      }
    }
    return server.fetch(input, init);
  };
}

describe("aliexpressDiscovery.discover", () => {
  let server: MockPostgrest;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws PROVIDER_CREDENTIALS_MISSING without OpenAPI secrets", async () => {
    try {
      await aliexpressDiscovery.discover(
        { query: "earbuds", limit: 2 },
        { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env,
        ctx,
      );
      throw new Error("expected PROVIDER_CREDENTIALS_MISSING");
    } catch (err) {
      expect((err as ScraperError).code).toBe("PROVIDER_CREDENTIALS_MISSING");
    }
  });

  it("searches, enriches, normalizes, and persists products", async () => {
    server = createMockPostgrest();
    const env = await configuredEnv();
    vi.stubGlobal("fetch", dsFetch(server, { searchIds: [ITEM_A, ITEM_B] }));

    const result = await aliexpressDiscovery.discover({ query: "earbuds", limit: 20 }, env, ctx);
    expect(result.platform).toBe("aliexpress");
    expect(result.query).toBe("earbuds");
    expect(result.discovered).toBe(2);
    expect(result.persisted).toBe(2);
    expect(result.created).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.products[0]?.product?.externalId).toBe(ITEM_A);
    expect(result.products[0]?.product?.platform).toBe("aliexpress");
    expect(server.store.products).toHaveLength(2);
  });

  it("continues when one product.get fails", async () => {
    server = createMockPostgrest();
    const env = await configuredEnv();
    vi.stubGlobal("fetch", dsFetch(server, { searchIds: [ITEM_A, ITEM_B], failGet: ITEM_A }));

    const result = await aliexpressDiscovery.discover({ query: "earbuds", limit: 20 }, env, ctx);
    expect(result.discovered).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.persisted).toBe(1);
    expect(result.created).toBe(1);
  });

  it("honors limit", async () => {
    server = createMockPostgrest();
    const env = await configuredEnv();
    vi.stubGlobal("fetch", dsFetch(server, { searchIds: [ITEM_A, ITEM_B] }));

    const result = await aliexpressDiscovery.discover({ query: "earbuds", limit: 1 }, env, ctx);
    expect(result.requested).toBe(1);
    expect(result.discovered).toBe(1);
    expect(result.products).toHaveLength(1);
    expect(result.persisted).toBe(1);
  });
});
