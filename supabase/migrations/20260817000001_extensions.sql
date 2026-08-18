-- P0.2 - Foundation extensions and shared helpers.
-- Idempotent: safe to re-run.
create extension if not exists pg_trgm;

-- Shared trigger: keeps updated_at current on any UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
