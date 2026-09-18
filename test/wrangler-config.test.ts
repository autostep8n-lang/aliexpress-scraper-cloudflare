import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const wranglerToml = readFileSync(join(root, "wrangler.toml"), "utf8");
const envSource = readFileSync(join(root, "src", "env.ts"), "utf8");

const REQUIRED_SECRETS = ["SUPABASE_URL", "SUPABASE_SECRET_KEY"] as const;

describe("wrangler.toml Supabase bindings", () => {
  it("declares both required secrets so deploys fail fast if they are missing", () => {
    expect(wranglerToml).toMatch(/\[secrets\]/);
    expect(wranglerToml).toMatch(
      /required\s*=\s*\[\s*"SUPABASE_URL",\s*"SUPABASE_SECRET_KEY"\s*\]/,
    );
    for (const name of REQUIRED_SECRETS) {
      expect(wranglerToml).toContain(name);
    }
  });

  it("sets keep_vars = true so dashboard variables are not overridden on deploy", () => {
    expect(wranglerToml).toMatch(/keep_vars\s*=\s*true/);
  });

  it("never assigns a secret value inside wrangler.toml", () => {
    expect(wranglerToml).not.toMatch(/SUPABASE_URL\s*=\s*"/);
    expect(wranglerToml).not.toMatch(/SUPABASE_SECRET_KEY\s*=\s*"/);
    expect(wranglerToml).not.toMatch(/SHOPIFY_ADMIN_ACCESS_TOKEN\s*=\s*"/);
    expect(wranglerToml).not.toMatch(/SHOPIFY_EXPORT_TOKEN\s*=\s*"/);
    expect(wranglerToml).not.toMatch(/<your-secret-key>/);
  });

  it("keeps Shopify bindings optional and out of required secrets", () => {
    expect(envSource).toContain("SHOPIFY_SHOP_DOMAIN");
    expect(envSource).toContain("SHOPIFY_ADMIN_ACCESS_TOKEN");
    expect(envSource).toContain("SHOPIFY_EXPORT_TOKEN");
    expect(envSource).toContain("SHOPIFY_API_VERSION");
    expect(wranglerToml).toContain("SHOPIFY_SHOP_DOMAIN");
    expect(wranglerToml).toContain("SHOPIFY_ADMIN_ACCESS_TOKEN");
    expect(wranglerToml).toContain("SHOPIFY_EXPORT_TOKEN");
    expect(wranglerToml).toMatch(
      /required\s*=\s*\[\s*"SUPABASE_URL",\s*"SUPABASE_SECRET_KEY"\s*\]/,
    );
    expect(wranglerToml).not.toMatch(/required\s*=\s*\[[^\]]*SHOPIFY_/);
  });

  it("keeps the runtime Env bindings in src/env.ts aligned with the config", () => {
    for (const name of REQUIRED_SECRETS) {
      expect(envSource).toContain(name);
    }
  });
});

describe("wrangler.toml scheduled discovery cron", () => {
  it("declares a single daily cron trigger", () => {
    expect(wranglerToml).toMatch(/\[triggers\]/);
    expect(wranglerToml).toMatch(/crons\s*=\s*\[\s*"0 0 \* \* \*"\s*\]/);
  });
});
