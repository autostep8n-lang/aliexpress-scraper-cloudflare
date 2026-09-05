-- P0.2 - Make products.dedup_key a PostgREST ON CONFLICT inference target.
--
-- 20260817000003 created a PARTIAL unique index:
--   CREATE UNIQUE INDEX products_dedup_key_uidx ON public.products (dedup_key)
--   WHERE dedup_key IS NOT NULL;
-- PostgreSQL (and therefore PostgREST) cannot infer ON CONFLICT (dedup_key)
-- from a partial unique index. The Worker upserts with
--   .upsert(row, { onConflict: "dedup_key" })
-- which emits ON CONFLICT (dedup_key) and fails with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- A UNIQUE constraint (non-partial unique index) is the required inference
-- target. NULL keys remain allowed: PostgreSQL UNIQUE treats NULLs as distinct.
-- Non-null uniqueness is unchanged. The partial index is dropped as redundant.

alter table public.products
  add constraint products_dedup_key_key unique (dedup_key);

drop index if exists public.products_dedup_key_uidx;
