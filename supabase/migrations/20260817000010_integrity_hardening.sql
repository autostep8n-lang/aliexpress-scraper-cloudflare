-- P0.2 - Integrity hardening (corrective migration).
--
-- Addresses review findings on the P0.2 foundation schema. This migration
-- runs AFTER 20260817000001..09 and does not modify existing migration files.
-- No tables or rows are removed; the only DROP statements replace a redundant
-- non-unique index and rebuild FK constraints with RESTRICT.

-- ============================================================================
-- 1. Enforce product <-> observation consistency for child tables.
--    If product_source_id is set, the referenced observation MUST belong to
--    the same product (and, on tables that carry source_id, its source must
--    match the observation's source). Applies to metrics, trend_history,
--    scores and product_suppliers.
-- ============================================================================
create or replace function public.assert_product_source_consistency()
returns trigger
language plpgsql
as $$
declare
  v_product_id uuid;
  v_source_id uuid;
begin
  if new.product_source_id is not null then
    select ps.product_id, ps.source_id
      into v_product_id, v_source_id
      from public.product_sources ps
     where ps.id = new.product_source_id;

    if not found then
      raise exception 'product_source_id % does not exist', new.product_source_id;
    end if;

    if new.product_id is distinct from v_product_id then
      raise exception
        'product_source_id % belongs to product %, not product %',
        new.product_source_id, v_product_id, new.product_id;
    end if;

    if tg_table_name in ('metrics', 'trend_history')
       and new.source_id is not null
       and new.source_id is distinct from v_source_id then
      raise exception
        'source_id % does not match source % of product_source_id %',
        new.source_id, v_source_id, new.product_source_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger metrics_product_source_consistency
  before insert or update on public.metrics
  for each row execute function public.assert_product_source_consistency();

create trigger trend_history_product_source_consistency
  before insert or update on public.trend_history
  for each row execute function public.assert_product_source_consistency();

create trigger scores_product_source_consistency
  before insert or update on public.scores
  for each row execute function public.assert_product_source_consistency();

create trigger product_suppliers_product_source_consistency
  before insert or update on public.product_suppliers
  for each row execute function public.assert_product_source_consistency();

-- ============================================================================
-- 2. Fix metrics uniqueness when period_start is NULL.
--    A "current" metric (period_start IS NULL) may appear at most once per
--    scope + metric_type. Existing period-based unique indexes are untouched.
-- ============================================================================
create unique index metrics_source_current_unique_idx
  on public.metrics (product_source_id, metric_type)
  where product_source_id is not null and period_start is null;

create unique index metrics_product_current_unique_idx
  on public.metrics (product_id, metric_type)
  where product_source_id is null and period_start is null;

-- ============================================================================
-- 3. At most one primary supplier per product.
--    Replaces the non-unique partial index with a unique one.
-- ============================================================================
drop index if exists public.product_suppliers_primary_idx;

create unique index product_suppliers_primary_uidx
  on public.product_suppliers (product_id)
  where is_primary;

-- ============================================================================
-- 4. Replace CHAR(2)/CHAR(3) with TEXT + CHECK constraints.
--    char(n) pads values with trailing spaces (e.g. 'US '); text avoids this.
-- ============================================================================
alter table public.product_sources
  alter column currency type text using rtrim(currency::text);

alter table public.product_sources
  add constraint product_sources_currency_check
  check (currency ~ '^[A-Z]{3}$');

alter table public.suppliers
  alter column country type text using rtrim(country::text);

alter table public.suppliers
  add constraint suppliers_country_check
  check (country ~ '^[A-Z]{2}$');

-- ============================================================================
-- 5. Define and enforce product-level metric scoping.
--    Product-level rows (product_source_id IS NULL) are aggregates across ALL
--    sources and must therefore have source_id NULL. Observation-level rows
--    carry the source implicitly through product_source_id.
-- ============================================================================
alter table public.metrics
  add constraint metrics_scope_check
  check (product_source_id is not null or source_id is null);

alter table public.trend_history
  add constraint trend_history_scope_check
  check (product_source_id is not null or source_id is null);

-- scores has no source_id column (scope derives from product_source_id only).

-- ============================================================================
-- 6. Additional CHECK constraints.
-- ============================================================================
-- scores.value within its declared bounds when both bounds are present,
-- and bounds must be ordered (min <= max).
alter table public.scores
  add constraint scores_value_range_check
  check (min_value is null or max_value is null or (value between min_value and max_value));

alter table public.scores
  add constraint scores_bounds_order_check
  check (min_value is null or max_value is null or min_value <= max_value);

-- job_runs: finished_at must not precede started_at.
alter table public.job_runs
  add constraint job_runs_time_order_check
  check (started_at is null or finished_at is null or finished_at >= started_at);

-- ============================================================================
-- 7. Prevent silent data loss on source deletion.
--    metrics/trend_history referenced sources with ON DELETE CASCADE; switch to
--    RESTRICT, consistent with product_sources -> sources. (scores has no
--    source_id column, so it is unaffected.)
-- ============================================================================
alter table public.metrics
  drop constraint if exists metrics_source_id_fkey;

alter table public.metrics
  add constraint metrics_source_id_fkey
  foreign key (source_id) references public.sources (id) on delete restrict;

alter table public.trend_history
  drop constraint if exists trend_history_source_id_fkey;

alter table public.trend_history
  add constraint trend_history_source_id_fkey
  foreign key (source_id) references public.sources (id) on delete restrict;
