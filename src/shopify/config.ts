import type { Env } from "../env";
import { SHOPIFY_API_VERSION, type ShopifyConfig } from "./types";

export function getShopifyConfig(env: Env): ShopifyConfig | null {
  const shopDomain = normalizeShopDomain(env.SHOPIFY_SHOP_DOMAIN);
  const adminToken = env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
  if (!shopDomain || !adminToken) return null;
  const apiVersion = env.SHOPIFY_API_VERSION?.trim() || SHOPIFY_API_VERSION;
  return {
    shopDomain,
    adminToken,
    apiVersion,
    graphqlUrl: `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
  };
}

export function getShopifyExportToken(env: Env): string | null {
  const token = env.SHOPIFY_EXPORT_TOKEN?.trim();
  return token || null;
}

export function normalizeShopDomain(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  let domain = value.trim();
  if (!domain) return null;
  domain = domain.replace(/^https?:\/\//i, "");
  domain = domain.replace(/\/+$/, "");
  if (!domain || domain.includes("/") || domain.includes("?") || domain.includes("#") || domain.includes("@")) {
    return null;
  }
  try {
    const url = new URL(`https://${domain}`);
    if (url.hostname !== domain.toLowerCase() && url.hostname !== domain) return null;
    if (url.port) return null;
    return url.hostname;
  } catch {
    return null;
  }
}
