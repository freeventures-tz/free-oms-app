-- Issue #68 · Imprest daily count, part 1: the Cashier counts, the Manager confirms, the variance posts
--
-- The claims under test, each traceable to issue #68's acceptance criteria:
--
--   1   Only a live Cashier enters a count, for the current business day, as whole shillings of 0 or
--       more, with an optional note. Version-checked against the day's latest count, idempotent; a
--       changed retry is a conflict.
--   2   The count stores expected cash, posted balance and awaiting verification as they stood when
--       it was entered, so its variance never shifts afterwards.
--   3   Only a live Manager confirms it or sends it back with a reason of 3 to 500 characters. A
--       sent-back count stays on the record and the Cashier counts again. Directors read.
--   4   Balanced, Shortage and Excess are distinct outcomes; a shortage or excess needs a preset
--       explanation, and three of them need a written note.
--   5   Confirming a shortage or excess posts it, append-only. The posted balance, Free to approve and
--       expected cash include count postings. A shortage waits for a Director's decision.
--   6   Confirming a non-zero variance raises a flag that Directors read.
--   7   Every success and committed refusal is on the audit trail.

create extension if not exists pgtap with schema extensions;

begin;
select plan(119);

create schema if not exists tests;
grant usage on schema tests to public;

create or replace function tests.mk_user(p_id uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_id::text || '@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
          now(), now());
end $$;

create or replace function tests.acting_as(p_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_id::text, 'role', 'authenticated')::text, true);
$$;

