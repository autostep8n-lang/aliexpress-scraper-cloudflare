-- P0.2 - Row Level Security.
-- All tables are admin-only: the Cloudflare Worker writes via the service-role
-- key (which bypasses RLS). With RLS enabled and NO policies granted, the
-- anon and authenticated roles cannot read or write any row, so public/client
-- access can never bypass RLS. Add granular policies only when a public-facing
-- read (or authenticated role) is introduced.

alter table public.sources enable row level security;
alter table public.product_categories enable row level security;
alter table public.products enable row level security;
alter table public.product_sources enable row level security;
alter table public.suppliers enable row level security;
alter table public.product_suppliers enable row level security;
alter table public.jobs enable row level security;
alter table public.job_runs enable row level security;
alter table public.metrics enable row level security;
alter table public.trend_history enable row level security;
alter table public.scores enable row level security;
