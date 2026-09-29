-- Issue #71 · Migration chain, step 52: the released v0.9.0 database, and nothing after it
--
-- Runs against a database reset to `20261002000100_imprest_raised_approval` — the 51st and last
-- released migration, which is what hosted Supabase holds today. The phase then builds the v0.8.0
-- phase's ground (steps 11 to 49) and raised approvals (step 53), so the reversal migration meets a
-- database carrying every kind of record production can hold.
--
-- It pins, exactly, what the reversal migration replaces or drops. The preservation query leaves
-- them out of its digests, so their released form is required here and their replacement in step
-- 54:
--
--   `private.check_imprest_verification_target`     a correction is checked against its request
--   `private.check_imprest_verification_complete`   a verification counts its originals only
--   `private.imprest_spending_figures`              a reversal gives back what it cancels
--   `imprest_postings_verification_id_kind_key`     dropped for a partial index on originals
--   `posting_loss_shape`                            a reversal of a loss waits for nothing
--
-- Function bodies are hashed with carriage returns removed, so a Windows checkout agrees with the
-- bytes the hosted database was given.

begin;

do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 51
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261002000100' then
    raise exception
      'the database is not at the v0.9.0 boundary: expected 51 migrations ending at 20261002000100. '
      'Reset to version 20261002000100 before running this fixture';
  end if;

  if to_regclass('public.imprest_approval_raises') is null
     or to_regprocedure('private.imprest_approved_tzs(uuid)') is null then
    raise exception 'the database is not at the v0.9.0 boundary: raised approvals are missing';
  end if;

  if to_regclass('public.imprest_posting_reversals') is not null
     or to_regtype('public.imprest_posting_entry') is not null
     or to_regprocedure('api.staff_request_imprest_reversal(uuid,bigint,text,text)') is not null then
    raise exception
      'the database is already past v0.9.0: reversal objects exist. Reset to version '
      '20261002000100 before running this fixture, or it proves nothing';
  end if;

  if (select string_agg(p.oid::regprocedure::text || '=' || md5(replace(p.prosrc, E'\r', '')), ','
                        order by p.oid::regprocedure::text)
        from pg_proc p
       where p.oid in ('private.check_imprest_verification_target()'::regprocedure,
                       'private.check_imprest_verification_complete()'::regprocedure,
                       'private.imprest_spending_figures(uuid)'::regprocedure))
     is distinct from
       'private.check_imprest_verification_complete()=c44efcaccafa870e5b9758152acbd116,'
       'private.check_imprest_verification_target()=28a6da0d625f9e8e131d941fe6c93a14,'
       'private.imprest_spending_figures(uuid)=59d377ee65f8621a7002f70af91c873d' then
    raise exception 'the released posting functions are not the v0.9.0 ones';
  end if;

  if (select string_agg(conname || '=' || pg_get_constraintdef(oid), ',' order by conname)
        from pg_constraint
       where conrelid = 'public.imprest_postings'::regclass
         and conname in ('imprest_postings_verification_id_kind_key', 'posting_loss_shape'))
     is distinct from
       'imprest_postings_verification_id_kind_key=UNIQUE (verification_id, kind),'
       'posting_loss_shape=CHECK ((((kind = ''unexplained_loss''::imprest_posting_kind) = '
       'needs_director_decision) AND ((kind = ''expense''::imprest_posting_kind) OR (amount_tzs > 0))))' then
    raise exception 'the released posting constraints are not the v0.9.0 ones';
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20261002000100');

commit;

\echo 'migration-chain: the database is the released v0.9.0 shape'