select tests.mk_user('e6800000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e6800000-0000-0000-0000-000000000002'::uuid);  -- Director B
select tests.mk_user('e6800000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e6800000-0000-0000-0000-000000000004'::uuid);  -- Cashier
select tests.mk_user('e6800000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('e6800000-0000-0000-0000-000000000006'::uuid);  -- Disabled Cashier

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e6800000-0000-0000-0000-000000000001', 'Count Director',   '+255700006801', true,  false),
  ('e6800000-0000-0000-0000-000000000002', 'Count Director B', '+255700006802', true,  false),
  ('e6800000-0000-0000-0000-000000000003', 'Count Manager',    '+255700006803', true,  false),
  ('e6800000-0000-0000-0000-000000000004', 'Count Cashier',    '+255700006804', true,  false),
  ('e6800000-0000-0000-0000-000000000005', 'Count Rep',        '+255700006805', true,  false),
  ('e6800000-0000-0000-0000-000000000006', 'Gone Cashier',     '+255700006806', false, false);

insert into public.user_roles (user_id, role) values
  ('e6800000-0000-0000-0000-000000000001', 'director'),
  ('e6800000-0000-0000-0000-000000000002', 'director'),
  ('e6800000-0000-0000-0000-000000000003', 'manager'),
  ('e6800000-0000-0000-0000-000000000004', 'cashier'),
  ('e6800000-0000-0000-0000-000000000005', 'sales_rep'),
  ('e6800000-0000-0000-0000-000000000006', 'cashier');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('e6800000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.director_b() returns void language sql as $$
  select tests.acting_as('e6800000-0000-0000-0000-000000000002'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e6800000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('e6800000-0000-0000-0000-000000000004'::uuid); $$;
create or replace function tests.rep() returns void language sql as $$
  select tests.acting_as('e6800000-0000-0000-0000-000000000005'::uuid); $$;
create or replace function tests.gone() returns void language sql as $$
  select tests.acting_as('e6800000-0000-0000-0000-000000000006'::uuid); $$;

create temp table r (name text primary key, res jsonb not null);
grant all on r to public;
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) returning res ->> 'reason';
$$;
create or replace function tests.did(p_name text) returns uuid language sql as $$
  select (res -> 'disbursement' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.cid(p_name text) returns uuid language sql as $$
  select (res -> 'count' ->> 'id')::uuid from r where name = p_name; $$;
-- Today as the business clock reads it; `tests.end_day` below moves it on.
create or replace function tests.today() returns date language plpgsql as $$
begin
  return (now() at time zone 'Africa/Dar_es_Salaam')::date + (select days from clock);
end $$;
create or replace function tests.count_row(p_id uuid) returns public.imprest_counts
language sql security definer as $$ select * from public.imprest_counts where id = p_id; $$;
-- posted balance / set aside / free to approve / awaiting verification
create or replace function tests.figures() returns text language sql security definer as $$
  select s.posted_balance_tzs || '/' || s.set_aside_tzs || '/' || s.free_to_approve_tzs || '/'
         || private.imprest_awaiting_verification_tzs(f.id)
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active; $$;
create or replace function tests.enter(p_previous uuid, p_counted bigint, p_note text, p_key text,
                                       p_date date default null) returns jsonb
language sql as $$
  select api.staff_enter_imprest_count(coalesce(p_date, tests.today()), p_previous, p_counted,
                                       p_note, p_key); $$;
create or replace function tests.confirm(p_id uuid, p_version integer, p_explanation text,
                                         p_note text, p_key text) returns text
language sql as $$
  select api.staff_confirm_imprest_count(p_id, p_version, p_explanation, p_note, p_key) ->> 'reason'; $$;
create or replace function tests.send_back(p_id uuid, p_version integer, p_reason text, p_key text)
returns text language sql as $$
  select api.staff_send_back_imprest_count(p_id, p_version, p_reason, p_key) ->> 'reason'; $$;
-- Ends the day: the business clock moves one day on, so today can be counted again. The function is
-- replaced inside this transaction only, as its owner, and rolled back with everything else.
create temp table clock (days integer not null);
insert into clock values (0);
grant all on clock to public;
create or replace function tests.end_day() returns void language plpgsql as $$
declare v_days integer;
begin
  update clock set days = days + 1 returning days into v_days;
  set local role fv_definer_owner;
  execute format($f$
    create or replace function private.imprest_business_date() returns date language sql stable
    set search_path = '' as $b$ select (now() at time zone 'Africa/Dar_es_Salaam')::date + %s $b$
  $f$, v_days);
  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- The shape: append-only tables no client writes, three commands, one read
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(not has_table_privilege('authenticated', t, 'insert')
                   and not has_table_privilege('authenticated', t, 'update')
                   and not has_table_privilege('authenticated', t, 'delete')
                   and has_any_column_privilege('authenticated', t, 'select')
                   and not has_table_privilege('anon', t, 'select')
                   and not has_table_privilege('service_role', t, 'select')
                   and not has_table_privilege('service_role', t, 'insert')
                   and not has_table_privilege('fv_definer_owner', t, 'delete'))
     from unnest(array['public.imprest_counts', 'public.imprest_count_confirmations',
                       'public.imprest_count_returns', 'public.imprest_count_postings',
                       'public.imprest_count_flags']) t),
  'no client writes a count record; anon and the service role read none');

select ok(
  (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.imprest_counts'::regclass, 'public.imprest_count_confirmations'::regclass,
                  'public.imprest_count_returns'::regclass, 'public.imprest_count_postings'::regclass,
                  'public.imprest_count_flags'::regclass)),
  'every count table has row-level security');

select ok(
  not has_table_privilege('fv_definer_owner', 'public.imprest_count_confirmations', 'update')
  and not has_table_privilege('fv_definer_owner', 'public.imprest_count_returns', 'update')
  and not has_table_privilege('fv_definer_owner', 'public.imprest_count_postings', 'update')
  and not has_table_privilege('fv_definer_owner', 'public.imprest_count_flags', 'update'),
  'confirmations, returns, postings and flags are never updated, even by their owner');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join pg_roles o on o.oid = p.proowner
    where n.nspname = 'api'
      and p.proname in ('staff_enter_imprest_count', 'staff_confirm_imprest_count',
                        'staff_send_back_imprest_count', 'staff_imprest_counts')
      and p.prosecdef and o.rolname = 'fv_definer_owner'
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')),
  4,
  'the count commands and read are security definer, owned by fv_definer_owner, for staff sessions only');

