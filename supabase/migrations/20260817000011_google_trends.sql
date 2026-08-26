-- P3.1 - Google Trends market intelligence.
-- External market-demand/search-trend observations captured from Google Trends.
-- SEPARATE from trend_history (P1.4 internal product snapshots): this table is
-- keyword/geo-scoped upsert storage (latest value per bucket), keyed on
-- (source_id, keyword, geo, property, time_range, period_start).

create table public.google_trends (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources (id) on delete restrict,
  keyword text not null,
  geo text not null default 'WORLD',
  property text not null default 'web',
  category bigint,
  time_range text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  value numeric(5,2) not null check (value >= 0 and value <= 100),
  captured_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index google_trends_keyword_idx on public.google_trends (keyword);
create index google_trends_geo_idx on public.google_trends (geo);
create index google_trends_period_idx on public.google_trends (period_start, period_end);
create index google_trends_captured_idx on public.google_trends (captured_at);
create index google_trends_metadata_gin on public.google_trends using gin (metadata);

-- One row per source/keyword/geo/property/range/bucket: a re-collect of the
-- same bucket replaces the value rather than appending a duplicate.
-- "WORLD" is used for worldwide (never NULL) so a single non-partial unique
-- index supports PostgREST on_conflict.
create unique index google_trends_dedup_uidx
  on public.google_trends (source_id, keyword, geo, property, time_range, period_start);

alter table public.google_trends
  add constraint google_trends_geo_format_check
  check (geo ~ '^(WORLD|[A-Z]{2}(-[A-Z]{2,3})?)$');

alter table public.google_trends
  add constraint google_trends_property_check
  check (property in ('web', 'images', 'news', 'youtube', 'froogle'));

alter table public.google_trends
  add constraint google_trends_category_check
  check (category is null or category >= 0);

alter table public.google_trends
  add constraint google_trends_period_order_check
  check (period_end >= period_start);

create trigger google_trends_set_updated_at
  before update on public.google_trends
  for each row execute function public.set_updated_at();

-- Admin-only, consistent with every other core table.
alter table public.google_trends enable row level security;

-- Idempotent seed of the Google Trends source (kind 'api', market intelligence).
insert into public.sources (slug, name, kind, base_url, metadata)
values ('google-trends', 'Google Trends', 'api', 'https://trends.google.com', '{"properties":["web","images","news","youtube","froogle"]}'::jsonb)
on conflict (slug) do nothing;
