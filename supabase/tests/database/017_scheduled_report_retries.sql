-- Issue #19 · Retries for the scheduled report, and the alert when every attempt has failed
--
-- 017 proves the success path. This file proves the other one, and every assertion in it exists
-- because the obvious implementation gets that case wrong:
--
--   1. FOUR SLOTS, FOUR FIXED ORDINALS. Cron owns four trigger times and nothing else. The UTC
--      expressions, the local times, the ordinals and the job names are all rows, so the claim that
--      21:15 UTC is 00:15 in Dar es Salaam is something this file can check rather than trust.
--
--   2. AN ATTEMPT IS CLAIMED, AND A CLAIM IS SPENT ONCE. A replayed slot must do NOTHING: no second
--      run, no second snapshot, no consumed ordinal, no early alert. An out-of-order slot must do
--      nothing either — which is the assertion that fails if "a higher ordinal wins" is used
--      instead of "the next ordinal wins", and it fails by declaring a day terminally failed while
--      two of its four attempts have not been tried.
--
--   3. A LEASE IS WHAT MAKES RECLAIMING SAFE. A later slot may take a run whose attempt FAILED or
--      whose lease EXPIRED, and never one still inside its lease. The superseded worker must then
--      be unable to record EITHER outcome — a stale worker that can still call a run successful is
--      the failure that puts two answers on one night.
--
--   4. A FAILURE IS COMMITTED, NOT ROLLED BACK. The row must survive with its ordinal, its claim
--      and completion times, its state and a bounded diagnostic — and the diagnostic must be a
--      SQLSTATE and a message, never a statement or a row's values.
--
--   5. ONLY THE LAST ORDINAL IS TERMINAL, AND TERMINAL RAISES ONE ALERT. Not two, however many
--      times the final slot is delivered.
--
--   6. THE SAME TWO ROLES READ THE ALERT AS READ A REPORT, and nothing else does — not a Cashier,
--      not a Sales Representative, not a deactivated Manager, not `anon`, not `service_role`.
--
-- THE FAILURE IS DRIVEN BY A REAL ONE. Taking `insert` on `public.report_snapshots` away from the
-- definer owner breaks the generator where it really breaks, deterministically, and puts no fault
-- switch inside the function that would then exist in production. It is the same technique the
-- browser suite uses to break a read.
--
-- WHAT THIS FILE CANNOT PROVE, AND WHERE IT IS PROVED INSTEAD. Everything above is a rule about
-- what a claim MEANS, and one transaction can hold all of it. The scheduled entry point,
-- `private.run_scheduled_report`, is a PROCEDURE that COMMITS the claim before it generates
-- anything — and a pgTAP file runs inside a transaction it rolls back, where transaction control is
-- illegal, so the procedure cannot be called here at all. Nor could one session see another's
-- uncommitted work even if it could. So the durable claim, the crashed worker that leaves something
-- reclaimable, and the hung worker that blocks no later slot are proved against the real procedure
-- with two live database sessions, in `tests/integration/report-claim-concurrency.test.ts`. Section
-- 7a below asserts the SHAPE that makes committing legal, so a later tidying-up cannot quietly take
-- it away.
create extension if not exists pgtap with schema extensions;

begin;
select plan(91);

create schema if not exists tests;

create or replace function tests.mk_user(p_id uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_id::text || '@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
          now(), now());
end $$;

create or replace function tests.claim(p_id uuid) returns text language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_id::text, 'role', 'authenticated')::text, true);
$$;
grant usage on schema tests to authenticated;
grant execute on function tests.claim(uuid) to authenticated;
-- THE TWO HALVES OF AN ATTEMPT, composed here because the real entry point cannot be called from a
-- pgTAP file at all. `private.run_scheduled_report` is a PROCEDURE that COMMITS between the claim
-- and the work — that is the whole point of it — and transaction control is illegal inside the
-- transaction this file runs in. So this file proves the two halves and every rule they enforce;
-- that the entry point really commits between them, that a worker which dies mid-report leaves a
-- reclaimable claim, and that a worker which hangs blocks no later slot are proved against the real
-- procedure with two live sessions, in `tests/integration/report-claim-concurrency.test.ts`.
--
-- IT CANNOT DRIFT FROM THE PROCEDURE'S ANSWER. The refusal shape belongs to
-- `private.claim_report_attempt`, which hands it back ready-made, so there is no second opinion
-- here about what a refused slot returns.
create or replace function tests.fire(p_attempt integer) returns jsonb language plpgsql as $$
declare
  v_claim record;
