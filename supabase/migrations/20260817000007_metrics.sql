-- P0.2 - Metrics, trend history, and scores.
-- metrics: current/latest values per (product or observation, metric_type, period).
-- trend_history: append-only time-series snapshots (price, rating, sales, ...).
-- scores: versioned computed scores (quality, demand, profitability, risk, ...).

create table public.metrics (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  product_source_id uuid references public.product_sources (id) on delete cascade,
  source_id uuid references public.sources (id) on delete cascade,
  metric_type text not null,
  value numeric not null,
  unit text,
  period_start timestamptz,
  period_end timestamptz,
  measured_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index metrics_product_type_idx on public.metrics (product_id, metric_type);
create index metrics_source_idx on public.metrics (source_id);
create index metrics_period_idx on public.metrics (period_start, period_end);
create index metrics_metadata_gin on public.metrics using gin (metadata);

-- One latest metric per scope/type/period: observation-level when a
-- product_source_id is present, product-level otherwise.
create unique index metrics_source_unique_idx
  on public.metrics (product_source_id, metric_type, period_start)
  where product_source_id is not null;
create unique index metrics_product_unique_idx
  on public.metrics (product_id, metric_type, period_start)
  where product_source_id is null;

create trigger metrics_set_updated_at
  before update on public.metrics
  for each row execute function public.set_updated_at();

create table public.trend_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  product_source_id uuid references public.product_sources (id) on delete cascade,
  source_id uuid references public.sources (id) on delete cascade,
  metric_type text not null,
  value numeric not null,
  unit text,
  captured_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index trend_history_product_type_time_idx
  on public.trend_history (product_id, metric_type, captured_at desc);
create index trend_history_source_type_time_idx
  on public.trend_history (product_source_id, metric_type, captured_at desc);
create index trend_history_captured_idx on public.trend_history (captured_at);
create index trend_history_metadata_gin on public.trend_history using gin (metadata);

create table public.scores (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  product_source_id uuid references public.product_sources (id) on delete cascade,
  score_type text not null,
  value numeric not null,
  min_value numeric,
  max_value numeric,
  version integer not null default 1 check (version >= 1),
  inputs jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index scores_product_type_time_idx
  on public.scores (product_id, score_type, computed_at desc);
create index scores_source_type_time_idx
  on public.scores (product_source_id, score_type, computed_at desc);

create trigger scores_set_updated_at
  before update on public.scores
  for each row execute function public.set_updated_at();
