-- Issue #83 · The Cashier counts the till and the Manager confirms it
--
-- The claims under test, each traceable to issue #83's acceptance criteria:
--
--   1   Reconciliations are keyed by type and business date. Each line holds the expected figure, a
--       nullable counted figure and a derived variance, and none of the three ever changes.
--   2   The expected figure per payment method is calculated from the day's payments, never typed,
--       and kept as it stood when the count was entered.
--   3   The Cashier enters the count and reads only their own figures; the database refuses more.
--   4   The Manager confirms or sends back, and entering and confirming are separate people.
--   5   A day reads Not counted, Awaiting Manager confirmation, Balanced, Shortage or Excess, and a
--       missing count is null, never zero.
--   6   A variance takes one of the seven reasons; three need a written note.
--   7   A past Not counted day may be counted late, with a reason.
--   8   Concurrent submissions for one day leave one standing count.
--   9   Every success and committed refusal is on the audit trail.
--  10   The released imprest count is untouched.

create extension if not exists pgtap with schema extensions;

begin;
select plan(92);

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

select tests.mk_user('e8300000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e8300000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e8300000-0000-0000-0000-000000000004'::uuid);  -- Cashier
select tests.mk_user('e8300000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('e8300000-0000-0000-0000-000000000006'::uuid);  -- Cashier B

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e8300000-0000-0000-0000-000000000001', 'Till Director',  '+255700008301', true, false),
  ('e8300000-0000-0000-0000-000000000003', 'Till Manager',   '+255700008303', true, false),
  ('e8300000-0000-0000-0000-000000000004', 'Till Cashier',   '+255700008304', true, false),
  ('e8300000-0000-0000-0000-000000000005', 'Till Rep',       '+255700008305', true, false),
  ('e8300000-0000-0000-0000-000000000006', 'Till Cashier B', '+255700008306', true, false);

insert into public.user_roles (user_id, role) values
  ('e8300000-0000-0000-0000-000000000001', 'director'),
  ('e8300000-0000-0000-0000-000000000003', 'manager'),
  ('e8300000-0000-0000-0000-000000000004', 'cashier'),
  ('e8300000-0000-0000-0000-000000000005', 'sales_rep'),
  ('e8300000-0000-0000-0000-000000000006', 'cashier');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('e8300000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e8300000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('e8300000-0000-0000-0000-000000000004'::uuid); $$;
create or replace function tests.rep() returns void language sql as $$
  select tests.acting_as('e8300000-0000-0000-0000-000000000005'::uuid); $$;
create or replace function tests.cashier_b() returns void language sql as $$
  select tests.acting_as('e8300000-0000-0000-0000-000000000006'::uuid); $$;

create temp table r (name text primary key, res jsonb not null);
grant all on r to public;
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) returning res ->> 'reason';
$$;
create or replace function tests.rid(p_name text) returns uuid language sql as $$
  select (res -> 'count' ->> 'id')::uuid from r where name = p_name; $$;

-- The business clock. T is today as it reads now; `tests.end_day` moves it one day on.
create temp table clock (days integer not null);
insert into clock values (0);
grant all on clock to public;
create or replace function tests.t() returns date language plpgsql as $$
begin
  return (now() at time zone 'Africa/Dar_es_Salaam')::date + (select days from clock);
end $$;
create or replace function tests.end_day() returns void language plpgsql as $$
declare v_days integer;
begin
  update clock set days = days + 1 returning days into v_days;
  set local role fv_definer_owner;
  execute format($f$
    create or replace function private.reconciliation_business_date() returns date
    language sql stable set search_path = ''
    as $b$ select (now() at time zone 'Africa/Dar_es_Salaam')::date + %s $b$
  $f$, v_days);
  reset role;
end $$;

-- Six counted figures, in the order the payment methods are listed.
create or replace function tests.counted(p_cash bigint, p_mixx bigint, p_halo bigint,
                                         p_mwanga bigint, p_crdb bigint, p_cheque bigint)
returns jsonb language sql as $$
  select jsonb_build_object('cash', p_cash, 'mixx_by_yas', p_mixx, 'halopesa', p_halo,
                            'mwanga_hakika_transfer', p_mwanga, 'crdb_transfer', p_crdb,
                            'cheque', p_cheque); $$;
create or replace function tests.zeros() returns jsonb language sql as $$
  select tests.counted(0, 0, 0, 0, 0, 0); $$;

create or replace function tests.rec(p_id uuid) returns public.reconciliations
language sql security definer as $$ select * from public.reconciliations where id = p_id; $$;
-- A count's lines as `method:expected/counted/variance`, in method order.
create or replace function tests.lines(p_id uuid) returns text language sql security definer as $$
  select string_agg(l.line || ':' || l.expected_tzs || '/' || coalesce(l.counted_tzs::text, '-')
                    || '/' || coalesce(l.variance_tzs::text, '-'),
                    ',' order by l.line::public.payment_method)
    from public.reconciliation_lines l where l.reconciliation_id = p_id; $$;
create or replace function tests.state(p_day date) returns text language sql security definer as $$
  select d.state from private.till_days() d where d.business_date = p_day; $$;

create or replace function tests.enter(p_day date, p_previous uuid, p_counted jsonb,
                                       p_late text, p_key text) returns jsonb language sql as $$
  select api.staff_enter_till_count(p_day, p_previous, p_counted, null, p_late, p_key); $$;
create or replace function tests.confirm(p_id uuid, p_explanation text, p_note text, p_key text)
returns text language sql as $$
  select api.staff_confirm_till_count(p_id, (tests.rec(p_id)).version, p_explanation, p_note,
                                      p_key) ->> 'reason'; $$;
create or replace function tests.send_back(p_id uuid, p_reason text, p_key text) returns text
language sql as $$
  select api.staff_send_back_till_count(p_id, (tests.rec(p_id)).version, p_reason, p_key)
           ->> 'reason'; $$;

-- The day's payments, written as a Cashier records them: one invoice, money in by method, and a
-- reversal that is a negative row on the day it was approved.
insert into public.customers (id, name)
values ('e8310000-0000-0000-0000-000000000001', 'Till Customer');
insert into public.orders (id, order_no, customer_id, status, is_cash_sale, created_by,
                           created_role, created_at, confirmed_at)
values ('e8320000-0000-0000-0000-000000000001', 'ORD-TILL-1',
        'e8310000-0000-0000-0000-000000000001', 'confirmed', false,
        'e8300000-0000-0000-0000-000000000005', 'sales_rep', now(), now());
insert into public.invoices (id, invoice_no, order_id, customer_id, subtotal_tzs, discount_tzs,
                             total_tzs, business_date, issued_at)
values ('e8330000-0000-0000-0000-000000000001', 'INV-TILL-1',
        'e8320000-0000-0000-0000-000000000001', 'e8310000-0000-0000-0000-000000000001',
        5000000, 0, 5000000, tests.t(), now());

create or replace function tests.pay(p_id uuid, p_day date, p_method text, p_amount bigint,
                                     p_reverses uuid default null) returns void
language sql security definer as $$
  insert into public.payments (id, invoice_id, amount_tzs, method, reverses_id, received_by,
                               received_role, business_date, correlation_id)
  values (p_id, 'e8330000-0000-0000-0000-000000000001', p_amount, p_method::public.payment_method,
          p_reverses, 'e8300000-0000-0000-0000-000000000004', 'cashier', p_day, gen_random_uuid());
$$;

select tests.pay('e8340000-0000-0000-0000-000000000001', tests.t(), 'cash', 150000);
select tests.pay('e8340000-0000-0000-0000-000000000002', tests.t(), 'cash', 50000);
select tests.pay('e8340000-0000-0000-0000-000000000003', tests.t(), 'mixx_by_yas', 30000);
select tests.pay('e8340000-0000-0000-0000-000000000004', tests.t(), 'crdb_transfer', 200000);
select tests.pay('e8340000-0000-0000-0000-000000000005', tests.t(), 'cash', -50000,
                 'e8340000-0000-0000-0000-000000000002');
-- Yesterday's money is yesterday's.
select tests.pay('e8340000-0000-0000-0000-000000000006', tests.t() - 1, 'cash', 999);

-- ---------------------------------------------------------------------------
-- 1. The shape
-- ---------------------------------------------------------------------------
select has_table('public', 'reconciliations', 'reconciliations exist');
select has_table('public', 'reconciliation_lines', 'their lines exist');
select col_is_null('public', 'reconciliation_lines', 'counted_tzs',
                   'a line''s counted figure may be null: missing is never zero');
select col_not_null('public', 'reconciliation_lines', 'expected_tzs',
                    'a line''s expected figure is always there');
select is(
  (select attgenerated::text from pg_attribute
    where attrelid = 'public.reconciliation_lines'::regclass and attname = 'variance_tzs'),
  's', 'a line''s variance is derived, never stored by a command');
select ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'reconciliations'
           and indexdef ilike '%unique%(type, business_date, attempt)%'),
  'reconciliations are keyed by type and business date, with each recount numbered');