begin
  select c.* into v_claim
    from private.claim_report_attempt('daily_pilot_report', p_attempt) c;

  if v_claim.outcome <> 'claimed' then
    return v_claim.claim_refusal;
  end if;

  return private.run_report_attempt(v_claim.claimed_run_id, v_claim.claimed_token,
                                    v_claim.claimed_date, v_claim.claim_correlation, p_attempt);
end $$;


select tests.mk_user('d1000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('d1000000-0000-0000-0000-000000000002'::uuid);  -- Second Director
select tests.mk_user('d1000000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('d1000000-0000-0000-0000-000000000004'::uuid);  -- Cashier
select tests.mk_user('d1000000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('d1000000-0000-0000-0000-000000000006'::uuid);  -- A deactivated Manager

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('d1000000-0000-0000-0000-000000000001', 'Retry Director One', '+255700000191', true,  false),
  ('d1000000-0000-0000-0000-000000000002', 'Retry Director Two', '+255700000192', true,  false),
  ('d1000000-0000-0000-0000-000000000003', 'Retry Manager',      '+255700000193', true,  false),
  ('d1000000-0000-0000-0000-000000000004', 'Retry Cashier',      '+255700000194', true,  false),
  ('d1000000-0000-0000-0000-000000000005', 'Retry Rep',          '+255700000195', true,  false),
  ('d1000000-0000-0000-0000-000000000006', 'Retired Manager',    '+255700000196', false, false);

insert into public.user_roles (user_id, role) values
  ('d1000000-0000-0000-0000-000000000001', 'director'),
  ('d1000000-0000-0000-0000-000000000002', 'director'),
  ('d1000000-0000-0000-0000-000000000003', 'manager'),
  ('d1000000-0000-0000-0000-000000000004', 'cashier'),
  ('d1000000-0000-0000-0000-000000000005', 'sales_rep'),
  ('d1000000-0000-0000-0000-000000000006', 'manager');

-- ---------------------------------------------------------------------------
-- 1. FOUR SLOTS, AND FOUR CRON JOBS THAT MATCH THEM
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.report_schedule_slots slot
     join public.report_schedules s on s.id = slot.schedule_id
    where s.code = 'daily_pilot_report'),
  4,
  'the pilot schedule has four slots and no more');

select is(
  (select array_agg(slot.attempt_ordinal order by slot.attempt_ordinal)
     from public.report_schedule_slots slot),
  array[1, 2, 3, 4],
  'their ordinals are 1 through 4, fixed and contiguous');

select is(
  (select array_agg(slot.local_run_time::text order by slot.attempt_ordinal)
     from public.report_schedule_slots slot),
  array['00:01:00', '00:05:00', '00:15:00', '00:30:00'],
  'and the local times are the four the owner approved on issue #16');

select is(
  (select array_agg(slot.cron_expression order by slot.attempt_ordinal)
     from public.report_schedule_slots slot),
  array['1 21 * * *', '5 21 * * *', '15 21 * * *', '30 21 * * *'],
  'each stored beside the UTC expression that produces it -- Tanzania is UTC+3 all year');

select is(
  (select count(*)::int
     from cron.job j
     join public.report_schedule_slots slot on slot.job_name = j.jobname),
  4,
  'all four jobs are registered by the names the slots record');

select is(
  (select count(*)::int
     from cron.job j
     join public.report_schedule_slots slot on slot.job_name = j.jobname
    where j.schedule = slot.cron_expression),
  4,
  'and every job fires at the minute its own slot row states');

select is(
  (select count(*)::int
     from cron.job j
     join public.report_schedule_slots slot on slot.job_name = j.jobname
    where j.command =
      format('call private.run_scheduled_report(%s);', slot.attempt_ordinal)),
  4,
  'each calling the one private entry point with its own fixed ordinal -- no HTTP hop, no secret');

-- A SINGLE STATEMENT PER JOB, AND IT MUST STAY ONE. Several statements in one pg_cron
-- command become an implicit transaction block, and the entry point could then not commit its
-- claim before generating -- which is the property the whole retry design rests on.
select is(
  (select count(*)::int from cron.job
    where jobname like 'fv-daily-pilot-report%'
      and command ~ '^call private\.run_scheduled_report\([0-9]+\);$'),
  4,
  'and each command is one CALL and nothing else, so the claim can still commit on its own');

select is(
  (select count(*)::int from cron.job where jobname like 'fv-daily-pilot-report%'),
  4,
  'and there are four report jobs in total, not issue #18''s left registered beside them');

select is(
  (select final_attempt_ordinal from public.report_schedules where code = 'daily_pilot_report'),
  4,
  'the schedule states which ordinal is its last, so terminal is a fact rather than a literal');

select ok(
  (select lease_duration < interval '4 minutes'
     from public.report_schedules where code = 'daily_pilot_report'),
  'and its lease is shorter than the gap to the next slot, so a stopped worker is reclaimable');

-- ---------------------------------------------------------------------------
-- 2. A FAILED ATTEMPT IS A RECORD
--
-- Every generation from here to section 5 fails, for a real reason: the definer owner cannot write
-- a snapshot.
-- ---------------------------------------------------------------------------
revoke insert on public.report_snapshots from fv_definer_owner;

select set_config('tests.a1', tests.fire(1)::text, true);

select is(
  (current_setting('tests.a1')::jsonb ->> 'ok')::boolean,
  false,
  'a failed attempt says so');

select is(
  current_setting('tests.a1')::jsonb ->> 'status',
  'failed',
  'and records the failure rather than raising -- the record has to commit');

select is(
  (current_setting('tests.a1')::jsonb ->> 'terminal')::boolean,
  false,
  'the first of four failures is not terminal');

select is(
  current_setting('tests.a1')::jsonb ->> 'business_date',
  (private.business_date() - 1)::text,
  'the day is still derived inside the database, and it is the day that just closed');

select is(
  (select count(*)::int from public.report_runs),
  1,
  'exactly one run row exists for the date, failed or not');

select is(
  (select attempt_ordinal from public.report_runs),
  1,
  'carrying the ordinal of the attempt that failed');

select ok(
  (select claimed_at is not null and lease_expires_at is not null and completed_at is not null
          and generated_at is null
     from public.report_runs),
  'with its claim timing and its completion timing, and nothing pretending to be a generation');

select ok(
  (select failure_diagnostic like '42501:%' and length(failure_diagnostic) <= 240
     from public.report_runs),
  'and a bounded diagnostic that names the SQLSTATE an operator needs');

select ok(
  (select failure_diagnostic not like '%insert into%'
      and failure_diagnostic not like '%PL/pgSQL function%'
     from public.report_runs),
  'and never the statement that failed, which is where values and structure would leak');

select is(
  (select count(*)::int from public.report_snapshots),
  0,
  'the half-written snapshot went with the subtransaction that raised');

select is(
  (select count(*)::int from public.report_alerts),
  0,
  'and one failure raises nothing at anybody');

-- ---------------------------------------------------------------------------
-- 3. A REPLAYED SLOT, AND AN OUT-OF-ORDER ONE, DO NOTHING
-- ---------------------------------------------------------------------------
select set_config('tests.a1b', tests.fire(1)::text, true);

select is(
  current_setting('tests.a1b')::jsonb ->> 'reason',
  'attempt_already_used',
  'a replayed slot 1 is refused by name');

select is(
  (select attempt_ordinal from public.report_runs),
  1,
  'and consumes no further attempt -- the ordinal is exactly where it was');

select set_config('tests.a4early', tests.fire(4)::text, true);

select is(
  current_setting('tests.a4early')::jsonb ->> 'reason',
  'attempt_out_of_sequence',
  'the final slot arriving early is refused: only the NEXT ordinal may be claimed');

select is(
  (select status::text from public.report_runs),
  'failed',
  'so an early final slot cannot mark the day terminal');

select is(
  (select count(*)::int from public.report_alerts),
  0,
  'and cannot raise the alert before the retries have been tried');

-- ---------------------------------------------------------------------------
-- 4. A LATER SLOT RECLAIMS, AND THE SUPERSEDED WORKER CAN RECORD NOTHING
-- ---------------------------------------------------------------------------
select set_config('tests.token1', (select claim_token::text from public.report_runs), true);
select set_config('tests.run', (select id::text from public.report_runs), true);

select set_config('tests.a2', tests.fire(2)::text, true);

select is(
  current_setting('tests.a2')::jsonb ->> 'status',
  'failed',
  'slot 2 takes the failed run and tries again');

select is(
  current_setting('tests.a2')::jsonb ->> 'run_id',
  current_setting('tests.run'),
  'the SAME run -- a retry continues the business date, it does not open a second one');

select isnt(
  (select claim_token::text from public.report_runs),
  current_setting('tests.token1'),
  'and the new claim carries a fresh token');

select ok(
  not private.complete_report_run(
    current_setting('tests.run')::uuid, current_setting('tests.token1')::uuid),
  'the superseded worker cannot declare the run successful afterwards');

select is(
  private.fail_report_run(
    current_setting('tests.run')::uuid, current_setting('tests.token1')::uuid, 'stale'),
  'not_owner',
  'and cannot record a failure against it either, which would spend an ordinal it lost');

select is(
  (select failure_diagnostic from public.report_runs),
  current_setting('tests.a2')::jsonb ->> 'diagnostic',
  'the row still says what the CURRENT owner recorded, not what the stale worker tried to');

-- A worker that stopped without saying so: the lease is pushed into the past while the run is still
-- `claimed`, which is exactly the state a crashed generation leaves behind.
update public.report_runs
   set status = 'claimed', completed_at = null, failure_diagnostic = null,
       lease_expires_at = now() - interval '1 minute';

select set_config('tests.a3', tests.fire(3)::text, true);

select is(
  current_setting('tests.a3')::jsonb ->> 'status',
  'failed',
  'slot 3 reclaims a run whose lease expired, because a claim nobody is honouring is not a claim');

-- And the opposite case: a live lease is left alone. The run is put back into a claimed state with
-- time still on its lease, and the next slot must refuse it.
update public.report_runs
   set status = 'claimed', completed_at = null, failure_diagnostic = null,
       attempt_ordinal = 3, lease_expires_at = now() + interval '2 minutes';

select is(
  tests.fire(4) ->> 'reason',
  'lease_held',
  'a worker still inside its lease keeps the run: two generations on one night is the real danger');

-- ---------------------------------------------------------------------------
-- 5. TERMINAL, AND ONE ALERT
-- ---------------------------------------------------------------------------
update public.report_runs
   set status = 'failed', completed_at = now(), failure_diagnostic = '42501: forced',
       attempt_ordinal = 3, lease_expires_at = now() - interval '1 minute';

select set_config('tests.a4', tests.fire(4)::text, true);

select is(
  current_setting('tests.a4')::jsonb ->> 'status',
  'terminally_failed',
  'a genuine failure of the last ordinal is terminal');

select is(
  (current_setting('tests.a4')::jsonb ->> 'terminal')::boolean,
  true,
  'and says so to its caller');

select isnt(
  current_setting('tests.a4')::jsonb ->> 'alert_id',
  null,
  'terminal raises the alert');

select is(
  (select count(*)::int from public.report_alerts),
  1,
  'exactly one alert, for the one business date that was never reported');

select is(
  (select priority from public.report_alerts),
  'high',
  'at high priority, because a Director is being told a night has no report at all');

select is(
  tests.fire(4) ->> 'reason',
  'already_terminal',
  'replaying the final slot does nothing');

select is(
  (select count(*)::int from public.report_alerts),
  1,
  'and cannot raise a second alert');

-- Called again by the worker that still holds the token, so what refuses the second alert is the
-- unique constraint rather than the token guard. Both refusals matter and this is the one about
-- deduplication.
select is(
  private.raise_report_failure_alert(
    current_setting('tests.run')::uuid,
    (select claim_token from public.report_runs where id = current_setting('tests.run')::uuid)),
  null,
  'nor can the alert function itself, called again directly by the worker that owns the run');

-- And the other refusal: a superseded worker holding a stale token raises nothing, so it cannot
-- alert two Directors about a night somebody else has taken responsibility for.
select is(
  private.raise_report_failure_alert(current_setting('tests.run')::uuid, gen_random_uuid()),
  null,
  'and a worker whose claim has been taken cannot raise one at all');

select is(
  (select count(*)::int from public.audit_events
    where action = 'scheduled_report_alert_raised'),
  1,
  'so the audit trail records the alert once, not once per delivery of the slot');

-- ---------------------------------------------------------------------------
-- 6. THE SYSTEM AUDIT TRAIL
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.audit_events
    where action = 'scheduled_report_attempt_claimed'),
  4,
  'every accepted attempt is audited -- the four that were claimed, and none that were refused');