select ok(
  not exists (select 1 from information_schema.parameters
               where specific_schema = 'api'
                 and (specific_name like 'staff_enter_imprest_count%'
                      or specific_name like 'staff_confirm_imprest_count%'
                      or specific_name like 'staff_send_back_imprest_count%')
                 and (parameter_name like '%expected_tzs%' or parameter_name like '%variance%'
                      or parameter_name like '%balance%' or parameter_name like '%awaiting%'
                      or (specific_name not like 'staff_enter%' and parameter_name like '%tzs%'))),
  'expected cash and the variance are calculated, never typed; only the count takes an amount');

select is(
  (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum
    where enumtypid = 'public.imprest_count_explanation'::regtype),
  'counting_error,recording_error,change_not_returned,amount_correction,suspected_loss_or_theft,'
  || 'under_investigation,other',
  'the seven variance reasons of design.md §14.7');

-- ---------------------------------------------------------------------------
-- No fund, no count
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(tests.keep('no-fund', tests.enter(null, 1000, null, 'c-no-fund')), 'no_fund',
          'there is nothing to count before a fund is opened');

-- ---------------------------------------------------------------------------
-- TZS 200,000 posted, built directly as its owner would. A 60,000 trip is handed out.
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
insert into public.imprest_funds (id, opened_by) values
  ('e6800000-0000-0000-0000-00000000f001', 'e6800000-0000-0000-0000-000000000003');
insert into public.imprest_fundings (id, funding_no, fund_id, requested_amount_tzs, reason,
                                     requested_by)
values ('e6800000-0000-0000-0000-00000000f101', 'FV-IMP-TEST-6801',
        'e6800000-0000-0000-0000-00000000f001', 200000, 'Opening float',
        'e6800000-0000-0000-0000-000000000003');
insert into public.imprest_funding_handovers (id, funding_id, cycle, amount_tzs, provided_by)
values ('e6800000-0000-0000-0000-00000000f201', 'e6800000-0000-0000-0000-00000000f101', 1, 200000,
        'e6800000-0000-0000-0000-000000000001');
update public.imprest_fundings
   set status = 'received', version = version + 1,
       received_handover_id = 'e6800000-0000-0000-0000-00000000f201',
       received_amount_tzs = 200000, received_by = 'e6800000-0000-0000-0000-000000000003',
       received_at = now()
 where id = 'e6800000-0000-0000-0000-00000000f101';
reset role;

select tests.cashier();
select tests.keep('trip', api.staff_propose_imprest_disbursement(
  60000, 'transport_and_delivery', 'Trip allowance, Dar to Kibaha', 'p-trip'));
select tests.manager();
select tests.keep('a-trip', api.staff_decide_imprest_disbursement(tests.did('trip'), 1, true, null, 'a-trip'));
select tests.cashier();
select tests.keep('h-trip', api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, 'Juma', 'h-trip'));
select is(tests.figures(), '200000/60000/140000/60000',
          'posted 200,000, the trip set aside and out: the tin should hold 140,000');

-- ---------------------------------------------------------------------------
-- 1 · Only the Cashier counts, for today, in whole shillings of 0 or more
-- ---------------------------------------------------------------------------
select tests.director();
select throws_ok($$ select tests.enter(null, 140000, null, 'c-dir') $$, '42501', null,
                 'a Director cannot enter a count');
select tests.manager();
select throws_ok($$ select tests.enter(null, 140000, null, 'c-mgr') $$, '42501', null,
                 'the Manager cannot enter a count');
select tests.rep();
select throws_ok($$ select tests.enter(null, 140000, null, 'c-rep') $$, '42501', null,
                 'a Sales Representative cannot enter a count');
select tests.gone();
select throws_ok($$ select tests.enter(null, 140000, null, 'c-gone') $$, '42501', null,
                 'a disabled Cashier cannot enter a count');

select tests.cashier();
select is(tests.keep('c-yesterday', tests.enter(null, 140000, null, 'c-yesterday', tests.today() - 1)),
          'day_changed', 'a count is for today only: a screen left open overnight is refused');
select is((select res ->> 'business_date' from r where name = 'c-yesterday'), tests.today()::text,
          'and the refusal names the business day it is now');
select is(tests.keep('c-neg', tests.enter(null, -1, null, 'c-neg')), 'amount_invalid',
          'a negative count is refused');
