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

  it("sets a shared updated_at trigger on every table that has updated_at", () => {
    expect(ALL_MIGRATION_SQL).toMatch(/function public\.set_updated_at\(\)/);
    const tablesWithUpdatedAt = EXPECTED_TABLES.filter((t) => t !== "trend_history");
    for (const table of tablesWithUpdatedAt) {
      expect(ALL_MIGRATION_SQL).toContain(`${table}_set_updated_at`);
    }
  });
});