select ok(
  (select count(*) >= 4 from public.audit_events
    where action = 'scheduled_report_attempt_failed'),
  'and every recorded failure is audited too');

select ok(
  (select bool_and(is_system_actor and actor_id is null and actor_role is null
                   and correlation_id is not null)
     from public.audit_events
    where action like 'scheduled_report%'),
  'all of them as SYSTEM operations with a database-generated correlation id: nobody did this');

select is(
  (select count(distinct correlation_id)::int from public.audit_events
    where action = 'scheduled_report_attempt_claimed'),
  4,
  'one correlation id per attempt, so two unrelated attempts never look like one operation');

-- ---------------------------------------------------------------------------
-- 7. WHO MAY READ THE ALERT, AND WHO MAY RUN ANY OF THIS
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('authenticated', 'private.run_scheduled_report(integer, jsonb)', 'execute')
  and not has_function_privilege('anon', 'private.run_scheduled_report(integer, jsonb)', 'execute')
  and not has_function_privilege('service_role', 'private.run_scheduled_report(integer, jsonb)', 'execute'),
  'no Data API role can run a scheduled attempt -- not a session, not the secret key');

select ok(
  not has_function_privilege('authenticated',
        'private.run_report_attempt(uuid, uuid, date, uuid, integer)', 'execute')
  and not has_function_privilege('anon',
        'private.run_report_attempt(uuid, uuid, date, uuid, integer)', 'execute')
  and not has_function_privilege('service_role',
        'private.run_report_attempt(uuid, uuid, date, uuid, integer)', 'execute'),
  'nor generate against a claim it did not obtain: the second half is not an entry point');