select is(tests.keep('c-null', tests.enter(null, null, null, 'c-null')), 'amount_invalid',
          'a missing count is refused');
select is(tests.keep('c-huge', tests.enter(null, 100000001, null, 'c-huge')), 'amount_invalid',
          'a count above TZS 100,000,000 is refused');
select is(tests.keep('c-note', tests.enter(null, 139000, 'ab', 'c-note')), 'note_invalid',
          'a note shorter than 3 characters is refused');
select is((select count(*)::int from public.imprest_counts), 0, 'no refused count was stored');

-- ---------------------------------------------------------------------------
-- 2 · The count keeps the figures as they stood
-- ---------------------------------------------------------------------------
select is(tests.keep('c1', tests.enter(null, 139000, '  Counted twice,  notes and coins ', 'c1')),
          'counted', 'the Cashier counts TZS 139,000');
select is((tests.count_row(tests.cid('c1'))).expected_tzs, 140000::bigint,
          'expected cash is posted balance minus awaiting verification');
select is((tests.count_row(tests.cid('c1'))).posted_balance_tzs, 200000::bigint,
          'the posted balance is kept with the count');
select is((tests.count_row(tests.cid('c1'))).awaiting_verification_tzs, 60000::bigint,
          'awaiting verification is kept with the count');
select is((tests.count_row(tests.cid('c1'))).variance_tzs, -1000::bigint,
          'the variance is counted minus expected');
select is((tests.count_row(tests.cid('c1'))).status::text, 'awaiting_confirmation',
          'the day reads Awaiting Manager confirmation');
select is((tests.count_row(tests.cid('c1'))).business_date, tests.today(), 'for today');
select is((tests.count_row(tests.cid('c1'))).note, 'Counted twice, notes and coins',
          'the note is stored tidied');
select is((tests.count_row(tests.cid('c1'))).attempt, 1, 'the first count of the day');

select is(tests.keep('c1-replay', tests.enter(null, 139000, 'Counted twice, notes and coins', 'c1')),
          'replayed', 'the same request with the same key is a replay');
select is(tests.cid('c1-replay'), tests.cid('c1'), 'and returns the same count');
select is(tests.keep('c1-changed', tests.enter(null, 139500, 'Counted twice, notes and coins', 'c1')),
          'idempotency_key_conflict', 'a changed retry with the same key is a conflict');
select is(tests.keep('c1-again', tests.enter(null, 139000, null, 'c1-again')),
          'count_awaiting_confirmation', 'a second count waits until the first is confirmed or sent back');
select is((select count(*)::int from public.imprest_counts), 1, 'still one count');

-- The trip is settled: 50,000 used, 10,000 back in the tin. The count does not move.
select tests.keep('s-trip', api.staff_settle_imprest_disbursement(
  tests.did('trip'), 3,
  jsonb_build_array(jsonb_build_object('amount_tzs', 50000, 'purpose', 'Fuel and fare',
                                       'receipt_id', null, 'no_receipt_reason', 'transport_fare',
                                       'no_receipt_note', null)),
  10000, null, 's-trip'));
select is(tests.figures(), '200000/60000/140000/50000', 'the settlement returns 10,000 to the tin');
select is((tests.count_row(tests.cid('c1'))).expected_tzs, 140000::bigint,
          'the count''s expected cash does not shift afterwards');
select is((tests.count_row(tests.cid('c1'))).variance_tzs, -1000::bigint,
          'nor does its variance');

-- ---------------------------------------------------------------------------
-- 3 · Only the Manager confirms or sends back
-- ---------------------------------------------------------------------------
select tests.cashier();
select throws_ok(format($$ select tests.confirm(%L, 1, 'counting_error', null, 'k-c-cash') $$,
                        tests.cid('c1')), '42501', null, 'the Cashier cannot confirm a count');
select throws_ok(format($$ select tests.send_back(%L, 1, 'Count again', 'k-b-cash') $$,
                        tests.cid('c1')), '42501', null, 'the Cashier cannot send a count back');
