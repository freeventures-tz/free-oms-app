-- Issue #82 · The daily report states the imprest position truthfully
--
-- The claims under test, each traceable to issue #82's acceptance criteria:
--
--   1   The imprest section reads what the fund released: the day's verified expenses with their
--       reversals and replacements, the unexplained losses, the posted balance, set aside, Free to
--       approve, Awaiting verification and expected cash, all as at the report's cutoff. They agree
--       with the figures the imprest screen reads.
--   2   The count's state is Not counted, Awaiting Manager confirmation, Balanced, Shortage or
--       Excess, as the count stood at the cutoff. A confirmed day no longer reads Not counted.
--   3   A day with no count is Not counted with null amounts and a null variance, never a zero.
--   4   "imprest_spending_not_built" is no longer written. A report already stored is unchanged.
--   5   Rebuilding a day gives the same content, whatever happened after its cutoff: later
--       postings, a later confirmation, a later retirement and a newer fund.
--   6   The section's reader is private: no Data API role may execute it.

create extension if not exists pgtap with schema extensions;

begin;
select * from no_plan();

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

select tests.mk_user('e8200000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e8200000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e8200000-0000-0000-0000-000000000004'::uuid);  -- Cashier

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e8200000-0000-0000-0000-000000000001', 'Report Director', '+255700082001', true, false),
  ('e8200000-0000-0000-0000-000000000003', 'Report Manager',  '+255700082003', true, false),
  ('e8200000-0000-0000-0000-000000000004', 'Report Cashier',  '+255700082004', true, false);

