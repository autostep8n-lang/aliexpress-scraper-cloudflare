import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { getShopifyListingByShopAndProduct, upsertShopifyListing } from "../../src/supabase/repository";
import { createMockPostgrest, type MockPostgrest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";
const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const SHOP = "example.myshopify.com";

function env(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

describe("shopify_listings repository", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("upserts on shop_domain,product_id and returns the persisted row", async () => {
    const created = await upsertShopifyListing(env(), {
      product_id: PRODUCT_ID,
      shop_domain: SHOP,
      shopify_product_id: "gid://shopify/Product/1",
      shopify_variant_id: "gid://shopify/ProductVariant/9",
      status: "draft",
      dedup_key: `${SHOP}:${PRODUCT_ID}`,
      title: "Wireless Earbuds",
      payload: { title: "Wireless Earbuds" },
      last_error: null,
      exported_at: "2026-08-18T10:00:00.000Z",
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    expect(created.data.shop_domain).toBe(SHOP);
    expect(created.data.product_id).toBe(PRODUCT_ID);
    expect(created.data.status).toBe("draft");

    const conflict = server.requests.find((request) => request.method === "POST" && request.url.includes("shopify_listings"));
    expect(conflict?.url).toContain("on_conflict=shop_domain%2Cproduct_id");

    const updated = await upsertShopifyListing(env(), {
      product_id: PRODUCT_ID,
      shop_domain: SHOP,
      shopify_product_id: "gid://shopify/Product/1",
      shopify_variant_id: "gid://shopify/ProductVariant/9",
      status: "draft",
      dedup_key: `${SHOP}:${PRODUCT_ID}`,
      title: "Wireless Earbuds v2",
      payload: { title: "Wireless Earbuds v2" },
    });
    expect(updated.status).toBe("updated");
    if (updated.status !== "updated") return;
    expect(updated.data.title).toBe("Wireless Earbuds v2");
    expect(server.store.shopify_listings).toHaveLength(1);
  });

  it("looks up by shop + product and reports not_found", async () => {
    const missing = await getShopifyListingByShopAndProduct(env(), SHOP, PRODUCT_ID);
    expect(missing.status).toBe("not_found");

    server.seed("shopify_listings", [
      {
        id: "listing-1",
        product_id: PRODUCT_ID,
        shop_domain: SHOP,
        shopify_product_id: "gid://shopify/Product/1",
        status: "draft",
        dedup_key: `${SHOP}:${PRODUCT_ID}`,
        title: "Wireless Earbuds",
      },
    ]);
    const found = await getShopifyListingByShopAndProduct(env(), SHOP, PRODUCT_ID);
    expect(found.status).toBe("found");
  });

  it("returns shopify_listings_upsert_failed when PostgREST rejects the write", async () => {
    server.override("POST", "shopify_listings", 500, { message: "boom" });
    const result = await upsertShopifyListing(env(), {
      product_id: PRODUCT_ID,
      shop_domain: SHOP,
      shopify_product_id: "gid://shopify/Product/1",
      shopify_variant_id: null,
      status: "draft",
      dedup_key: `${SHOP}:${PRODUCT_ID}`,
      title: "Wireless Earbuds",
      payload: {},
    });
    expect(result).toMatchObject({ status: "error", code: "shopify_listings_upsert_failed" });
  });
});
