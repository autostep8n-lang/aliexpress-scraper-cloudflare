-- P0.2 - Source-specific product observations.
-- One row = one product as observed on one source. external_id is the stable
-- source-specific ID (e.g. AliExpress item ID). (source_id, external_id) is
-- unique so a source observation is never duplicated. Multiple observations
-- (TikTok Shop, Amazon, AliExpress) point at the SAME products.id.
create table public.product_sources (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete restrict,
  external_id text not null,
  external_parent_id text,
  url text not null,
  title text,
  description text,
  brand text,
  category_id uuid references public.product_categories (id) on delete set null,
  image_urls jsonb not null default '[]'::jsonb,
  price numeric(18,4) not null,
  original_price numeric(18,4),
  currency char(3) not null,
  shipping jsonb not null default '{}'::jsonb,
  rating_average numeric(3,2) check (rating_average >= 0 and rating_average <= 5),
  rating_count bigint check (rating_count >= 0),
  reviews_count bigint check (reviews_count >= 0),
  available boolean,
  stock_quantity integer check (stock_quantity >= 0),
  attributes jsonb not null default '{}'::jsonb,
  raw jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_scraped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_sources_source_external_uidx unique (source_id, external_id)
);

create index product_sources_product_idx on public.product_sources (product_id);
create index product_sources_url_idx on public.product_sources (url);
create index product_sources_last_seen_idx on public.product_sources (last_seen_at);
create index product_sources_attributes_gin on public.product_sources using gin (attributes);
create index product_sources_raw_gin on public.product_sources using gin (raw jsonb_path_ops);

create trigger product_sources_set_updated_at
  before update on public.product_sources
  for each row execute function public.set_updated_at();
