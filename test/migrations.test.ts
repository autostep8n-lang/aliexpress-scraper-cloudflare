import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const typesSource = readFileSync(join(root, "src", "scrapers", "types.ts"), "utf8");
const migrationsDir = join(root, "supabase", "migrations");
const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const ALL_MIGRATION_SQL = migrationFiles.map((f) => readFileSync(join(migrationsDir, f), "utf8")).join("\n");

const EXPECTED_TABLES = [
  "products",
  "product_sources",
  "sources",
  "jobs",
  "job_runs",
  "metrics",
  "trend_history",
  "suppliers",
  "product_suppliers",
  "scores",
  "product_categories",
  "google_trends",
  "reddit_signals",
  "youtube_signals",
  "instagram_signals",
  "country_opportunity_scores",
  "alerts",
  "reports",
  "shopify_listings",
] as const;

const EXPECTED_MIGRATIONS = [
  "20260817000001_extensions.sql",
  "20260817000002_sources.sql",
  "20260817000003_products.sql",
  "20260817000004_product_sources.sql",
  "20260817000005_suppliers.sql",
  "20260817000006_jobs.sql",
  "20260817000007_metrics.sql",
  "20260817000008_rls.sql",
  "20260817000009_seed_sources.sql",
  "20260817000010_integrity_hardening.sql",
  "20260817000011_google_trends.sql",
  "20260817000012_reddit.sql",
  "20260817000013_youtube.sql",
  "20260817000014_instagram.sql",
  "20260817000015_country_opportunity.sql",
  "20260817000016_products_dedup_key_unique.sql",
  "20260817000017_scores_unique.sql",
  "20260817000018_alerts.sql",
  "20260817000019_reports.sql",
  "20260817000020_shopify_listings.sql",
] as const;