select ok(
  not has_function_privilege('authenticated', 'private.claim_report_attempt(text, integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.complete_report_run(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.fail_report_run(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated',
        'private.raise_report_failure_alert(uuid, uuid)', 'execute'),
  'nor claim, finish, fail or alert on a run of its own choosing');

select ok(
  not has_function_privilege('service_role',
        'private.raise_report_failure_alert(uuid, uuid)', 'execute'),
  'and a leaked secret key cannot manufacture an alert');

select ok(
  has_function_privilege('postgres', 'private.run_scheduled_report(integer, jsonb)', 'execute'),
  'the role that owns the cron jobs can, which is the only caller there is');

-- ---------------------------------------------------------------------------
-- 7a. THE ENTRY POINT IS SHAPED SO THAT IT CAN COMMIT ITS CLAIM
--
-- These three facts are not style. PostgreSQL refuses transaction control to a routine that
-- is a function, or that is `security definer`, or that carries a `SET` clause -- each on its
-- own is enough, and all three were measured rather than assumed. If a later change adds
-- `set search_path` back to this procedure for tidiness, the claim silently stops committing
-- before generation and every guarantee in section 3 goes with it. So the shape is asserted.
-- ---------------------------------------------------------------------------
select is(
  (select prokind::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'run_scheduled_report'),
  'p',
  'the entry point is a PROCEDURE, because only a procedure may end a transaction');