select tests.director();
select throws_ok(format($$ select tests.confirm(%L, 1, 'counting_error', null, 'k-c-dir') $$,
                        tests.cid('c1')), '42501', null, 'a Director cannot confirm a count');
select throws_ok(format($$ select tests.send_back(%L, 1, 'Count again', 'k-b-dir') $$,
                        tests.cid('c1')), '42501', null, 'a Director cannot send a count back');

select tests.manager();
select is(tests.confirm(tests.cid('c1'), 2, 'counting_error', null, 'k-stale'), 'stale',
          'a version the Manager was not shown is refused');
select is(tests.confirm(gen_random_uuid(), 1, 'counting_error', null, 'k-none'), 'no_count',
          'a count that does not exist is refused');
select is(tests.confirm(tests.cid('c1'), 1, null, null, 'k-no-expl'), 'explanation_required',
          'a shortage needs an explanation');
select is(tests.confirm(tests.cid('c1'), 1, 'bad_luck', null, 'k-bad-expl'), 'explanation_invalid',
          'only a preset explanation');
select is(tests.confirm(tests.cid('c1'), 1, 'other', null, 'k-other'), 'explanation_note_required',
          'Other needs a written note');
select is(tests.confirm(tests.cid('c1'), 1, 'suspected_loss_or_theft', 'ab', 'k-short-note'),
          'explanation_note_required', 'and the note is 3 to 500 characters');
select is(tests.send_back(tests.cid('c1'), 1, 'ab', 'k-b-short'), 'reason_required',
          'sending back needs a reason of 3 to 500 characters');
select is(tests.send_back(tests.cid('c1'), 1, repeat('x', 501), 'k-b-long'), 'reason_required',
          'and no longer than 500');

select is(tests.send_back(tests.cid('c1'), 1, 'Coins were not counted, count the tin again', 'k-b1'),
          'sent_back', 'the Manager sends the count back for a recount');
select is(tests.send_back(tests.cid('c1'), 1, 'Coins were not counted, count the tin again', 'k-b1'),
          'replayed', 'a send-back retried with its key is a replay');
select is((tests.count_row(tests.cid('c1'))).status::text, 'sent_back', 'the count reads sent back');
select is((select reason from public.imprest_count_returns where count_id = tests.cid('c1')),
          'Coins were not counted, count the tin again', 'the reason stays on the record');
select is(tests.confirm(tests.cid('c1'), 2, 'counting_error', null, 'k-late'),
          'not_awaiting_confirmation', 'a sent-back count can no longer be confirmed');

select tests.cashier();
select is(tests.keep('c2-stale', tests.enter(null, 149000, null, 'c2-stale')), 'stale',
          'a recount must name the count it replaces');
select is(tests.keep('c2', tests.enter(tests.cid('c1'), 149000, null, 'c2')), 'counted',
          'the Cashier counts again: TZS 149,000');
select is((tests.count_row(tests.cid('c2'))).attempt, 2, 'as the day''s second count');
select is((tests.count_row(tests.cid('c2'))).expected_tzs, 150000::bigint,
          'against expected cash as it stands now');
select is((tests.count_row(tests.cid('c1'))).variance_tzs, -1000::bigint,
          'the first count stays on the record, unchanged');

-- ---------------------------------------------------------------------------
-- 4, 5, 6 · A confirmed shortage posts, waits for a Director, and raises a flag
-- ---------------------------------------------------------------------------
select tests.manager();
select is(tests.confirm(tests.cid('c2'), 1, 'counting_error', null, 'k-c2'), 'confirmed',
          'the Manager confirms a shortage of 1,000 with a preset explanation');
-- The commit-time check runs as the Manager's own session, who may not read the Directors' flag.
set local role authenticated;
select lives_ok($$ set constraints all immediate $$,
                'the confirmation is complete at commit, checked as the Manager who made it');
set constraints all deferred;
reset role;
select is(tests.confirm(tests.cid('c2'), 1, 'counting_error', null, 'k-c2'), 'replayed',
          'a confirmation retried with its key is a replay');
select is(tests.confirm(tests.cid('c2'), 1, 'recording_error', null, 'k-c2'),
          'idempotency_key_conflict', 'a changed confirmation with the same key is a conflict');