select enum_has_labels('public', 'variance_reason',
  array['counting_error', 'recording_error', 'change_not_returned', 'amount_correction',
        'suspected_loss_or_theft', 'under_investigation', 'other'],
  'the seven variance reasons, in design.md order');
select ok(not has_function_privilege('anon', 'api.staff_enter_till_count(date, uuid, jsonb, text, text, text)', 'execute'),
          'a signed-out caller may not enter a count');

-- The business day's edges, in Africa/Dar_es_Salaam and never the server's zone.
select is(private.reconciliation_business_date_of(timestamptz '2026-01-09 20:59:59+00'),
          date '2026-01-09', '23:59:59 in Dar es Salaam is still the 9th');
select is(private.reconciliation_business_date_of(timestamptz '2026-01-09 21:00:00+00'),
          date '2026-01-10', '00:00 in Dar es Salaam is the 10th');

-- ---------------------------------------------------------------------------
-- 2. Expected is calculated from the day's payments, per method
-- ---------------------------------------------------------------------------
select tests.manager();
select is(
  (select string_agg(line || ':' || expected_tzs || '/' || payments, ',' order by line::public.payment_method)
     from api.staff_till_expected(tests.t())),
  'cash:150000/3,mixx_by_yas:30000/1,halopesa:0/0,mwanga_hakika_transfer:0/0,crdb_transfer:200000/1,cheque:0/0',
  'expected per method is the day''s net payments: a reversal takes its money back on the day it '
  'is approved, and yesterday''s payment stays yesterday''s');