insert into public.user_roles (user_id, role) values
  ('e8200000-0000-0000-0000-000000000001', 'director'),
  ('e8200000-0000-0000-0000-000000000003', 'manager'),
  ('e8200000-0000-0000-0000-000000000004', 'cashier');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('e8200000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e8200000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('e8200000-0000-0000-0000-000000000004'::uuid); $$;

create temp table r (name text primary key, res jsonb not null);
grant all on r to public;
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) returning res ->> 'reason';
$$;
create or replace function tests.did(p_name text) returns uuid language sql as $$
  select (res -> 'disbursement' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.cid(p_name text) returns uuid language sql as $$
  select (res -> 'count' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.sid(p_id uuid) returns uuid language sql security definer as $$
  select id from public.imprest_settlements where disbursement_id = p_id order by cycle desc limit 1; $$;
create or replace function tests.pid(p_id uuid, p_kind text) returns uuid language sql
  security definer as $$
  select id from public.imprest_postings
   where disbursement_id = p_id and kind::text = p_kind and entry = 'original'; $$;
create or replace function tests.line(p_amount bigint, p_purpose text) returns jsonb language sql as $$
  select jsonb_build_object('amount_tzs', p_amount, 'purpose', p_purpose, 'receipt_id', null,
                            'no_receipt_reason', 'transport_fare', 'no_receipt_note', null); $$;

-- The report's imprest section for a day, and the day the tests are run on.
create or replace function tests.imprest(p_date date) returns jsonb language sql as $$
  select private.report_content(p_date) -> 'sections' -> 'imprest'; $$;
create or replace function tests.d() returns date language sql as $$
  select private.business_date(); $$;
-- What the imprest screen reads now: posted / set aside / free to approve / awaiting verification.
create or replace function tests.screen() returns text language sql security definer as $$
  select s.posted_balance_tzs || '/' || s.set_aside_tzs || '/' || s.free_to_approve_tzs || '/'
         || private.imprest_awaiting_verification_tzs(f.id)
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active; $$;
create or replace function tests.position(p_date date) returns text language sql as $$
  select (p ->> 'posted_tzs') || '/' || (p ->> 'set_aside_tzs') || '/' || (p ->> 'available_tzs')
         || '/' || (p ->> 'awaiting_verification_tzs')
    from (select tests.imprest(p_date) -> 'position' as p) x; $$;

-- ---------------------------------------------------------------------------
-- 6 · The reader is private
-- ---------------------------------------------------------------------------
select ok(
  to_regprocedure('private.report_imprest_section(date)') is not null
  and not has_function_privilege('authenticated', 'private.report_imprest_section(date)', 'execute')
  and not has_function_privilege('anon', 'private.report_imprest_section(date)', 'execute')
  and not has_function_privilege('service_role', 'private.report_imprest_section(date)', 'execute')
  and not has_function_privilege('authenticated', 'private.report_content(date)', 'execute'),
  'the imprest section has its own private reader, and no Data API role may execute it');

-- ---------------------------------------------------------------------------
-- 3 · Before any fund: nothing to report, and nothing written as zero
-- ---------------------------------------------------------------------------
select is(tests.imprest(date '2020-01-01') ->> 'state', 'no_fund',
          'a day before any fund opened has no fund');
select is(tests.imprest(date '2020-01-01') -> 'unavailable',
          '{"approved_expenses": "no_imprest_fund", "position": "no_imprest_fund"}'::jsonb,
          'its expenses and balance are withheld because there is no fund, not because spending is missing');
select ok(
  tests.imprest(date '2020-01-01') -> 'reconciliation' ->> 'state' = 'not_counted'
  and (tests.imprest(date '2020-01-01') -> 'reconciliation' -> 'counted_tzs') = 'null'::jsonb
  and (tests.imprest(date '2020-01-01') -> 'reconciliation' -> 'variance_tzs') = 'null'::jsonb
  and tests.imprest(date '2020-01-01') -> 'reconciliation' ->> 'missing_reason' = 'no_imprest_fund',
  'and the count is Not counted with null amounts');

-- ---------------------------------------------------------------------------
-- The day: 100,000 posted; a trip of 10,000 settled as Used 8,000, Returned 1,500 and verified, its
-- expense reversed to 6,000; an errand of 5,000 handed out; a levy of 3,000 approved; and the count
-- 300 short, confirmed as a counting error.
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
insert into public.imprest_funds (id, opened_by) values
  ('e8200000-0000-0000-0000-00000000f001', 'e8200000-0000-0000-0000-000000000003');
insert into public.imprest_fundings (id, funding_no, fund_id, requested_amount_tzs, reason,
                                     requested_by)
values ('e8200000-0000-0000-0000-00000000f101', 'FV-IMP-TEST-8201',
        'e8200000-0000-0000-0000-00000000f001', 100000, 'Opening float',
        'e8200000-0000-0000-0000-000000000003');
insert into public.imprest_funding_handovers (id, funding_id, cycle, amount_tzs, provided_by)
values ('e8200000-0000-0000-0000-00000000f201', 'e8200000-0000-0000-0000-00000000f101', 1, 100000,
        'e8200000-0000-0000-0000-000000000001');
update public.imprest_fundings
   set status = 'received', version = version + 1,
       received_handover_id = 'e8200000-0000-0000-0000-00000000f201',
       received_amount_tzs = 100000, received_by = 'e8200000-0000-0000-0000-000000000003',
       received_at = now()
 where id = 'e8200000-0000-0000-0000-00000000f101';
reset role;

select tests.cashier();
select tests.keep('trip', api.staff_propose_imprest_disbursement(
  10000, 'transport_and_delivery', 'Trip allowance', 'r82-p-trip'));
select tests.keep('errand', api.staff_propose_imprest_disbursement(
  5000, 'transport_and_delivery', 'Errand to town', 'r82-p-errand'));
select tests.keep('levy', api.staff_propose_imprest_disbursement(
  3000, 'fees_and_charges', 'Council levy', 'r82-p-levy'));
select tests.manager();
select tests.keep('a-trip', api.staff_decide_imprest_disbursement(tests.did('trip'), 1, true, null, 'r82-a-trip'));
select tests.keep('a-errand', api.staff_decide_imprest_disbursement(tests.did('errand'), 1, true, null, 'r82-a-errand'));
select tests.keep('a-levy', api.staff_decide_imprest_disbursement(tests.did('levy'), 1, true, null, 'r82-a-levy'));
select tests.cashier();
select tests.keep('h-trip', api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, 'Juma', 'r82-h-trip'));
select tests.keep('h-errand', api.staff_hand_out_imprest_disbursement(tests.did('errand'), 2, 'Asha', 'r82-h-errand'));
select tests.keep('s-trip', api.staff_settle_imprest_disbursement(
  tests.did('trip'), 3, jsonb_build_array(tests.line(8000, 'Fare')), 1500,
  'Change lost on the road', 'r82-s-trip'));
select tests.manager();
select is(tests.keep('v-trip', api.staff_verify_imprest_disbursement(
            tests.did('trip'), 4, tests.sid(tests.did('trip')), 'r82-v-trip')),
          'verified', 'the trip is verified: an 8,000 expense and a 500 loss post');

select tests.cashier();
select is(api.staff_request_imprest_reversal(tests.pid(tests.did('trip'), 'expense'), 6000,
                                             'The receipt says 6,000', 'r82-rq') ->> 'reason',
          'requested', 'the Cashier asks for the expense to be corrected to 6,000');
select tests.director();
select is(api.admin_decide_imprest_reversal(
            (select id from public.imprest_posting_reversals
              where posting_id = tests.pid(tests.did('trip'), 'expense')),
            1, true, null, 'r82-dc') ->> 'reason',
          'approved', 'and a Director approves it: the reversal and the replacement post');

select is(tests.screen(), '93500/8000/85500/5000',
          'the imprest screen reads 93,500 posted, 8,000 set aside and 5,000 out');

-- 2 · Before anyone counts, today is Not counted in the report: there is no record to find.
select ok(
  tests.imprest(tests.d()) -> 'reconciliation' ->> 'state' = 'not_counted'
  and (tests.imprest(tests.d()) -> 'reconciliation' -> 'counted_tzs') = 'null'::jsonb
  and (tests.imprest(tests.d()) -> 'reconciliation' -> 'expected_tzs') = 'null'::jsonb
  and (tests.imprest(tests.d()) -> 'reconciliation' -> 'variance_tzs') = 'null'::jsonb
  and tests.imprest(tests.d()) -> 'reconciliation' ->> 'missing_reason' = 'no_reconciliation_record',
  'with no count, the count is Not counted with null amounts and a null variance, never a zero');

select tests.cashier();
select is(tests.keep('c1', api.staff_enter_imprest_count(tests.d(), null, 88200, null, null, 'r82-c1')),
          'counted', 'the Cashier counts 88,200 against 88,500 expected');

select ok(
  tests.imprest(tests.d()) -> 'reconciliation' ->> 'state' = 'awaiting_manager_confirmation'
  and (tests.imprest(tests.d()) -> 'reconciliation' ->> 'counted_tzs')::bigint = 88200
  and (tests.imprest(tests.d()) -> 'reconciliation' ->> 'expected_tzs')::bigint = 88500
  and (tests.imprest(tests.d()) -> 'reconciliation' ->> 'variance_tzs')::bigint = -300
  and (tests.imprest(tests.d()) -> 'reconciliation' -> 'missing_reason') = 'null'::jsonb,
  'an unconfirmed count is Awaiting Manager confirmation, with what was counted and expected');

select tests.manager();
select is(api.staff_confirm_imprest_count(tests.cid('c1'), 1, 'counting_error', null, 'r82-k1') ->> 'reason',
          'confirmed', 'the Manager confirms it short, as a counting error');

-- ---------------------------------------------------------------------------
-- 1 and 2 · The confirmed day, as the report states it
-- ---------------------------------------------------------------------------
select is(tests.imprest(tests.d()) ->> 'state', 'active', 'the fund is reported as active');
select is((tests.imprest(tests.d()) ->> 'fund_id')::uuid, 'e8200000-0000-0000-0000-00000000f001'::uuid,
          'and by its real identity');
select ok(not (tests.imprest(tests.d()) ? 'unavailable'),
          'nothing in the section is withheld any more');
select ok(position('imprest_spending_not_built' in private.report_content(tests.d())::text) = 0,
          'and "imprest spending is not in the system" is written nowhere in a new report');

select is(tests.imprest(tests.d()) -> 'reconciliation',
          '{"state": "shortage", "counted_tzs": 88200, "expected_tzs": 88500, "variance_tzs": -300,
            "variance_reason": "counting_error", "missing_reason": null}'::jsonb,
          'a confirmed short count reads Shortage, with its figures and its reason');