select is((tests.count_row(tests.cid('c2'))).status::text, 'confirmed', 'the count is confirmed');
select is((select outcome::text || '/' || variance_tzs || '/' || explanation::text
             from public.imprest_count_confirmations where count_id = tests.cid('c2')),
          'shortage/-1000/counting_error', 'the day ends as a Shortage, with its explanation');
select is((select kind::text || '/' || amount_tzs || '/' || needs_director_decision
             from public.imprest_count_postings where count_id = tests.cid('c2')),
          'count_shortage/1000/true', 'it posts as a count shortage waiting for a Director''s decision');
select is(tests.figures(), '199000/60000/139000/50000',
          'the posted balance and Free to approve fall by the shortage');
select is((select s.posted_balance_tzs - private.imprest_awaiting_verification_tzs(f.id)
             from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
            where f.is_active), 149000::bigint,
          'expected cash now matches the tin, so the gap is not reported again tomorrow');
select is((select kind::text || '/' || amount_tzs || '/' || business_date
             from public.imprest_count_flags where count_id = tests.cid('c2')),
          'count_shortage/1000/' || tests.today(), 'a flag is raised the moment it is confirmed');

select tests.cashier();
select is(tests.keep('c3', tests.enter(tests.cid('c2'), 149000, null, 'c3')), 'already_confirmed',
          'a confirmed day takes no more counts');

-- Who reads what, under row-level security
set local role authenticated;
select tests.director();
select is((select count(*)::int from public.imprest_count_flags), 1, 'a Director reads the flag');
select tests.director_b();
select is((select count(*)::int from public.imprest_count_flags), 1, 'so does the other Director');
select is((select count(*)::int from public.imprest_counts), 2, 'Directors read every count');
select tests.cashier();
select throws_ok($$ select posted_balance_tzs from public.imprest_counts $$, '42501', null,
                 'the Cashier cannot read the posted balance kept with a count, even directly');
select throws_ok($$ select awaiting_verification_tzs from public.imprest_counts $$, '42501', null,
                 'nor awaiting verification');
select is((select count(*)::int from public.imprest_counts where expected_tzs > 0), 2,
          'the Cashier reads the counts themselves, with expected cash');
select is((select count(*)::int from public.imprest_count_flags), 0, 'the Cashier reads no flag');
select is((select count(*)::int from public.imprest_count_postings), 0,
          'nor the posting, which changes the posted balance the Cashier is not shown');
select is((select count(*)::int from api.staff_imprest_counts(30, 0)), 2,
          'the Cashier reads the day''s counts through the read');
select is((select count(*)::int from api.staff_imprest_counts(30, 0)
            where posted_balance_tzs is not null or awaiting_verification_tzs is not null), 0,
          'without the posted balance or awaiting verification behind expected cash');
select tests.rep();
select is((select count(*)::int from public.imprest_counts), 0, 'a Sales Representative reads none');
select throws_ok($$ select * from api.staff_imprest_counts(30, 0) $$, '42501', null,
                 'nor through the read');
select tests.director();
select is((select string_agg(status || ':' || coalesce(outcome, '-') || ':' || variance_tzs, ','
                             order by counted_at desc, attempt desc)
             from api.staff_imprest_counts(30, 0)),
          'confirmed:shortage:-1000,sent_back:-:-1000', 'most recent first, each with its variance');
select is((select posted_balance_tzs from api.staff_imprest_counts(30, 0) where attempt = 2),
          200000::bigint, 'Directors see the posted balance kept with the count');
select is((select return_reason from api.staff_imprest_counts(30, 0) where attempt = 1),
          'Coins were not counted, count the tin again', 'and the send-back reason');

-- ---------------------------------------------------------------------------
-- The next day: an excess posts and raises its flag; a balanced day posts nothing
-- ---------------------------------------------------------------------------
select tests.end_day();
select tests.cashier();
select is(tests.keep('d2', tests.enter(null, 149500, null, 'd2')), 'counted',
          'the next day the Cashier counts TZS 149,500');