describe("Supabase migrations", () => {
  it("declares one migration file per expected step in dependency order", () => {
    expect(migrationFiles).toEqual([...EXPECTED_MIGRATIONS]);
  });

  it("defines all core pipeline tables exactly once", () => {
    for (const table of EXPECTED_TABLES) {
      const occurrences = ALL_MIGRATION_SQL.split(`create table public.${table}`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("uses UUID primary keys and created_at/updated_at timestamps everywhere", () => {
    const createTables = ALL_MIGRATION_SQL.match(/create table public\.(\w+)[\s\S]*?;/g) ?? [];
    for (const block of createTables) {
      expect(block).toMatch(/id uuid primary key default gen_random_uuid\(\)/);
      expect(block).toMatch(/created_at timestamptz not null default now\(\)/);
      // trend_history is append-only and intentionally has no updated_at.
      if (block.includes("trend_history")) {
        expect(block).not.toMatch(/updated_at/);
      } else {
        expect(block).toMatch(/updated_at timestamptz not null default now\(\)/);
      }
    }
  });

  it("never drops or truncates tables (non-destructive by design)", () => {
    expect(ALL_MIGRATION_SQL).not.toMatch(/drop\s+table/i);
    expect(ALL_MIGRATION_SQL).not.toMatch(/drop\s+database/i);
    expect(ALL_MIGRATION_SQL).not.toMatch(/truncate/i);
    expect(ALL_MIGRATION_SQL).not.toMatch(/delete\s+from/i);
  });

  it("contains no credentials or secret placeholders", () => {
    expect(ALL_MIGRATION_SQL).not.toMatch(/SUPABASE_URL/);
    expect(ALL_MIGRATION_SQL).not.toMatch(/SUPABASE_SECRET_KEY/);
    expect(ALL_MIGRATION_SQL).not.toMatch(/apikey/i);
    expect(ALL_MIGRATION_SQL).not.toMatch(/<your-secret-key>/);
    expect(ALL_MIGRATION_SQL).not.toMatch(/(password|secret)\s*=/i);
  });

  it("enables RLS on every core table with no public policies", () => {
    for (const table of EXPECTED_TABLES) {
      expect(ALL_MIGRATION_SQL).toContain(`alter table public.${table} enable row level security`);
    }
    expect(ALL_MIGRATION_SQL).not.toMatch(/create\s+(or\s+replace\s+)?policy/i);
  });

  it("keeps the source seed aligned with ScraperPlatform in src/scrapers/types.ts", () => {
    const seed = readFileSync(join(migrationsDir, "20260817000009_seed_sources.sql"), "utf8");
    for (const platform of ["aliexpress", "tiktok-shop", "amazon", "youtube", "instagram", "facebook", "alibaba"]) {
      expect(typesSource).toContain(`"${platform}"`);
      expect(seed).toContain(`'${platform}'`);
    }
  });

  it("gives products.dedup_key a non-partial UNIQUE constraint for PostgREST ON CONFLICT", () => {
    const corrective = readFileSync(join(migrationsDir, "20260817000016_products_dedup_key_unique.sql"), "utf8");
    const statements = corrective
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).toMatch(/add constraint products_dedup_key_key unique \(dedup_key\)/i);
    expect(statements).toMatch(/drop index if exists public\.products_dedup_key_uidx/i);
    expect(statements).not.toMatch(/where\s+dedup_key\s+is\s+not\s+null/i);
    expect(ALL_MIGRATION_SQL).toMatch(/constraint products_dedup_key_key unique \(dedup_key\)/i);
  });

  it("gives scores a UNIQUE (product_id, score_type, version) constraint for PostgREST ON CONFLICT", () => {
    const migration = readFileSync(join(migrationsDir, "20260817000017_scores_unique.sql"), "utf8");
    const statements = migration
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).toMatch(
      /add constraint scores_product_type_version_key unique \(product_id, score_type, version\)/i,
    );
    expect(statements).toMatch(/raise exception/i);
    expect(statements).not.toMatch(/delete\s+from/i);
    expect(statements).not.toMatch(/drop\s+table/i);
  });

  it("gives alerts a non-partial UNIQUE (product_id, alert_type, dedup_key) index for PostgREST ON CONFLICT", () => {
    const migration = readFileSync(join(migrationsDir, "20260817000018_alerts.sql"), "utf8");
    const statements = migration
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).toMatch(
      /unique index alerts_product_type_dedup_uidx\s+on public\.alerts \(product_id, alert_type, dedup_key\)/i,
    );
    expect(statements).not.toMatch(/where\s+[a-z_]+\s+is\s+not\s+null/i);
    expect(statements).not.toMatch(/drop\s+table/i);
    expect(statements).not.toMatch(/delete\s+from/i);
  });

  it("pins the alerts severity/country/tier domains to the approved v1 contract", () => {
    const migration = readFileSync(join(migrationsDir, "20260817000018_alerts.sql"), "utf8");
    expect(migration).toMatch(/severity text not null default 'info'/i);
    expect(migration).toMatch(/severity in \('info', 'warning', 'critical'\)/i);
    expect(migration).toMatch(/summary text not null/i);
    expect(migration).toMatch(/country in \('SA', 'US', 'GB', 'DE', 'FR', 'ES', 'IT'\)/i);
    expect(migration).toMatch(/tier in \('high', 'medium', 'low', 'unknown'\)/i);
    expect(migration).toMatch(/value numeric/i);
    expect(migration).toMatch(/inputs jsonb not null default '\{\}'::jsonb/i);
    expect(migration).toMatch(/alerts_country_idx/i);
    expect(migration).toMatch(/alerts_inputs_gin\s+on public\.alerts using gin \(inputs\)/i);
    // The rejected draft schema must not resurface.
    expect(migration).not.toMatch(/severity in \('high', 'medium', 'low'\)/i);
    expect(migration).not.toMatch(/\bmessage text/i);
  });

  it("gives reports a non-partial UNIQUE (report_type, dedup_key) index for PostgREST ON CONFLICT", () => {
    const migration = readFileSync(join(migrationsDir, "20260817000019_reports.sql"), "utf8");
    const statements = migration
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).toMatch(
      /unique index reports_type_dedup_uidx\s+on public\.reports \(report_type, dedup_key\)/i,
    );
    expect(statements).not.toMatch(/where\s+[a-z_]+\s+is\s+not\s+null/i);
    expect(statements).not.toMatch(/drop\s+table/i);
    expect(statements).not.toMatch(/delete\s+from/i);
  });

  it("pins the reports type domain and required digest columns to the approved v1 contract", () => {
    const migration = readFileSync(join(migrationsDir, "20260817000019_reports.sql"), "utf8");
    expect(migration).toMatch(/report_type in \('daily_digest'\)/i);
    expect(migration).toMatch(/dedup_key text not null/i);
    expect(migration).toMatch(/title text not null/i);
    expect(migration).toMatch(/summary text not null/i);
    expect(migration).toMatch(/period_start timestamptz not null/i);
    expect(migration).toMatch(/period_end timestamptz not null/i);
    expect(migration).toMatch(/payload jsonb not null default '\{\}'::jsonb/i);
    expect(migration).toMatch(/generated_at timestamptz not null default now\(\)/i);
    expect(migration).toMatch(/reports_generated_at_idx/i);
    expect(migration).toMatch(/reports_payload_gin\s+on public\.reports using gin \(payload\)/i);
  });

  it("gives shopify_listings non-partial UNIQUE (shop_domain, product_id) and (shop_domain, shopify_product_id)", () => {
    const migration = readFileSync(join(migrationsDir, "20260817000020_shopify_listings.sql"), "utf8");
    const statements = migration
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).toMatch(
      /unique index shopify_listings_shop_product_uidx\s+on public\.shopify_listings \(shop_domain, product_id\)/i,
    );
    expect(statements).toMatch(
      /unique index shopify_listings_shop_shopify_product_uidx\s+on public\.shopify_listings \(shop_domain, shopify_product_id\)/i,
    );
    expect(statements).not.toMatch(/unique index \S+\s+on public\.shopify_listings \(product_id\)/i);
    expect(statements).not.toMatch(/where\s+[a-z_]+\s+is\s+not\s+null/i);
    expect(statements).not.toMatch(/drop\s+table/i);
    expect(statements).not.toMatch(/delete\s+from/i);
  });

  it("pins shopify_listings columns, indexes, trigger, and RLS to the approved v1 contract", () => {
    const migration = readFileSync(join(migrationsDir, "20260817000020_shopify_listings.sql"), "utf8");
    expect(migration).toMatch(/product_id uuid not null references public\.products \(id\) on delete cascade/i);
    expect(migration).toMatch(/shop_domain text not null/i);
    expect(migration).toMatch(/shopify_product_id text/i);
    expect(migration).toMatch(/shopify_variant_id text/i);
    expect(migration).toMatch(/status in \('draft', 'exported', 'error'\)/i);
    expect(migration).toMatch(/dedup_key text not null/i);
    expect(migration).toMatch(/title text not null/i);
    expect(migration).toMatch(/payload jsonb not null default '\{\}'::jsonb/i);
    expect(migration).toMatch(/last_error jsonb/i);
    expect(migration).toMatch(/exported_at timestamptz/i);
    expect(migration).toMatch(/shopify_listings_product_idx/i);
    expect(migration).toMatch(/shopify_listings_shop_idx/i);
    expect(migration).toMatch(/shopify_listings_status_idx/i);
    expect(migration).toMatch(/shopify_listings_set_updated_at/i);
    expect(migration).toMatch(/alter table public\.shopify_listings enable row level security/i);
    expect(migration).not.toMatch(/create\s+(or\s+replace\s+)?policy/i);
  });

  it("sets a shared updated_at trigger on every table that has updated_at", () => {
    expect(ALL_MIGRATION_SQL).toMatch(/function public\.set_updated_at\(\)/);
    const tablesWithUpdatedAt = EXPECTED_TABLES.filter((t) => t !== "trend_history");
    for (const table of tablesWithUpdatedAt) {
      expect(ALL_MIGRATION_SQL).toContain(`${table}_set_updated_at`);
    }
  });
});