select ok(
  (select not prosecdef and proconfig is null
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'run_scheduled_report'),
  'and carries neither SECURITY DEFINER nor a SET clause, either of which forbids COMMIT');

select ok(
  (select prosecdef and proconfig @> array['search_path=""']
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'run_report_attempt'),
  'while the half that touches tables keeps the definer and the pinned search_path');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'generate_scheduled_report'),
  0,
  'and the one-transaction entry point is GONE, not left beside its replacement');

-- ---------------------------------------------------------------------------
-- 7b. A STALLED WORKER CANNOT HOLD THE ROW OR THE KEY THAT THE NEXT SLOT NEEDS
--
-- Three properties, all of which were once wrong at the same time, and all of which are invisible
-- to a single-session test. What each one costs when it regresses is written beside it, because
-- none of them looks like it matters from the call site.
--
-- The behaviour itself -- attempt 2 reclaiming and finishing while attempt 1 sits on its snapshot
-- -- is proved against the real procedure in `tests/integration/report-claim-concurrency.test.ts`.
-- These assertions pin the three things that make it possible, so a later edit cannot quietly undo
-- one of them and leave the integration test as the only thing that notices.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_constraint c
    where c.conrelid = 'public.report_snapshots'::regclass
      and c.contype = 'u'
      and c.conkey = array[
            (select attnum from pg_attribute
              where attrelid = 'public.report_snapshots'::regclass and attname = 'run_id'),
            (select attnum from pg_attribute
              where attrelid = 'public.report_snapshots'::regclass and attname = 'attempt_ordinal')
          ]::int2[]),
  1,
  'a snapshot is unique per (run, attempt), so two attempts on one run never contend for one key');

