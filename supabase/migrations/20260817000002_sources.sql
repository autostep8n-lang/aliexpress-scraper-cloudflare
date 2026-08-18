-- P0.2 - Sources (platform registry) and category taxonomy.
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  kind text not null default 'platform'
    check (kind in ('platform', 'manual', 'api', 'other')),
  base_url text,
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sources_enabled_idx on public.sources (enabled);

create trigger sources_set_updated_at
  before update on public.sources
  for each row execute function public.set_updated_at();

-- Category taxonomy. A category may be source-specific (source_id + external_id)
-- or a unified/curated category (source_id null). parent_id builds the tree.
create table public.product_categories (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.product_categories (id) on delete set null,
  source_id uuid references public.sources (id) on delete set null,
  external_id text,
  name text not null,
  slug text,
  path text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_id)
);

create index product_categories_parent_idx on public.product_categories (parent_id);
create index product_categories_path_gin on public.product_categories using gin (path);

create trigger product_categories_set_updated_at
  before update on public.product_categories
  for each row execute function public.set_updated_at();