select tests.cashier();
select throws_ok($$ select * from api.staff_till_expected(tests.t()) $$, '42501', null,
                 'the Cashier is not shown expected figures before counting');
select tests.rep();
select throws_ok($$ select * from api.staff_till_counts(10, 0) $$, '42501', null,
                 'a Sales Representative reads no till count');

select is(tests.state(tests.t()), 'due', 'today, before anyone counts, is due rather than zero');

-- ---------------------------------------------------------------------------
-- 3. The Cashier enters; the figures are kept as they stood
-- ---------------------------------------------------------------------------
select tests.manager();
select throws_ok($$ select tests.enter(tests.t(), null, tests.zeros(), null, gen_random_uuid()::text) $$,
                 '42501', null, 'a Manager may not enter the count');

select tests.cashier();
select is(tests.keep('missing', tests.enter(tests.t(), null, tests.zeros() - 'cheque', null,
                                            gen_random_uuid()::text)),
          'amount_invalid', 'every payment method must be counted');
select is(tests.keep('negative', tests.enter(tests.t(), null, tests.zeros() || '{"cash": -1}',
                                             null, gen_random_uuid()::text)),
          'amount_invalid', 'a counted figure is 0 or more');
select is(tests.keep('fraction', tests.enter(tests.t(), null, tests.zeros() || '{"cash": 1.5}',
                                             null, gen_random_uuid()::text)),
          'amount_invalid', 'a counted figure is whole shillings');
