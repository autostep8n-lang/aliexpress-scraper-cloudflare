-- P0.2 - Jobs (recurring pipeline work) and job_runs (executions).
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  job_type text not null default 'other'
    check (job_type in ('scrape', 'enrich', 'dedup', 'compute_metrics', 'score', 'trend_snapshot', 'sync', 'other')),
  source_id uuid references public.sources (id) on delete set null,
  schedule text,
  params jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jobs_enabled_idx on public.jobs (enabled);
create index jobs_source_idx on public.jobs (source_id);

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

create table public.job_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  triggered_by text not null default 'manual'
    check (triggered_by in ('manual', 'schedule', 'api')),
  started_at timestamptz,
  finished_at timestamptz,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error jsonb,
  items_processed integer not null default 0 check (items_processed >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index job_runs_job_idx on public.job_runs (job_id);
create index job_runs_status_idx on public.job_runs (status);
create index job_runs_started_idx on public.job_runs (started_at);

create trigger job_runs_set_updated_at
  before update on public.job_runs
  for each row execute function public.set_updated_at();