select is(
  (select count(*)::int from pg_constraint c
    where c.conrelid = 'public.report_snapshots'::regclass
      and c.contype = 'u'
      and c.conkey = array[
            (select attnum from pg_attribute
              where attrelid = 'public.report_snapshots'::regclass and attname = 'run_id')
          ]::int2[]),
  0,
  'and NOT unique on the run alone -- that key let a stalled attempt block the one replacing it');

-- `FOR UPDATE` conflicts with the `KEY SHARE` that inserting a snapshot takes on the run through
-- the foreign key. A claim that asked for it skipped the very row it was sent to reclaim and
-- reported `lease_held` about an expired lease, and the night then died at the next slot.
select ok(
  (select prosrc ~ 'for no key update skip locked'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'claim_report_attempt'),
  'the claim takes the run FOR NO KEY UPDATE, which a concurrent snapshot insert cannot block');

select ok(
  (select prosrc !~ 'for update' and prosrc !~ 'for share'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('private') and p.proname = 'fail_report_run'),
  'and recording a failure takes no stronger lock either: one guarded UPDATE, no read-then-write');

-- COMPLETING THE RUN IS THE LAST STATEMENT OF A SUCCESSFUL ATTEMPT, and the order is asserted
-- because it was once the other way round and that was a defect. `complete_report_run` takes a
-- `NO KEY UPDATE` lock held until commit, so anything after it extends that lock by however long
-- it takes -- and a worker stalled on the audit insert that used to follow it sat on the run row
-- until it was killed, while the next slot skipped the row and reported `lease_held`.
-- The needle is the CALL, `private.complete_report_run(`, and not the bare name: the comments in
-- that function explain why the order matters and name it while doing so, so a bare-name search
-- finds the explanation rather than the statement.
select ok(
  (select position('scheduled_report_generated' in prosrc)
            < position('private.complete_report_run(' in prosrc)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'run_report_attempt'),
  'the generated-audit event is written BEFORE the run is completed, not after it');

-- And nothing writes after it. Everything from the completion to the end of the successful block
-- is read: a single `insert` appearing there would put the run row's lock back in the hands of
-- whatever that statement waits on.
-- And nothing writes after it IN THE SUCCESSFUL BLOCK, which runs from the completion to the
-- handler that catches a lost lease. A single `insert` in that span would put the run row's lock
-- back in the hands of whatever the statement waits on. The failure path below the handler writes
-- freely, and must: by then the run is `failed` and reclaimable either way.
select ok(
  (select substring(
            prosrc
            from position('private.complete_report_run(' in prosrc)
            for greatest(position('when sqlstate ''ZR001''' in prosrc)
                           - position('private.complete_report_run(' in prosrc), 0))
            !~* 'insert into'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'run_report_attempt'),
  'and nothing is written after it: a successful attempt ends on that statement');

-- ---------------------------------------------------------------------------
-- 7c. THE LEASE IS A DEADLINE, NOT A LABEL
--
-- A worker that has run over does not get to finish. That is what stops an over-lease worker
-- holding the snapshot key and the run's foreign-key lock while the slot sent to replace it is
-- trying to make progress -- and `clock_timestamp()` is load-bearing, because `now()` is frozen at
-- the transaction's start and a stalled worker would compare its lease against the moment it began.
-- ---------------------------------------------------------------------------
-- ON ITS OWN BUSINESS DATE, so this proves a rule about `complete_report_run` without disturbing
-- the night that sections 2 to 9 are walking through. Writing a claimed row by hand is the right
-- tool for THIS question — does the function honour the lease it is given — and the wrong tool for
-- the question the integration test answers, which is what two live workers do to each other.
insert into public.report_runs (
    schedule_id, business_date, attempt_ordinal, status,
    claim_token, claimed_at, lease_expires_at, correlation_id)
select s.id, date '2026-03-09', 1, 'claimed',
       gen_random_uuid(), clock_timestamp() - interval '1 minute',
       clock_timestamp() - interval '1 second', gen_random_uuid()
  from public.report_schedules s
 where s.code = 'daily_pilot_report';

select set_config('tests.overrun', (
  select id::text from public.report_runs where business_date = date '2026-03-09'), true);

select ok(
  not private.complete_report_run(
    current_setting('tests.overrun')::uuid,
    (select claim_token from public.report_runs
      where id = current_setting('tests.overrun')::uuid)),
  'a worker holding the right token but past its lease is refused its success');