select is(tests.imprest(tests.d()) -> 'approved_expenses',
          '{"count": 1, "amount_tzs": 8000, "reversed_tzs": 8000, "replacement_tzs": 6000,
            "net_tzs": 6000, "unexplained_loss_tzs": 500}'::jsonb,
          'the day''s expenses: one verified at 8,000, reversed and posted again at 6,000, and a loss of 500');

select is(tests.screen(), '93200/8000/85200/5000', 'the screen now reads 93,200 posted after the shortage');
select is(tests.position(tests.d()), tests.screen(),
          'and the report''s balance, set aside, Free to approve and Awaiting verification match it');
select is((tests.imprest(tests.d()) -> 'position' ->> 'expected_cash_tzs')::bigint, 88200::bigint,
          'expected cash is the posted balance less what is awaiting verification');
select is(tests.imprest(tests.d()) -> 'position' ->> 'as_at', 'cutoff',
          'and the balance says it is as at the end of the business day');

-- ---------------------------------------------------------------------------
-- 5 · As at the cutoff: what happens after midnight does not reach the day
-- ---------------------------------------------------------------------------
create temp table before_cutoff as select private.report_content(tests.d()) as content;
grant all on before_cutoff to public;

select is(private.report_content(tests.d()), (select content from before_cutoff),
          'rebuilding the day gives the same content');

