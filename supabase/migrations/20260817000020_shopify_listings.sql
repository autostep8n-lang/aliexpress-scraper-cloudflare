-- P8.33 - Shopify listings.
--
-- Persistent mapping from a unified product to a draft Shopify product on one
-- shop. One row per (shop_domain x product_id); a re-export refreshes the
-- stored GIDs, payload, and `exported_at` instead of appending duplicates.
-- Shopify create/update is a manual POST and never runs from cron.
--
-- Success writes `status = draft` because V1 only ever sends ProductStatus
-- DRAFT. `payload` stores the GraphQL input snapshot (no secrets). `last_error`
-- is reserved for structured failures and must never contain tokens.
--
-- Unique `(shop_domain, shopify_product_id)` is non-partial so a GID cannot be
-- claimed twice on the same shop; NULL GIDs remain distinct per PostgreSQL.
--
-- Non-destructive: this migration only creates new objects.

create table public.shopify_listings (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  shop_domain text not null,
  shopify_product_id text,
  shopify_variant_id text,
  status text not null default 'draft'
    check (status in ('draft', 'exported', 'error')),
  dedup_key text not null,
  title text not null,
  payload jsonb not null default '{}'::jsonb,
  last_error jsonb,
  exported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Non-partial unique index so PostgREST can infer the ON CONFLICT target for
-- `upsert(..., { onConflict: "shop_domain,product_id" })`.
create unique index shopify_listings_shop_product_uidx
  on public.shopify_listings (shop_domain, product_id);

create unique index shopify_listings_shop_shopify_product_uidx
  on public.shopify_listings (shop_domain, shopify_product_id);

create index shopify_listings_product_idx
  on public.shopify_listings (product_id);

create index shopify_listings_shop_idx
  on public.shopify_listings (shop_domain);

create index shopify_listings_status_idx
  on public.shopify_listings (status);

create trigger shopify_listings_set_updated_at
  before update on public.shopify_listings
  for each row execute function public.set_updated_at();

alter table public.shopify_listings enable row level security;
