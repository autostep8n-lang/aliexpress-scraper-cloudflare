-- P7.31 - Alerts.
--
-- Persistent in-Supabase alert feed. One row per (product x alert_type x
-- dedup_key); a re-evaluation refreshes `last_seen_at` (and reactivates a
-- resolved alert) instead of appending duplicates, while `first_seen_at` stays
-- fixed at the first observation. Alerts are derived from already-persisted
-- market/country opportunity scores and product lifecycle state, never from
-- recomputation.
--
-- Severity is a small, fixed domain (info|warning|critical). The engine maps
-- each alert family deterministically: `high_market_opportunity` -> critical,
-- `high_country_opportunity` -> warning, `lifecycle_review` -> info. The
-- opportunity tier stays in `tier`, the market in `country`, the numeric score
-- in `value` and the structured breakdown in `inputs`; nothing is collapsed
-- into a single JSON blob.
--
-- `country` is constrained to the approved v1 markets (P4.22) so a bad row can
-- never enter the feed. `tier` reuses the opportunity tier domain.
--
-- Non-destructive: this migration only creates new objects.

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  alert_type text not null
    check (alert_type in ('high_market_opportunity', 'high_country_opportunity', 'lifecycle_review')),
  severity text not null default 'info'
    check (severity in ('info', 'warning', 'critical')),
  status text not null default 'active'
    check (status in ('active', 'resolved')),
  dedup_key text,
  title text not null,
  summary text not null,
  country text
    check (country in ('SA', 'US', 'GB', 'DE', 'FR', 'ES', 'IT')),
  value numeric,
  tier text
    check (tier in ('high', 'medium', 'low', 'unknown')),
  inputs jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Non-partial unique index so PostgREST can infer the ON CONFLICT target for
-- `upsert(..., { onConflict: "product_id,alert_type,dedup_key" })`.
create unique index alerts_product_type_dedup_uidx
  on public.alerts (product_id, alert_type, dedup_key);

create index alerts_status_idx
  on public.alerts (status);

create index alerts_type_idx
  on public.alerts (alert_type);

create index alerts_product_idx
  on public.alerts (product_id);

create index alerts_country_idx
  on public.alerts (country);

create index alerts_inputs_gin
  on public.alerts using gin (inputs);

create trigger alerts_set_updated_at
  before update on public.alerts
  for each row execute function public.set_updated_at();

alter table public.alerts enable row level security;
