-- P3.2 - Reddit market intelligence.
--
-- Aggregate keyword-level signals derived from Reddit search results. Each
-- row is one snapshot for one keyword (mentions, engagement totals, dominant
-- subreddit, top posts as metadata). Keyed on (source_id, keyword): a
-- re-collect of the same keyword replaces the snapshot rather than appending
-- duplicates.

create table public.reddit_signals (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources (id) on delete restrict,
  keyword text not null,
  result_limit integer not null default 25,
  sort text not null default 'relevance',
  time_filter text not null default 'all',
  mentions integer not null default 0 check (mentions >= 0),
  total_score numeric not null default 0 check (total_score >= 0),
  total_comments integer not null default 0 check (total_comments >= 0),
  avg_score numeric,
  subreddit_count integer not null default 0 check (subreddit_count >= 0),
  top_subreddit text,
  captured_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reddit_signals_result_limit_check check (result_limit between 1 and 100),
  constraint reddit_signals_sort_check
    check (sort in ('relevance', 'hot', 'top', 'new', 'comments')),
  constraint reddit_signals_time_filter_check
    check (time_filter in ('hour', 'day', 'week', 'month', 'year', 'all'))
);

create index reddit_signals_keyword_idx on public.reddit_signals (keyword);
create index reddit_signals_captured_idx on public.reddit_signals (captured_at);
create index reddit_signals_metadata_gin on public.reddit_signals using gin (metadata);

-- One snapshot per source/keyword: a re-collect replaces the value.
create unique index reddit_signals_dedup_uidx
  on public.reddit_signals (source_id, keyword);

create trigger reddit_signals_set_updated_at
  before update on public.reddit_signals
  for each row execute function public.set_updated_at();

alter table public.reddit_signals enable row level security;

-- Market-intelligence source row (kind 'api'), idempotent.
insert into public.sources (slug, name, kind, base_url, metadata)
values ('reddit', 'Reddit', 'api', 'https://www.reddit.com', '{"properties":["posts"]}'::jsonb)
on conflict (slug) do nothing;
