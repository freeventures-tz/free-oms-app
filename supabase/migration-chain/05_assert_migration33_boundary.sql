-- v0.0.5 · Migration chain, step 5: the state BETWEEN the two new migrations
--
-- Runs against a database reset to exactly `20260822001100_production` — migration 33 applied, 34
-- not yet. A release applies its migrations before the new application code is serving, and a
-- hosted apply is not instantaneous, so this is a state the real system passes through and can sit
-- in for as long as the deploy takes.
--
-- THE SOURCE THIS RELEASE WAS EXTRACTED FROM CREATED FIVE PUBLIC TABLES HERE AND ENABLED ROW-LEVEL
-- SECURITY IN THE NEXT FILE. Every one of them would have been exposed for the whole of that gap.
-- The correction moved creation, exposure, RLS and grants into one atomic migration, and this file
-- is what proves it rather than asserting it in a comment.
--
-- pgTAP cannot do this: it runs after every migration has already applied, so there is no
-- intermediate state left to look at.

\set ON_ERROR_STOP on

do $$
declare
  v_count integer;
  v_names text;
begin
  -- The right database, or nothing below means anything.
  if to_regclass('public.production_batches') is null then
    raise exception
      'migration 33 has not applied: public.production_batches is missing. Reset to version '
      '20260822001100 before running this check';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api' and p.proname = 'staff_enter_production_batch'
  ) then
    raise exception
      'migration 34 has already applied: this check must run at version 20260822001100 exactly';
  end if;

  -- EVERY new table protected, at this point, not at the next one.
  select string_agg(c.relname, ', ' order by c.relname) into v_names
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname like 'production%' and not c.relrowsecurity;

  if v_names is not null then
    raise exception 'migration 33 left % without row-level security', v_names;
  end if;

  select count(*) into v_count
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'production%';

  if v_count <> 5 then
    raise exception 'expected the five production tables at migration 33, found %', v_count;
  end if;

  -- No client role may write to one, by any privilege, at this point.
  select string_agg(table_name || '/' || grantee || '/' || privilege_type, ', ') into v_names
    from information_schema.table_privileges
   where table_schema = 'public'
     and (table_name like 'production%' or table_name = 'curing_lots')
     and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');

  if v_names is not null then
    raise exception 'migration 33 left a writable production surface: %', v_names;
  end if;

  -- A leaked secret key reaches none of them.
  select string_agg(table_name, ', ') into v_names
    from information_schema.table_privileges
   where table_schema = 'public'
     and (table_name like 'production%' or table_name = 'curing_lots')
     and grantee = 'service_role';

  if v_names is not null then
    raise exception 'service_role holds a privilege on %', v_names;
  end if;

  -- And the view is not a way around any of it.
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'curing_lots'
       and c.reloptions @> array['security_invoker=true']
  ) then
    raise exception 'curing_lots is not a security_invoker view at migration 33';
  end if;

  -- Every reader policy is in place, so the exposure is the intended one rather than none at all.
  select count(*) into v_count
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname like 'production%';

  if v_count <> 15 then
    raise exception 'expected 15 production policies at migration 33, found %', v_count;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The v0.0.4 application is still serving here, so a released command must still work
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values ('c0000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'boundary-director@test.local',
        extensions.crypt('x', extensions.gen_salt('bf')), now(), now());

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password)
values ('c0000000-0000-0000-0000-0000000000aa', 'Boundary Director', '+255700000099', true, false);

insert into public.user_roles (user_id, role)
values ('c0000000-0000-0000-0000-0000000000aa', 'director');

select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-0000000000aa', 'role', 'authenticated')::text,
  false);

do $$
declare v_result jsonb;
begin
  select api.admin_add_supplier('Boundary Hardware', 'boundary-supplier-1') into v_result;

  if coalesce(v_result ->> 'reason', '') <> 'added' then
    raise exception
      'a released command stopped working between the two new migrations: %', v_result;
  end if;
end
$$;

\echo 'migration-chain: migration 33 leaves nothing exposed and the old commands still work'
