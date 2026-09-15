-- P7.30 - Idempotency target for the generic `scores` table.
--
-- P7.30 persists `competition` / `market_opportunity` rows and re-runs daily, so
-- the generic `scores` table needs a PostgREST ON CONFLICT inference target.
-- The chosen key is (product_id, score_type, version): a re-score of the same
-- product/score/version updates the existing row (value, inputs, computed_at)
-- instead of appending duplicate history.
--
-- A plain `alter table ... add constraint` would abort the whole migration if
-- duplicate groups already existed, without explaining which rows are at fault.
-- The guard below inspects the table first and, when duplicates are present,
-- raises a descriptive error identifying how many groups/rows are affected.
-- It never deletes or rewrites historical data: an operator resolves the
-- duplicates deliberately and re-runs the migration.
do $$
declare
  duplicate_groups integer;
  duplicate_rows integer;
begin
  select count(*) into duplicate_groups
  from (
    select 1
    from public.scores
    group by product_id, score_type, version
    having count(*) > 1
  ) grouped;

  if duplicate_groups > 0 then
    select count(*) into duplicate_rows
    from public.scores s
    where exists (
      select 1
      from public.scores d
      where d.product_id = s.product_id
        and d.score_type = s.score_type
        and d.version = s.version
        and d.id <> s.id
    );

    raise exception
      'P7.30 cannot add scores_product_type_version_key: % duplicate (product_id, score_type, version) group(s) covering % row(s) already exist. Resolve the duplicates manually, then re-run this migration; no rows were modified.',
      duplicate_groups, duplicate_rows;
  end if;
end
$$;

alter table public.scores
  add constraint scores_product_type_version_key unique (product_id, score_type, version);
