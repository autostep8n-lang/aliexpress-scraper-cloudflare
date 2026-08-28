-- P3.3 - YouTube market intelligence.
--
-- Aggregate keyword-level signals derived from YouTube Data API v3 search
-- results. Each row is one snapshot for one keyword with one sort/recency
-- (video count, engagement totals, dominant channel, top videos as metadata).
-- Keyed on (source_id, keyword, order_by, published_within): a re-collect of
-- the same keyword with the same sort/recency replaces the snapshot rather
-- than appending duplicates.
--
-- The `youtube` source row is already seeded by 20260817000009_seed_sources.sql
-- (kind 'platform'), so no sources insert is needed here.

create table public.youtube_signals (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources (id) on delete restrict,
  keyword text not null,
  result_limit integer not null default 25,
  order_by text not null default 'relevance',
  published_within text not null default 'any',
  video_count integer not null default 0 check (video_count >= 0),
  total_views numeric not null default 0 check (total_views >= 0),
  total_likes integer not null default 0 check (total_likes >= 0),
  total_comments integer not null default 0 check (total_comments >= 0),
  avg_views numeric,
  channel_count integer not null default 0 check (channel_count >= 0),
  top_video_id text,
  top_video_title text,
  top_channel text,
  captured_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint youtube_signals_result_limit_check check (result_limit between 1 and 50),
  constraint youtube_signals_order_by_check
    check (order_by in ('relevance', 'date', 'rating', 'viewCount')),
  constraint youtube_signals_published_within_check
    check (published_within in ('any', 'hour', 'day', 'week', 'month', 'year'))
);

create index youtube_signals_keyword_idx on public.youtube_signals (keyword);
create index youtube_signals_captured_idx on public.youtube_signals (captured_at);
create index youtube_signals_metadata_gin on public.youtube_signals using gin (metadata);

-- One snapshot per source/keyword/sort/recency: a re-collect replaces the
-- value.
create unique index youtube_signals_dedup_uidx
  on public.youtube_signals (source_id, keyword, order_by, published_within);

create trigger youtube_signals_set_updated_at
  before update on public.youtube_signals
  for each row execute function public.set_updated_at();

alter table public.youtube_signals enable row level security;