select is(tests.keep('extra', tests.enter(tests.t(), null, tests.zeros() || '{"credit": 0}',
                                          null, gen_random_uuid()::text)),
          'amount_invalid', 'credit is not a tender and has no line');
select is(tests.keep('late_today', tests.enter(tests.t(), null, tests.zeros(), 'Forgot it',
                                               gen_random_uuid()::text)),
          'late_reason_not_needed', 'today''s count takes no late reason');
select is(tests.keep('tomorrow', tests.enter(tests.t() + 1, null, tests.zeros(), null,
                                             gen_random_uuid()::text)),
          'day_changed', 'tomorrow cannot be counted');

-- A shortage of cash and an excess on CRDB that cancel out: the net is zero, the day is not.
select is(tests.keep('t1', tests.enter(tests.t(), null,
                                       tests.counted(149000, 30000, 0, 0, 201000, 0), null,
                                       'k-t1')),
          'counted', 'the Cashier enters the count');
select is(tests.lines(tests.rid('t1')),
          'cash:150000/149000/-1000,mixx_by_yas:30000/30000/0,halopesa:0/0/0,'
          'mwanga_hakika_transfer:0/0/0,crdb_transfer:200000/201000/1000,cheque:0/0/0',
          'each line keeps the calculated expected figure, the counted figure and the variance');
select is(tests.keep('replay', tests.enter(tests.t(), null,
                                           tests.counted(149000, 30000, 0, 0, 201000, 0), null,
                                           'k-t1')),
          'replayed', 'a retry with the same key replays the count');
select is((select res -> 'count' ->> 'id' from r where name = 'replay')::uuid, tests.rid('t1'),
          'and names the same count');
select is(tests.keep('conflict', tests.enter(tests.t(), null, tests.zeros(), null, 'k-t1')),
          'idempotency_key_conflict', 'the same key with a different count is a conflict');

-- A payment after the count does not move it.
select tests.pay('e8340000-0000-0000-0000-000000000007', tests.t(), 'cash', 10000);
select is(tests.lines(tests.rid('t1')),
          'cash:150000/149000/-1000,mixx_by_yas:30000/30000/0,halopesa:0/0/0,'
          'mwanga_hakika_transfer:0/0/0,crdb_transfer:200000/201000/1000,cheque:0/0/0',
          'the count compares with the expected figure as it stood when entered');

select is(tests.state(tests.t()), 'awaiting_confirmation', 'the day now awaits the Manager');

-- ---------------------------------------------------------------------------
-- 4. Immutable, whoever writes
-- ---------------------------------------------------------------------------
set local role authenticated;
select throws_ok($$ insert into public.reconciliations (type, business_date, attempt, counted_by)
                    values ('till', tests.t(), 9, 'e8300000-0000-0000-0000-000000000004') $$,
                 '42501', null, 'a session may not write a count directly');
reset role;
-- As the tables' owner, past every grant: the trigger still refuses.
select throws_ok(format($$ update public.reconciliation_lines set counted_tzs = 150000
                           where reconciliation_id = %L and line = 'cash' $$, tests.rid('t1')),
                 '23001', null, 'a counted figure never changes, even for the tables'' owner');
select throws_ok(format($$ delete from public.reconciliation_lines where reconciliation_id = %L $$,
                        tests.rid('t1')),
                 '23001', null, 'nor is a line deleted');
set local role fv_definer_owner;
select throws_ok(format($$ update public.reconciliations set business_date = business_date - 1
                           where id = %L $$, tests.rid('t1')),
                 '23001', null, 'nor does a count move to another day');
select throws_ok(format($$ insert into public.reconciliations (type, business_date, attempt,
                                                               counted_by)
                           values ('till', %L, 2, 'e8300000-0000-0000-0000-000000000006') $$,
                        tests.t()),
                 '23514', null, 'a second count cannot stand beside a waiting one');