select is(
  (select status::text from public.report_runs where id = current_setting('tests.overrun')::uuid),
  'claimed',
  'and the run is left claimed and reclaimable, not marked succeeded behind the next slot''s back');

select ok(
  (select prosrc ~ 'lease_expires_at > clock_timestamp\(\)'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'complete_report_run'),
  'and it compares against the wall clock, not the transaction clock a stalled worker froze');

-- The same run, still inside a lease, succeeds — so the assertion above is about the DEADLINE and
-- not about the function refusing everything.
update public.report_runs
   set lease_expires_at = clock_timestamp() + interval '1 minute'
 where id = current_setting('tests.overrun')::uuid;

select ok(
  private.complete_report_run(
    current_setting('tests.overrun')::uuid,
    (select claim_token from public.report_runs
      where id = current_setting('tests.overrun')::uuid)),
  'while the same worker inside its lease is allowed to finish');

delete from public.report_runs where id = current_setting('tests.overrun')::uuid;

select ok(
  (select relrowsecurity from pg_class
    where oid = 'public.report_alerts'::regclass),
  'row-level security is on for the alerts');

select ok(
  (select relrowsecurity from pg_class
    where oid = 'public.report_schedule_slots'::regclass),
  'and for the slots');

select ok(
  not has_table_privilege('authenticated', 'public.report_alerts', 'insert')
  and not has_table_privilege('authenticated', 'public.report_alerts', 'update')
  and not has_table_privilege('authenticated', 'public.report_alerts', 'delete'),
  'a session may read an alert and never write, change or clear one');

select ok(
  not has_table_privilege('anon', 'public.report_alerts', 'select')
  and not has_table_privilege('service_role', 'public.report_alerts', 'select')
  and not has_table_privilege('anon', 'public.report_failure_alerts', 'select')
  and not has_table_privilege('service_role', 'public.report_failure_alerts', 'select'),
  'and neither anon nor the secret key is given any way to read one at all');

select ok(
  (select 'security_invoker=true' = any (reloptions) from pg_class
    where oid = 'public.report_failure_alerts'::regclass),
  'the alert view is security_invoker, so the reader''s own policies decide what it returns');

set local role authenticated;

select tests.claim('d1000000-0000-0000-0000-000000000001'::uuid);
select is(
  (select count(*)::int from public.report_failure_alerts),
  1,
  'a Director is shown the unresolved failure');

select tests.claim('d1000000-0000-0000-0000-000000000002'::uuid);
select is(
  (select count(*)::int from public.report_failure_alerts),
  1,
  'so is the second Director -- both of them, as product.md 18.1 says');

select tests.claim('d1000000-0000-0000-0000-000000000003'::uuid);
select is(
  (select count(*)::int from public.report_failure_alerts),
  1,
  'and the Manager');

select tests.claim('d1000000-0000-0000-0000-000000000004'::uuid);
select is(
  (select count(*)::int from public.report_failure_alerts),
  0,
  'a Cashier is handed nothing, whatever route they reached for');

select tests.claim('d1000000-0000-0000-0000-000000000005'::uuid);
select is(
  (select count(*)::int from public.report_alerts),
  0,
  'a Sales Representative cannot read the table under the view either');

select tests.claim('d1000000-0000-0000-0000-000000000006'::uuid);
select is(
  (select count(*)::int from public.report_failure_alerts),
  0,
  'and a deactivated Manager is refused, because the policy checks the account and not the role');

reset role;

-- ---------------------------------------------------------------------------
-- 8. RECOVERY: A LATER SLOT GENERATES THE ONE REPORT
--
-- The day is cleared and lived again from the start, because a business date that has gone terminal
-- cannot also be recovered -- which is itself the rule under test in section 5.
-- ---------------------------------------------------------------------------
delete from public.report_alerts;
delete from public.report_runs;

select is(
  tests.fire(1) ->> 'status',
  'failed',
  'the 00:01 attempt fails again');

-- A RETRY RUNS AFTER MIDNIGHT, SO IT SEES DECISIONS THE DAY IT REPORTS NEVER SAW. A discount and a
-- batch are asked for five minutes before local midnight and decided at exactly midnight, which
-- belongs to today and is never later than now whenever this file runs. The 00:05 attempt that
-- recovers yesterday must still report them as waiting.
insert into public.approval_requests (id, entity_type, entity_id, approval_type, requested_by,
                                      requested_role, required_role, requested_at, status,
                                      approved_by, approved_role, approved_at)