select is((tests.count_row(tests.cid('d2'))).variance_tzs, 500::bigint, 'an excess of 500');
select tests.manager();
select is(tests.confirm(tests.cid('d2'), 1, null, null, 'k-d2-none'), 'explanation_required',
          'an excess needs an explanation too');
select is(tests.confirm(tests.cid('d2'), 1, 'change_not_returned', 'Driver''s change came back late',
                        'k-d2'), 'confirmed', 'the Manager confirms the excess');
select is((select outcome::text from public.imprest_count_confirmations where count_id = tests.cid('d2')),
          'excess', 'the day ends as an Excess');
select is((select kind::text || '/' || amount_tzs || '/' || needs_director_decision
             from public.imprest_count_postings where count_id = tests.cid('d2')),
          'count_excess/500/false', 'it posts as a count excess');
select is(tests.figures(), '199500/60000/139500/50000', 'which raises the posted balance');
select is((select count(*)::int from public.imprest_count_flags), 2, 'and raises its own flag');

select tests.end_day();
select tests.cashier();
select is(tests.keep('d3', tests.enter(null, 149500, null, 'd3')), 'counted',
          'the third day counts exactly the expected cash');
select tests.manager();
select is(tests.confirm(tests.cid('d3'), 1, 'counting_error', null, 'k-d3-expl'),
          'explanation_not_needed', 'a balanced day takes no explanation');
select is(tests.confirm(tests.cid('d3'), 1, null, null, 'k-d3'), 'confirmed',
          'the Manager confirms a balanced day');
select is((select outcome::text from public.imprest_count_confirmations where count_id = tests.cid('d3')),
          'balanced', 'it ends Balanced');
select is((select count(*)::int from public.imprest_count_postings where count_id = tests.cid('d3')), 0,
          'a balanced day posts nothing');
select is((select count(*)::int from public.imprest_count_flags), 2, 'and raises no flag');

-- A zero count is a count, not a missing one.
select tests.end_day();
select tests.cashier();
select is(tests.keep('d4', tests.enter(null, 0, 'The tin is empty', 'd4')), 'counted',
          'a count of zero is accepted');
select is((tests.count_row(tests.cid('d4'))).variance_tzs, -149500::bigint,
          'and its whole expected cash is a shortage');

-- ---------------------------------------------------------------------------
-- Append-only, whoever writes
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
select throws_ok(format($$ update public.imprest_counts set counted_tzs = 150000 where id = %L $$,
                        tests.cid('c2')), '23001', null, 'a count''s figures never change');
select throws_ok(format($$ update public.imprest_counts set status = 'awaiting_confirmation',
                            version = version + 1 where id = %L $$, tests.cid('c2')),
                 '23001', null, 'a confirmed count never goes back');
select throws_ok(format($$ update public.imprest_counts set status = 'confirmed',
                            version = version + 1 where id = %L $$, tests.cid('d4')),
                 '23001', null, 'a count is confirmed only with a confirmation');
select throws_ok(format($$ insert into public.imprest_count_postings (count_id, confirmation_id,
                            fund_id, kind, amount_tzs, needs_director_decision)
                            select count_id, id, 'e6800000-0000-0000-0000-00000000f001',
                                   'count_shortage', 999, true
                              from public.imprest_count_confirmations where count_id = %L $$,
                        tests.cid('d3')),
                 '23514', null, 'a posting is exactly its count''s variance');
select throws_ok(format($$ insert into public.imprest_counts (fund_id, business_date, attempt,
                            counted_tzs, posted_balance_tzs, awaiting_verification_tzs,
                            expected_tzs, counted_by)
                            values ('e6800000-0000-0000-0000-00000000f001', %L, 9, 1, 1, 0, 1,
                                    'e6800000-0000-0000-0000-000000000004') $$, tests.today()),
                 '23514', null, 'a count carries the figures as they stand, not invented ones');
reset role;
select throws_ok(format($$ delete from public.imprest_count_confirmations where count_id = %L $$,
                        tests.cid('c2')), '23001', null, 'a confirmation is never deleted');