-- The errand is settled and verified, and both are placed just after midnight.
select tests.cashier();
select tests.keep('s-errand', api.staff_settle_imprest_disbursement(
  tests.did('errand'), 3, jsonb_build_array(tests.line(5000, 'Bus fare')), 0, null, 'r82-s-errand'));
select tests.manager();
select is(tests.keep('v-errand', api.staff_verify_imprest_disbursement(
            tests.did('errand'), 4, tests.sid(tests.did('errand')), 'r82-v-errand')),
          'verified', 'the errand is verified');
set local session_replication_role = replica;
update public.imprest_settlements
   set settled_at = private.imprest_business_day_close(tests.d()) + interval '1 minute'
 where disbursement_id = tests.did('errand');
update public.imprest_verifications
   set verified_at = private.imprest_business_day_close(tests.d()) + interval '2 minutes'
 where disbursement_id = tests.did('errand');
update public.imprest_postings
   set posted_at = private.imprest_business_day_close(tests.d()) + interval '2 minutes'
 where disbursement_id = tests.did('errand');
set local session_replication_role = origin;

select is(private.report_content(tests.d()), (select content from before_cutoff),
          'a verification after midnight leaves the day''s expenses, balance and expected cash as they were');
select is((tests.imprest(tests.d() + 1) -> 'approved_expenses' ->> 'amount_tzs')::bigint, 5000::bigint,
          'and belongs to the next day''s report');
select is(tests.imprest(tests.d() + 1) -> 'reconciliation' ->> 'state', 'not_counted',
          'where nobody has counted yet');

-- A confirmation after midnight: at the cutoff the count was still waiting for the Manager.
set local session_replication_role = replica;
update public.imprest_count_confirmations
   set confirmed_at = private.imprest_business_day_close(tests.d()) + interval '5 minutes'
 where count_id = tests.cid('c1');
update public.imprest_count_postings
   set posted_at = private.imprest_business_day_close(tests.d()) + interval '5 minutes'
 where count_id = tests.cid('c1');
set local session_replication_role = origin;

select is(tests.imprest(tests.d()) -> 'reconciliation' ->> 'state', 'awaiting_manager_confirmation',
          'a count confirmed after midnight was Awaiting Manager confirmation at the cutoff');
select is((tests.imprest(tests.d()) -> 'position' ->> 'posted_tzs')::bigint, 93500::bigint,
          'and its shortage was not yet posted');
select is(tests.imprest(tests.d() + 1) -> 'reconciliation' ->> 'state', 'not_counted',
          'the confirmation does not move the count to the next day');

-- Put the confirmation back where it really was, for what follows.
set local session_replication_role = replica;
update public.imprest_count_confirmations set confirmed_at = now() where count_id = tests.cid('c1');
update public.imprest_count_postings set posted_at = now() where count_id = tests.cid('c1');
set local session_replication_role = origin;

-- A count sent back with no recount before the close: Not counted, and the reason says so.
-- Written below the triggers, as the late-count tests in 023 place a count in the past.
set local session_replication_role = replica;
update public.imprest_funds set opened_at = private.imprest_business_day_close(tests.d() - 2)
 where id = 'e8200000-0000-0000-0000-00000000f001';
insert into public.imprest_counts (id, fund_id, business_date, attempt, counted_tzs,
                                   posted_balance_tzs, awaiting_verification_tzs, expected_tzs,
                                   status, version, counted_by, counted_at)
values ('e8200000-0000-0000-0000-00000000c002', 'e8200000-0000-0000-0000-00000000f001',
        tests.d() - 1, 1, 90000, 100000, 0, 100000, 'sent_back', 2,
        'e8200000-0000-0000-0000-000000000004',
        private.imprest_business_day_close(tests.d() - 1) - interval '3 hours');
insert into public.imprest_count_returns (count_id, reason, returned_by, returned_at)
values ('e8200000-0000-0000-0000-00000000c002', 'Count again', 'e8200000-0000-0000-0000-000000000003',
        private.imprest_business_day_close(tests.d() - 1) - interval '2 hours');
set local session_replication_role = origin;

select is(tests.imprest(tests.d() - 1) -> 'reconciliation',
          '{"state": "not_counted", "counted_tzs": null, "expected_tzs": null, "variance_tzs": null,
            "variance_reason": null, "missing_reason": "count_sent_back"}'::jsonb,
          'a count sent back and never recounted leaves the day Not counted, with null amounts');

-- A later retirement and a newer fund do not move a day already reported.
create temp table after_errand as select private.report_content(tests.d()) as content;
grant all on after_errand to public;
set local session_replication_role = replica;
update public.imprest_funds
   set is_active = false, retired_at = private.imprest_business_day_close(tests.d()) + interval '3 hours'
 where id = 'e8200000-0000-0000-0000-00000000f001';