reset role;

-- ---------------------------------------------------------------------------
-- 5. Concurrent and second submissions leave one standing count
-- ---------------------------------------------------------------------------
select tests.cashier_b();
select is(tests.keep('second', tests.enter(tests.t(), null, tests.zeros(), null,
                                           gen_random_uuid()::text)),
          'count_awaiting_confirmation', 'a second Cashier''s count for the same day is refused');
select is((select count(*)::int from api.staff_till_counts(10, 0)), 0,
          'the second Cashier reads no count they did not enter');
set local role authenticated;
select is((select count(*)::int from public.reconciliations), 0,
          'nor through the table');
select is((select count(*)::int from public.reconciliation_lines), 0,
          'nor any line');
reset role;
select is((select string_agg(business_date::text || ':' || state, ',')
             from api.staff_till_days(10, 0, true)),
          tests.t()::text || ':awaiting_confirmation',
          'but reads where the day stands, with no figures');

select tests.cashier();
select is((select count(*)::int from api.staff_till_counts(10, 0)), 1,
          'the Cashier reads their own count');
select is((select expected_tzs || '/' || counted_tzs || '/' || variance_tzs
             from api.staff_till_counts(10, 0)),
          '380000/380000/0', 'with its expected, counted and variance totals');
set local role authenticated;
select is((select count(*)::int from public.reconciliation_lines), 6,
          'and its six lines through the table');
reset role;

-- ---------------------------------------------------------------------------
-- 6. Send back and recount
-- ---------------------------------------------------------------------------
select tests.cashier();
select throws_ok(format($$ select tests.send_back(%L, 'Count again', 'k-sb-c') $$, tests.rid('t1')),
                 '42501', null, 'the Cashier may not send a count back');
select tests.manager();
select is(tests.send_back(tests.rid('t1'), ' ', 'k-sb0'), 'reason_required',
          'a send-back needs a reason');
select is(tests.send_back(tests.rid('t1'), 'Count the CRDB slips again', 'k-sb1'), 'sent_back',
          'the Manager sends it back');
select is(tests.state(tests.t()), 'due', 'a sent-back count leaves today due, not counted');

-- The Manager's reason is for the Cashier who counted. Another Cashier reads that the count was
-- sent back, and which count a recount replaces, but not why.
select tests.cashier();
select is((select latest_return_reason from api.staff_till_days(1, 0, false)),
          'Count the CRDB slips again', 'the Cashier who counted reads why it was sent back');
select tests.cashier_b();
select ok((select latest_return_reason is null and latest_status = 'sent_back' and latest_id is not null
             from api.staff_till_days(1, 0, false)),
          'another Cashier reads the day and the count to replace, never the reason');
select tests.director();
select is((select latest_return_reason from api.staff_till_days(1, 0, false)),
          'Count the CRDB slips again', 'Directors and the Manager read every reason');

select tests.cashier();
select is(tests.keep('stale', tests.enter(tests.t(), null, tests.zeros(), null,
                                          gen_random_uuid()::text)),
          'stale', 'a recount names the count it replaces');
select is(tests.keep('t2', tests.enter(tests.t(), tests.rid('t1'),
                                       tests.counted(149000, 30000, 0, 0, 201000, 0), null,
                                       'k-t2')),
          'counted', 'the recount is a new record');
select is((tests.rec(tests.rid('t2'))).attempt, 2, 'numbered after the one it replaces');
select is(tests.lines(tests.rid('t2')),
          'cash:160000/149000/-11000,mixx_by_yas:30000/30000/0,halopesa:0/0/0,'
          'mwanga_hakika_transfer:0/0/0,crdb_transfer:200000/201000/1000,cheque:0/0/0',
          'and compared with expected as it stands at its own entry');
select is((tests.rec(tests.rid('t1'))).status::text, 'sent_back', 'the first count stays on the record');

