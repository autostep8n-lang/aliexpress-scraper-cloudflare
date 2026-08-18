-- P0.2 - Suppliers and the product-supplier link table.
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.sources (id) on delete set null,
  external_id text,
  name text not null,
  url text,
  country char(2),
  location text,
  rating numeric(3,2) check (rating >= 0 and rating <= 5),
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index suppliers_source_external_uidx
  on public.suppliers (source_id, external_id)
  where source_id is not null and external_id is not null;

create trigger suppliers_set_updated_at
  before update on public.suppliers
  for each row execute function public.set_updated_at();

-- Links a supplier to a product. A supplier may have a role per product
-- (seller, manufacturer, ...). is_primary marks the primary supplier.
create table public.product_suppliers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  product_source_id uuid references public.product_sources (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete cascade,
  role text not null default 'seller'
    check (role in ('seller', 'manufacturer', 'dropshipper', 'brand_owner')),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_suppliers_product_role_uidx unique (product_id, supplier_id, role)
);

create index product_suppliers_supplier_idx on public.product_suppliers (supplier_id);
create index product_suppliers_product_source_idx on public.product_suppliers (product_source_id);
create index product_suppliers_primary_idx on public.product_suppliers (product_id) where is_primary;

create trigger product_suppliers_set_updated_at
  before update on public.product_suppliers
  for each row execute function public.set_updated_at();
