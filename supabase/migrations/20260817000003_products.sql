-- P0.2 - Unified product identity.
-- One row = one logical product across all platforms. dedup_key is the
-- normalized fingerprint used by the future matching/deduplication pipeline;
-- it is nullable and only unique when present so ingestion can run before
-- matching is complete. Products are NEVER duplicated just because the same
-- product appears on multiple sources: those live in product_sources.
create table public.products (
  id uuid primary key default gen_random_uuid(),
  dedup_key text,
  canonical_url text,
  title text not null,
  description text,
  brand text,
  category_id uuid references public.product_categories (id) on delete set null,
  primary_image_url text,
  images jsonb not null default '[]'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  availability_status text not null default 'unknown'
    check (availability_status in ('in_stock', 'out_of_stock', 'preorder', 'discontinued', 'unknown')),
  lifecycle_status text not null default 'discovered'
    check (lifecycle_status in ('discovered', 'active', 'tracking', 'inactive', 'archived')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index products_dedup_key_uidx on public.products (dedup_key) where dedup_key is not null;
create index products_category_idx on public.products (category_id);
create index products_lifecycle_idx on public.products (lifecycle_status);
create index products_last_seen_idx on public.products (last_seen_at);
create index products_attributes_gin on public.products using gin (attributes);
create index products_title_trgm_gin on public.products using gin (title gin_trgm_ops);

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();