-- ---------------------------------------------------------------------------
-- 7. Confirm: an excess never hides a shortage, and the reasons
-- ---------------------------------------------------------------------------
select tests.director();
select throws_ok(format($$ select tests.confirm(%L, null, null, 'k-c-d') $$, tests.rid('t2')),
                 '42501', null, 'a Director reads and does not confirm');
select tests.manager();
select is(tests.confirm(tests.rid('t2'), null, null, 'k-c0'), 'explanation_required',
          'a variance needs a reason');
select is(tests.confirm(tests.rid('t2'), 'not_a_reason', null, 'k-c1'), 'explanation_invalid',
          'one of the seven');
select is(tests.confirm(tests.rid('t2'), 'other', null, 'k-c2'), 'explanation_note_required',
          'Other needs a written note');
select is(tests.confirm(tests.rid('t2'), 'suspected_loss_or_theft', ' ', 'k-c3'),
          'explanation_note_required', 'Suspected loss or theft needs a written note');
select is(tests.confirm(tests.rid('t2'), 'under_investigation', null, 'k-c4'),
          'explanation_note_required', 'Under investigation needs a written note');
select is(tests.confirm(tests.rid('t2'), 'other', 'CRDB slip filed under cash', 'k-c5'),
          'confirmed', 'the Manager confirms with a reason and a note');
select is(tests.state(tests.t()), 'shortage',
          'cash short and CRDB over is a Shortage: an excess elsewhere never hides missing money');
select is((select outcome::text || '/' || short_tzs || '/' || over_tzs || '/' || variance_tzs
             from public.reconciliation_confirmations
            where reconciliation_id = tests.rid('t2')),
          'shortage/11000/1000/-10000', 'the confirmation keeps what was short and what was over');

select tests.cashier();
select is(tests.keep('again', tests.enter(tests.t(), tests.rid('t2'), tests.zeros(), null,
                                          gen_random_uuid()::text)),
          'already_confirmed', 'a confirmed day takes no more counts');

-- ---------------------------------------------------------------------------
-- 8. Excess and Balanced, on the next two days
-- ---------------------------------------------------------------------------
select tests.end_day();
select tests.pay('e8340000-0000-0000-0000-000000000008', tests.t(), 'halopesa', 5000);
select tests.cashier();
select is(tests.keep('e1', tests.enter(tests.t(), null, tests.counted(0, 0, 6000, 0, 0, 0), null,
                                       gen_random_uuid()::text)),
          'counted', 'the next day is counted');
select tests.manager();
select is(tests.confirm(tests.rid('e1'), 'counting_error', null, 'k-e1'), 'confirmed',
          'a reason without a note is enough for a Counting error');
select is(tests.state(tests.t()), 'excess', 'more than expected and nothing short is an Excess');

select tests.end_day();
select tests.cashier();
select is(tests.keep('b1', tests.enter(tests.t(), null, tests.zeros(), null,
                                       gen_random_uuid()::text)),
          'counted', 'a day with no payments is counted too');
select tests.manager();
select is(tests.confirm(tests.rid('b1'), 'counting_error', null, 'k-b0'), 'explanation_not_needed',
          'a balanced count takes no reason');
select is(tests.confirm(tests.rid('b1'), null, null, 'k-b1'), 'confirmed', 'it is confirmed');
select is(tests.state(tests.t()), 'balanced', 'and reads Balanced');

-- ---------------------------------------------------------------------------
-- 9. Missing is not zero, and a late count
-- ---------------------------------------------------------------------------
select tests.end_day();
select tests.end_day();
select is(tests.state(tests.t() - 1), 'not_counted', 'a day that closed with no count is Not counted');
select ok((select latest_id is null and state = 'not_counted'
             from api.staff_till_days(100, 0, true) where business_date = tests.t() - 1),
          'with no count and no figures behind it, never a zero');
select is((select count(*)::int from api.staff_till_counts(100, 0, tests.t() - 1)), 0,
          'and no record with a zero in it');