insert into public.imprest_funds (id, opened_by, opened_at) values
  ('e8200000-0000-0000-0000-00000000f002', 'e8200000-0000-0000-0000-000000000003',
   private.imprest_business_day_close(tests.d()) + interval '3 hours');
set local session_replication_role = origin;

select is(private.report_content(tests.d()), (select content from after_errand),
          'a fund retired after the day, with a new one opened, leaves the day''s report as it was');
select is((tests.imprest(tests.d() + 2) ->> 'fund_id')::uuid, 'e8200000-0000-0000-0000-00000000f002'::uuid,
          'and the days after it read the new fund');
select is((tests.imprest(tests.d() + 2) -> 'position' ->> 'posted_tzs')::bigint, 0::bigint,
          'which starts from nothing posted');

-- The retirement happens ON the day instead: approved an hour before midnight, with today's count
-- as its closing count, and the new fund receives 7,000 half an hour later. The day still reads the
-- retiring fund's balance and count, and its funding line carries the new fund's receipt too, which
-- no other day's report could show.
set local session_replication_role = replica;
update public.imprest_funds
   set retired_at = private.imprest_business_day_close(tests.d()) - interval '1 hour'
 where id = 'e8200000-0000-0000-0000-00000000f001';
update public.imprest_funds
   set opened_at = private.imprest_business_day_close(tests.d()) - interval '1 hour'
 where id = 'e8200000-0000-0000-0000-00000000f002';
insert into public.imprest_retirements (fund_id, status, reason, count_id, business_date,
                                        posted_funding_tzs, closing_balance_tzs, submitted_by,
                                        submitted_at, decided_by, decided_at, next_fund_id)
values ('e8200000-0000-0000-0000-00000000f001', 'approved', 'Month end', tests.cid('c1'), tests.d(),
        100000, 88200, 'e8200000-0000-0000-0000-000000000003',
        private.imprest_business_day_close(tests.d()) - interval '2 hours',
        'e8200000-0000-0000-0000-000000000001',
        private.imprest_business_day_close(tests.d()) - interval '1 hour',
        'e8200000-0000-0000-0000-00000000f002');
insert into public.imprest_fundings (id, funding_no, fund_id, requested_amount_tzs, reason,
                                     requested_by, requested_at)
values ('e8200000-0000-0000-0000-00000000f102', 'FV-IMP-TEST-8202',
        'e8200000-0000-0000-0000-00000000f002', 7000, 'First float',
        'e8200000-0000-0000-0000-000000000003',
        private.imprest_business_day_close(tests.d()) - interval '45 minutes');
insert into public.imprest_funding_handovers (id, funding_id, cycle, amount_tzs, provided_by, provided_at)
values ('e8200000-0000-0000-0000-00000000f202', 'e8200000-0000-0000-0000-00000000f102', 1, 7000,
        'e8200000-0000-0000-0000-000000000001',
        private.imprest_business_day_close(tests.d()) - interval '40 minutes');
update public.imprest_fundings
   set status = 'received', version = version + 1,
       received_handover_id = 'e8200000-0000-0000-0000-00000000f202',
       received_amount_tzs = 7000, received_by = 'e8200000-0000-0000-0000-000000000003',
       received_at = private.imprest_business_day_close(tests.d()) - interval '30 minutes'
 where id = 'e8200000-0000-0000-0000-00000000f102';
set local session_replication_role = origin;

select is((tests.imprest(tests.d()) ->> 'fund_id')::uuid, 'e8200000-0000-0000-0000-00000000f001'::uuid,
          'on the retirement day the report reads the retiring fund, whose closing count it was');
select is(tests.imprest(tests.d()) -> 'reconciliation' ->> 'state', 'shortage',
          'with that count');
select is((tests.imprest(tests.d()) -> 'funding' ->> 'received_tzs')::bigint, 107000::bigint,
          'and the day''s receipts include the new fund''s 7,000 received the same evening');
select is((tests.imprest(tests.d()) -> 'funding' ->> 'requested_count')::int, 2,
          'as do its requests');
select is((tests.imprest(tests.d() + 1) ->> 'fund_id')::uuid, 'e8200000-0000-0000-0000-00000000f002'::uuid,
          'and the next day belongs to the new fund');
select is((tests.imprest(tests.d() + 1) -> 'funding' ->> 'received_tzs')::bigint, 0::bigint,
          'which does not count the 7,000 a second time');

select * from finish();
rollback;
