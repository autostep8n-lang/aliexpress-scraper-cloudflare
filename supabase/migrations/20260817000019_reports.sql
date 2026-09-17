-- P7.32 - Reports.
--
-- Persistent in-Supabase report archive. One row per (report_type x dedup_key);
-- a re-generation for the same period refreshes the payload and `generated_at`
-- instead of appending duplicates, while `created_at` stays fixed at the first
-- write. v1 ships a single report family, `daily_digest`, built deterministically
-- from an already-completed `ScheduledAutomationResult` (discovery -> scoring ->
-- alerts); the report never triggers or recomputes any upstream step.
--
-- The daily digest is keyed by the UTC calendar day (`dedup_key` = YYYY-MM-DD),
-- so every run within the same UTC day upserts the same row. `period_start` /
-- `period_end` pin the covered half-open UTC interval explicitly rather than
-- leaving the reader to infer it from the key.
--
-- `payload` holds the structured per-step summary (discovery, scoring, alerts
-- and an overall status) so failed or partial runs are represented as data,
-- not collapsed into the human-readable `summary`.
--
-- Non-destructive: this migration only creates new objects. No retention policy
-- is applied here; digest rows are kept indefinitely.

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  report_type text not null
    check (report_type in ('daily_digest')),
  dedup_key text not null,
  title text not null,
  summary text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Non-partial unique index so PostgREST can infer the ON CONFLICT target for
-- `upsert(..., { onConflict: "report_type,dedup_key" })`.
create unique index reports_type_dedup_uidx
  on public.reports (report_type, dedup_key);

create index reports_type_idx
  on public.reports (report_type);

create index reports_generated_at_idx
  on public.reports (generated_at desc);

create index reports_payload_gin
  on public.reports using gin (payload);

create trigger reports_set_updated_at
  before update on public.reports
  for each row execute function public.set_updated_at();

alter table public.reports enable row level security;
