-- P3.4 - Instagram market intelligence.
--
-- Aggregate keyword-level signals derived from Instagram Graph API hashtag
-- media. Each row is one snapshot for one keyword (hashtag, unique media
-- count, engagement totals, top media as metadata). Keyed on (source_id,
-- keyword): a re-collect of the same keyword replaces the snapshot rather than
-- appending duplicates.
--
-- The `instagram` source row is already seeded by 20260817000009_seed_sources.sql
-- (kind 'platform'), so no sources insert is needed here.

create table public.instagram_signals (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources (id) on delete restrict,
  keyword text not null,
  hashtag text not null,
  result_limit integer not null default 25,
  media_count integer not null default 0 check (media_count >= 0),
  top_media_count integer not null default 0 check (top_media_count >= 0),
  recent_media_count integer not null default 0 check (recent_media_count >= 0),
  total_likes integer not null default 0 check (total_likes >= 0),
  total_comments integer not null default 0 check (total_comments >= 0),
  total_engagement integer not null default 0 check (total_engagement >= 0),
  avg_likes numeric,
  avg_engagement numeric,
  top_media_id text,
  top_media_caption text,
  captured_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instagram_signals_result_limit_check check (result_limit between 1 and 50)
);

create index instagram_signals_keyword_idx on public.instagram_signals (keyword);
create index instagram_signals_hashtag_idx on public.instagram_signals (hashtag);
create index instagram_signals_captured_idx on public.instagram_signals (captured_at);
create index instagram_signals_metadata_gin on public.instagram_signals using gin (metadata);

-- One snapshot per source/keyword: a re-collect replaces the value.
create unique index instagram_signals_dedup_uidx
  on public.instagram_signals (source_id, keyword);

create trigger instagram_signals_set_updated_at
  before update on public.instagram_signals
  for each row execute function public.set_updated_at();

alter table public.instagram_signals enable row level security;