select v.id, 'order', gen_random_uuid(), 'discount', 'd1000000-0000-0000-0000-000000000005',
       'sales_rep', 'director', m.midnight - interval '5 minutes', v.now_status,
       case when v.now_status = 'approved' then 'd1000000-0000-0000-0000-000000000001'::uuid end,
       case when v.now_status = 'approved' then 'director'::public.app_role end,
       case when v.now_status = 'approved' then m.midnight end
  from (select private.business_date()::timestamp at time zone 'Africa/Dar_es_Salaam' as midnight) m,
       (values ('d5000000-0000-0000-0000-000000000001'::uuid, 'approved'::public.approval_status),
               ('d5000000-0000-0000-0000-000000000002'::uuid, 'rejected')) v(id, now_status);

insert into public.approval_decisions (request_id, outcome, decided_by, decided_role, decided_at)
select r.id, r.status::text::public.decision_outcome, 'd1000000-0000-0000-0000-000000000001',
       'director', r.requested_at + interval '5 minutes'
  from public.approval_requests r
 where r.id in ('d5000000-0000-0000-0000-000000000001', 'd5000000-0000-0000-0000-000000000002');

insert into public.production_batches (batch_no, location_code, status, moulded_at, entered_by,
                                       entered_role, entered_at, decided_by, decided_role,
                                       decided_at, decision_reason)
select 'PB-RETRY-' || v.n, 'yard', v.now_status, m.midnight - interval '5 minutes',
       'd1000000-0000-0000-0000-000000000003', 'manager', m.midnight - interval '5 minutes',
       'd1000000-0000-0000-0000-000000000003', 'manager', m.midnight,
       case when v.now_status = 'rejected' then 'Mix too wet' end
  from (select private.business_date()::timestamp at time zone 'Africa/Dar_es_Salaam' as midnight) m,
       (values (1, 'approved'::public.production_batch_status), (2, 'rejected')) v(n, now_status);

grant insert on public.report_snapshots to fv_definer_owner;

select set_config('tests.recovered', tests.fire(2)::text, true);

select is(
  (current_setting('tests.recovered')::jsonb ->> 'created')::boolean,
  true,
  'and the 00:05 attempt generates the report the failed one could not');

select is(
  (select count(*)::int from public.report_snapshots),
  1,
  'ONE snapshot for the business date, written by whichever attempt succeeded');

select ok(
  (select count(*) > 0 from public.report_deliveries),
  'with the Director and Manager deliveries issue #18 defines, unchanged');

select is(
  (select status::text from public.report_runs),
  'succeeded',
  'and the run is settled');

select is(
  (select e from public.report_snapshots s,
                 jsonb_array_elements(s.content -> 'sections' -> 'discounts_and_approvals' -> 'by_type') e
    where e ->> 'approval_type' = 'discount'),
  '{"approval_type": "discount", "requested": 2, "approved": 0, "rejected": 0}'::jsonb,
  'the retry reports both discounts as asked for yesterday and neither as decided -- the approval '
  'and the rejection at midnight are today''s');

select is(
  (select s.content -> 'sections' -> 'production_batches' from public.report_snapshots s),
  '{"entered": 2, "draft": 2, "approved": 0, "rejected": 0, "cancelled": 0}'::jsonb,
  'and both batches as drafts, although each was decided before the retry ran');

select is(
  tests.fire(3) ->> 'reason',
  'already_generated',
  'every later slot for a generated date is a no-op');

select is(
  (select count(*)::int from public.report_snapshots),
  1,
  'so a late retry cannot write a second snapshot over a report that already exists');

select is(
  (select count(*)::int from public.report_alerts),
  0,
  'and a day that recovered raises no alert');

-- ---------------------------------------------------------------------------
-- 9. AN ALERT STOPS BEING UNRESOLVED WHEN ITS DAY HAS A REPORT
--
-- Inserted directly, because the function will not raise one for a run that succeeded -- which is
-- the point: the view's predicate is what is under test here, on its own.
-- ---------------------------------------------------------------------------
insert into public.report_alerts (schedule_id, business_date, alert_type, priority, correlation_id)
select r.schedule_id, r.business_date, 'scheduled_report_failed', 'high', gen_random_uuid()
  from public.report_runs r;

select is(
  (select count(*)::int from public.report_alerts),
  1,
  'the alert row exists');

select is(
  (select count(*)::int from public.report_failure_alerts),
  0,
  'and is not shown, because the night it names has a report after all -- nothing else resolves one');

select finish();
rollback;