select tests.cashier();
select is(tests.keep('late0', tests.enter(tests.t() - 1, null, tests.zeros(), null,
                                          gen_random_uuid()::text)),
          'day_changed', 'a past day without a late reason is refused');
select is(tests.keep('early', tests.enter(tests.t() - 30, null, tests.zeros(), 'Old day',
                                          gen_random_uuid()::text)),
          'day_not_countable', 'a day before counting started cannot be counted');
select is(tests.keep('late1', tests.enter(tests.t() - 1, null, tests.zeros(), 'Cashier was off sick',
                                          gen_random_uuid()::text)),
          'counted', 'the Cashier counts the missed day late, with a reason');
select is((tests.rec(tests.rid('late1'))).late_reason, 'Cashier was off sick',
          'the record keeps why it was late');
select is(tests.state(tests.t() - 1), 'awaiting_confirmation',
          'and the late count goes through the same confirm path');
select tests.manager();
select is((select string_agg(business_date::text, ',')
             from api.staff_till_days(1, 0, true, 'awaiting_confirmation')),
          (tests.t() - 1)::text,
          'the oldest day waiting for the Manager is found whatever page of open days it is on');

-- Entering and confirming are separate people, even after a change of role.
update public.user_roles set role = 'manager'
 where user_id = 'e8300000-0000-0000-0000-000000000004';
select tests.cashier();
select is(tests.confirm(tests.rid('late1'), null, null, 'k-self'), 'same_person',
          'the person who counted may not confirm their own count');
select is(tests.send_back(tests.rid('late1'), 'Recount it', 'k-self-sb'), 'same_person',
          'nor send it back');
update public.user_roles set role = 'cashier'
 where user_id = 'e8300000-0000-0000-0000-000000000004';
select tests.manager();
select is(tests.confirm(tests.rid('late1'), null, null, 'k-late'), 'confirmed',
          'another person confirms it');
select is(tests.state(tests.t() - 1), 'balanced', 'and the missed day closes');

-- ---------------------------------------------------------------------------
-- 10. Directors and the Manager read every count
-- ---------------------------------------------------------------------------
select tests.director();
select is((select count(*)::int from api.staff_till_counts(100, 0)), 5,
          'a Director reads every count, sent back or confirmed');
select is((select string_agg(state, ',' order by business_date)
             from api.staff_till_days(100, 0, false)),
          'shortage,excess,balanced,balanced,due',
          'each day resolves to exactly one state');
select is((select count(*)::int from api.staff_till_days(100, 0, true)), 0,
          'and no day is left open');

-- ---------------------------------------------------------------------------
-- 11. The audit trail
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.audit_events
            where entity_type = 'reconciliation' and action = 'till_count_entered'), 5,
          'every count entered is on the trail');
select is((select count(*)::int from public.audit_events
            where entity_type = 'reconciliation'
              and action in ('till_count_confirmed', 'till_count_sent_back')), 5,
          'every confirmation and send-back too');
select ok((select bool_and(actor_id is not null and actor_role is not null
                           and correlation_id is not null and source_operation is not null
                           and occurred_at is not null and entity_id is not null)
             from public.audit_events
            where entity_type = 'reconciliation' and action like 'till_count_%'),
          'each with its actor, live role, operation, entity, timestamp and correlation id');
select ok((select count(*) >= 15 and bool_and(actor_role is not null and correlation_id is not null
                                              and source_operation like 'api.staff_%till_count')
             from public.audit_events
            where entity_type = 'reconciliation' and action = 'command_refused'),
          'every committed refusal is on the trail with the same attribution');
select ok(exists (select 1 from public.audit_events
                   where entity_type = 'reconciliation' and action = 'command_refused'
                     and after_state ->> 'reason' = 'same_person'
                     and actor_role = 'manager'),
          'including the refusal of a person confirming their own count, under their live role');

-- ---------------------------------------------------------------------------
-- 12. The released imprest count is untouched
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.imprest_counts), 0,
          'counting the till writes no imprest count');

select * from finish();
rollback;
