-- P7.31 - Alerts.
--
-- Persistent in-Supabase alert feed. One row per (product x alert_type x
-- dedup_key); a re-evaluation refreshes `last_seen_at` (and reactivates a
-- resolved alert) instead of appending duplicates, while `first_seen_at` stays
-- fixed at the first observation. Alerts are derived from already-persisted
-- market/country opportunity scores and product lifecycle state, never from
-- recomputation. Non-destructive: this migration only creates new objects.

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  alert_type text not null
    check (alert_type in ('high_market_opportunity', 'high_country_opportunity', 'lifecycle_review')),
  severity text not null
    check (severity in ('high', 'medium', 'low')),
  status text not null default 'active'
    check (status in ('active', 'resolved')),
  dedup_key text not null,
  title text not null,
  message text not null,
  evidence jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Non-partial unique constraint so PostgREST can infer the ON CONFLICT target
-- for `upsert(..., { onConflict: "product_id,alert_type,dedup_key" })`.
create unique index alerts_product_type_dedup_key_uidx
  on public.alerts (product_id, alert_type, dedup_key);

create index alerts_product_idx
  on public.alerts (product_id);

create index alerts_status_idx
  on public.alerts (status);

create index alerts_type_idx
  on public.alerts (alert_type);

create trigger alerts_set_updated_at
  before update on public.alerts
  for each row execute function public.set_updated_at();

alter table public.alerts enable row level security;
