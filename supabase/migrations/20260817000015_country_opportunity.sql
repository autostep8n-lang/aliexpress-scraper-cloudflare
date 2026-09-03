-- P4.23 - Country Opportunity Scoring.
--
-- One snapshot per product x country x score_type. P4.22 evidence lives in
-- google_trends (geo); this table stores the composed product x country score.
-- A re-score of the same product/country replaces the snapshot.

create table public.country_opportunity_scores (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  country text not null
    check (country in ('SA', 'US', 'GB', 'DE', 'FR', 'ES', 'IT')),
  keyword text not null,
  score_type text not null default 'country_opportunity',
  value numeric not null,
  min_value numeric,
  max_value numeric,
  normalized numeric not null,
  total_weight numeric not null,
  tier text not null
    check (tier in ('high', 'medium', 'low', 'unknown')),
  version integer not null default 1 check (version >= 1),
  inputs jsonb not null default '{}'::jsonb,
  country_latest_value numeric,
  country_change numeric,
  country_direction text,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index country_opportunity_scores_product_country_type_uidx
  on public.country_opportunity_scores (product_id, country, score_type);

create index country_opportunity_scores_country_idx
  on public.country_opportunity_scores (country);

create index country_opportunity_scores_product_idx
  on public.country_opportunity_scores (product_id);

create index country_opportunity_scores_tier_idx
  on public.country_opportunity_scores (tier);

create index country_opportunity_scores_inputs_gin
  on public.country_opportunity_scores using gin (inputs);

create trigger country_opportunity_scores_set_updated_at
  before update on public.country_opportunity_scores
  for each row execute function public.set_updated_at();

alter table public.country_opportunity_scores enable row level security;