set constraints all immediate;
select throws_ok($$ truncate public.imprest_count_postings $$, '23001', null,
                 'the postings are never truncated');
set constraints all deferred;

-- ---------------------------------------------------------------------------
-- One count waiting in the whole fund: yesterday's blocks today's until the Manager decides it
-- ---------------------------------------------------------------------------
select tests.end_day();
select tests.cashier();
select is(tests.keep('d5-blocked', tests.enter(null, 149500, null, 'd5-blocked')), 'earlier_count_waiting',
          'yesterday''s count still waiting blocks today''s, so one gap can never post twice');
select is((select res ->> 'business_date' from r where name = 'd5-blocked'), (tests.today() - 1)::text,
          'and the refusal names the day that waits');
select tests.manager();
select is(tests.confirm(tests.cid('d4'), 1, 'under_investigation', 'The tin was found open', 'k-d4'),
          'confirmed', 'the Manager confirms yesterday''s count the next day');

-- A figure that moves between the command's read and the entry trigger's re-check is a refusal the
-- Cashier can answer by pressing Enter count again, never a failure. Awaiting verification is made
-- to answer differently on each call, as a hand-out committing in between would.
savepoint moved;
create sequence tests.calls;
grant usage on sequence tests.calls to public;
set local role fv_definer_owner;
create or replace function private.imprest_awaiting_verification_tzs(p_fund_id uuid)
returns bigint language sql volatile security definer set search_path = '' as $$
  select 50000::bigint + nextval('tests.calls') % 2 $$;
reset role;
select tests.cashier();
select is(tests.keep('d5-moved', tests.enter(null, 1000, null, 'd5-key')), 'figures_moved',
          'a count whose figures moved underneath it is refused, not failed');
select is((select count(*)::int from public.imprest_counts where business_date = tests.today()), 0,
          'and nothing was stored');
select ok(not exists (select 1 from public.idempotency_keys where key = 'd5-key'),
          'nor was its key claimed, so pressing Enter count again works');
select ok(exists (select 1 from public.audit_events
                   where entity_type = 'imprest_count' and action = 'command_refused'
                     and after_state ->> 'reason' = 'figures_moved'),
          'the refusal is on the audit trail');
rollback to savepoint moved;
select tests.cashier();
select is(tests.keep('d5', tests.enter(null, 1000, null, 'd5-key')), 'counted',
          'the same request with the same key then counts');

-- ---------------------------------------------------------------------------
-- 7 · The audit trail
-- ---------------------------------------------------------------------------
select is((select string_agg(action, ',' order by occurred_at, action) from (
             select distinct action, min(occurred_at) over (partition by action) as occurred_at
               from public.audit_events
              where entity_type = 'imprest_count' and action <> 'command_refused') a),
          'imprest_count_confirmed,imprest_count_entered,imprest_count_sent_back',
          'entering, sending back and confirming are each recorded');
select ok(exists (select 1 from public.audit_events
                   where entity_type = 'imprest_count' and action = 'imprest_count_confirmed'
                     and entity_id = tests.cid('c2')
                     and actor_id = 'e6800000-0000-0000-0000-000000000003' and actor_role = 'manager'
                     and correlation_id is not null
                     and after_state ->> 'outcome' = 'shortage'
                     and (after_state ->> 'variance_tzs')::bigint = -1000
                     and after_state ->> 'explanation' = 'counting_error'),
          'the confirmation names its actor, live role, outcome, variance and explanation');
select ok(exists (select 1 from public.audit_events
                   where entity_type = 'imprest_count' and action = 'command_refused'
                     and source_operation = 'api.staff_enter_imprest_count'
                     and after_state ->> 'reason' = 'day_changed'
                     and actor_role = 'cashier'),
          'a refused count is recorded with its reason');
select ok(exists (select 1 from public.audit_events
                   where entity_type = 'imprest_count' and action = 'command_refused'
                     and source_operation = 'api.staff_confirm_imprest_count'
                     and entity_id = tests.cid('c1')
                     and after_state ->> 'reason' = 'explanation_required'
                     and actor_role = 'manager'),
          'a refused confirmation is recorded against its count');

select * from finish();
rollback;
