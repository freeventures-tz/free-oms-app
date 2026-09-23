-- Stage 15 · Retries for the scheduled report, and one alert when every attempt has failed
--
-- ISSUE #51 INTEGRATION. This is the reviewed failure path of issue #19 at `a34704a`, including
-- review findings F1 (a cancelled or timed-out generation is recorded as a failure) and F2 (an
-- attempt that runs past its lease records its failure unless it was replaced). It lands in the
-- same release unit as `20260923000100_scheduled_report.sql`, which registered no Cron job: the
-- four jobs at the foot of this file are the first and only schedule, so a success-only scheduler
-- never runs. Apart from that the objects below are the reviewed source's.
--
-- Issue #18 built the success path: at 00:01 Africa/Dar_es_Salaam the database writes yesterday's
-- report by itself. It deliberately built no failure path at all — a generation that failed raised,
-- the transaction rolled back, and NOTHING WAS LEFT BEHIND to say the day had been missed. This
-- migration adds the other half, and nothing else: the report's content, its digest, its integrity
-- display and its recipient deliveries are exactly as issue #18 left them, and a Director reads the
-- same report from the same view.
--
-- ONE ISSUE #18 SHAPE DOES CHANGE, and it is called out here rather than buried: a snapshot is now
-- keyed `(run_id, attempt_ordinal)` instead of `run_id` alone, because a run has four attempts now
-- and the old key let a stalled attempt hold the index entry the slot replacing it needed. The
-- snapshot's content, digest, trigger and immutability are untouched, and one report per business
-- date is still guaranteed — by `report_runs`, which is where it always actually lived. The
-- `report_snapshots` section below sets out why in full.
--
-- Five rules shape every object below.
--
--   1. CRON OWNS FOUR TRIGGER TIMES AND NOTHING ELSE. Four named jobs fire at 00:01, 00:05, 00:15
--      and 00:30 local, each calling ONE private entry point with its own fixed attempt ordinal.
--      Everything else — which day, whether an attempt may run, whether a failure is the last one,
--      whether an alert is raised — is decided inside the database. A scheduler that could be
--      replayed, delayed or fired twice therefore cannot make any of those decisions wrongly,
--      because it makes none of them.
--
--   2. AN ATTEMPT IS CLAIMED, NOT ASSUMED. One `(schedule, business date, attempt ordinal)` is
--      claimed atomically by a single statement. A duplicate delivery of the same slot loses that
--      statement's condition and does no work: it cannot consume a later attempt, write a second
--      snapshot, or bring the terminal alert forward.
--
--   3. A CLAIM CARRIES A FRESH TOKEN AND A BOUNDED LEASE, AND BOTH ARE ENFORCED. A later slot may
--      take a run whose previous attempt FAILED, or whose lease has EXPIRED — a worker that stopped
--      without saying so. The token makes that safe: every finalisation is guarded by it, so a
--      superseded worker records neither outcome and cannot declare a run successful after somebody
--      else has taken responsibility for it. The LEASE is the second guard, and it is what makes
--      the first one enough: succeeding requires being inside it, so a worker that has run over
--      writes no report and therefore holds no index entry that the slot replacing it would have
--      to wait for. RUNNING OVER IS NOT THE SAME AS BEING REPLACED: a worker past its lease that
--      nobody has taken the run from still owns it, and records its attempt as FAILED through the
--      same token-guarded path as any other failure — so an over-lease last attempt still ends
--      the night terminal, with its alert.
--
--   4. A FAILURE IS A RECORD, NOT A ROLLBACK. The attempt's work runs in a subtransaction. When it
--      raises, the work is discarded and the FAILURE is written and committed: its ordinal, when it
--      was claimed, when it finished, its state, and a bounded diagnostic — a SQLSTATE and a
--      truncated message. No exception context, no statement text, no parameter values, so a
--      diagnostic is something operations can act on and never somewhere data can leak to.
--
--   5. ONLY A GENUINE FAILURE OF THE LAST ORDINAL IS TERMINAL, and terminal raises exactly one
--      alert per (schedule, business date). The uniqueness is a constraint, so a replay of the
--      final slot cannot produce a second alert any more than a replayed slot can produce a second
--      report.
--
-- WHO SEES THE ALERT. The same two audiences that read a report (product.md §18.1): both active
-- Directors and the Manager. A Cashier, a Sales Representative, an anonymous caller, a deactivated
-- account and `service_role` are refused by the database, not by a hidden menu entry.
--
-- WHAT THIS SLICE STILL DOES NOT HAVE, and must not be read as having: manual retry or
-- regeneration, amended reports, alert acknowledgement or dismissal, a notification centre, and any
-- delivery channel other than the app. The alert is READ-ONLY. It stops being shown when the
-- business date it names has a successful report — which is the only honest resolution there is,
-- because nothing else in V1 can fix a missed night.

begin;

-- ---------------------------------------------------------------------------
-- The schedule learns two more facts about itself
--
-- Both are on the row rather than in the function, for the reason the cron expression already is:
-- a test can read a row, and cannot read an intention. `final_attempt_ordinal` is what makes
-- "only the last attempt is terminal" a fact of the schedule instead of the literal `4` repeated
-- in three places, and `lease_duration` is what makes "this worker has stopped" a decision with a
-- stated bound.
--
-- THREE MINUTES, and the number is chosen from the gaps between the slots rather than from how long
-- the work takes (it takes well under a second). The shortest gap is the four minutes between 00:01
-- and 00:05, so a lease shorter than four minutes guarantees that a worker which stopped without
-- saying so is reclaimable by the very next slot. A lease longer than the gap would silently turn
-- the first retry into a no-op in precisely the case retries exist for.
--
-- THE CHECK IS A SANITY BOUND, NOT THE POLICY. It exists to refuse a nonsense value — zero, or
-- negative, or an interval so long the retries could never reclaim anything. The policy that
-- matters, "shorter than the gap to the next slot", is asserted against the value the schedule
-- ACTUALLY carries, in `017_scheduled_report_retries.sql`, where it stays three minutes. The floor
-- is one second so that a test can watch a real lease expire against real time rather than writing
-- an expired row and calling that the same thing.
-- ---------------------------------------------------------------------------
alter table public.report_schedules
  add column lease_duration interval not null default interval '3 minutes'
    check (lease_duration between interval '1 second' and interval '15 minutes'),
  add column final_attempt_ordinal integer not null default 4
    check (final_attempt_ordinal between 1 and 10);

comment on column public.report_schedules.lease_duration is
  'How long an accepted claim owns the run before a later scheduled slot may take it. Shorter than '
  'the shortest gap between slots, so a worker that stopped is reclaimable by the next one.';

comment on column public.report_schedules.final_attempt_ordinal is
  'The last attempt of the day. Only a genuine failure of THIS ordinal is terminal, and only a '
  'terminal run raises the alert.';

-- ---------------------------------------------------------------------------
-- report_schedule_slots — the four trigger times, and which ordinal each carries
--
-- The correspondence between a UTC cron expression, a local time and an attempt ordinal is stored
-- rather than described, for the reason issue #18 stored the first one: a test can assert a row,
-- and a comment about `21:15 UTC` is something a reader has to trust. Tanzania is UTC+3 with no
-- daylight saving, so each pairing below is exact and not an approximation.
--
-- Slot 1 is INSERTED FROM THE SCHEDULE ROW ITSELF rather than retyped, so the schedule row issue #18
-- wrote and the slot that describes its 00:01 job cannot disagree about when it fires.
-- ---------------------------------------------------------------------------
create table public.report_schedule_slots (
  schedule_id     uuid not null references public.report_schedules (id) on delete cascade,
  attempt_ordinal integer not null check (attempt_ordinal between 1 and 10),
  local_run_time  time not null,
  cron_expression text not null check (length(btrim(cron_expression)) between 1 and 100),
  job_name        text not null unique check (length(btrim(job_name)) between 1 and 100),

  primary key (schedule_id, attempt_ordinal)
);

comment on table public.report_schedule_slots is
  'One row per scheduled attempt: its fixed ordinal, the local time it fires, the UTC cron '
  'expression that produces that local time, and the name of the Supabase Cron job registered for '
  'it. Cron owns the trigger times; everything else about a run is decided in the database.';

insert into public.report_schedule_slots
  (schedule_id, attempt_ordinal, local_run_time, cron_expression, job_name)
select s.id, 1, s.local_run_time, s.cron_expression, 'fv-daily-pilot-report'
  from public.report_schedules s
 where s.code = 'daily_pilot_report'
union all
select s.id, 2, time '00:05', '5 21 * * *', 'fv-daily-pilot-report-retry-1'
  from public.report_schedules s where s.code = 'daily_pilot_report'
union all
select s.id, 3, time '00:15', '15 21 * * *', 'fv-daily-pilot-report-retry-2'
  from public.report_schedules s where s.code = 'daily_pilot_report'
union all
select s.id, 4, time '00:30', '30 21 * * *', 'fv-daily-pilot-report-retry-3'
  from public.report_schedules s where s.code = 'daily_pilot_report';

-- ---------------------------------------------------------------------------
-- report_runs learns what state it is in
--
-- Issue #18's table said one thing: a row is a report that was generated. It said so deliberately,
-- because there was no other outcome to record. There are three more now, and the enum is where a
-- future reader finds out that this is the whole list.
--
-- THE UNIQUE `(schedule_id, business_date)` IS UNTOUCHED. It was the idempotency rule of §18.2 and
-- it still is: one run row per business date, whatever happens to it, so a report that has been
-- generated cannot be generated a second time by any path at all — including a retry that fires
-- late against a day another slot already finished.
-- ---------------------------------------------------------------------------
create type public.report_run_status as enum (
  'claimed',            -- an attempt owns this run right now, and its lease says until when
  'succeeded',          -- the report exists; every later slot for this date is a no-op
  'failed',             -- this attempt failed and a later scheduled slot may try again
  'terminally_failed'   -- the last attempt failed; the day has no report and an alert says so
);

comment on type public.report_run_status is
  'The whole life of one scheduled report run. `succeeded` is issue #18''s only outcome; the other '
  'three are the failure path added by issue #19.';

alter table public.report_runs
  add column attempt_ordinal integer not null default 1
    check (attempt_ordinal between 1 and 10),
  -- Defaulted to `succeeded` FOR THE BACKFILL, because every row that can exist when this migration
  -- runs is an issue #18 row and an issue #18 row is a generated report. The default is dropped
  -- immediately below: from here on a run states its status when it is claimed, and never inherits
  -- one.
  add column status public.report_run_status not null default 'succeeded',
  add column claim_token uuid,
  add column claimed_at timestamptz,
  add column lease_expires_at timestamptz,
  add column completed_at timestamptz,
  add column failure_diagnostic text check (length(failure_diagnostic) between 1 and 240);

alter table public.report_runs alter column status drop default;

-- A run that failed has no `generated_at`, because nothing was generated. Writing the moment the
-- attempt gave up into a column called "generated at" is the kind of small lie a report is built
-- on later.
alter table public.report_runs alter column generated_at drop not null;
alter table public.report_runs alter column generated_at drop default;

-- The backfill for a database that already carries issue #18 rows. A generated report was owned by
-- the invocation that wrote it and finished at the moment it was written; giving it a token now
-- costs nothing and keeps the NOT NULLs below true for every row rather than for new ones only.
update public.report_runs
   set claim_token      = coalesce(claim_token, gen_random_uuid()),
       claimed_at       = coalesce(claimed_at, generated_at),
       lease_expires_at = coalesce(lease_expires_at, generated_at),
       completed_at     = coalesce(completed_at, generated_at)
 where claim_token is null;

alter table public.report_runs
  alter column claim_token set not null,
  alter column claimed_at set not null,
  alter column lease_expires_at set not null;

-- WHAT EACH STATE REQUIRES OF THE ROW, checked by the database rather than by the function that
-- writes it. A `succeeded` run with no `generated_at` and a `failed` run with no diagnostic are
-- both unreachable through the functions below — and both stay unreachable if somebody writes a
-- fifth path later.
alter table public.report_runs
  add constraint report_runs_state_shape check (
    (status = 'claimed'
      and generated_at is null and completed_at is null and failure_diagnostic is null)
    or (status = 'succeeded'
      and generated_at is not null and completed_at is not null and failure_diagnostic is null)
    or (status in ('failed', 'terminally_failed')
      and generated_at is null and completed_at is not null and failure_diagnostic is not null)
  );

create index report_runs_status_idx on public.report_runs (status, business_date desc);

comment on table public.report_runs is
  'One scheduled report run per (schedule, business date), whatever became of it. The unique '
  'constraint is still what makes a replayed cron slot a no-op; `status`, the claim token and the '
  'lease are what make a RETRIED slot safe.';

comment on column public.report_runs.claim_token is
  'Minted afresh for every accepted claim. Finalising success or failure is guarded by it, so a '
  'worker whose lease has been taken by a newer claim can no longer record either outcome.';

comment on column public.report_runs.failure_diagnostic is
  'A SQLSTATE and a truncated message, for operations. Never exception context, statement text or '
  'parameter values: a diagnostic is not a place for data to leak to.';

-- ---------------------------------------------------------------------------
-- report_snapshots — one snapshot per ATTEMPT, so a stalled attempt blocks no later one
--
-- Issue #18 keyed this table `run_id UNIQUE`, and that was exactly right when a run had one
-- attempt. A run now has up to four, and that key turned a stalled worker into a roadblock for the
-- slot sent to replace it. The failure is worth writing down because it is not obvious from
-- reading either table:
--
--   Attempt 1 claims (committed), starts generating, and stalls with its snapshot INSERT pending.
--   Its lease expires. Attempt 2 fires and must take over. But attempt 1's pending row holds the
--   `report_snapshots_run_id_key` index entry for that run, so attempt 2's own insert waits on a
--   transaction that is not going anywhere — `canceling statement due to statement timeout ...
--   while inserting index tuple in relation "report_snapshots_run_id_key"`. **The lease said the
--   run was reclaimable and the index said it was not.**
--
-- SO THE KEY IS NOW `(run_id, attempt_ordinal)`. Two attempts on one run write to two different
-- keys and never contend. The ordinal is on the row anyway rather than being smuggled in for the
-- index: which attempt produced a report is a fact about it, and a night that took three tries
-- says so.
--
-- WHAT STILL GUARANTEES ONE REPORT PER NIGHT, since this key no longer does it alone:
--
--   · `report_runs` keeps `UNIQUE (schedule_id, business_date)` — one run per business date, which
--     was issue #18's idempotency rule and is untouched.
--   · Only one attempt can ever finalise that run: `private.complete_report_run` requires the
--     current claim token AND `status = 'claimed'`, so the transition happens once.
--   · A losing attempt's snapshot is DISCARDED, not kept. It is written inside the subtransaction
--     that the lost-lease check aborts, so it never reaches committed data at all.
--   · `public.daily_reports` reads the snapshot of the attempt the run actually succeeded on
--     (`s.attempt_ordinal = r.attempt_ordinal`), so even a snapshot that somehow survived could
--     not be served as the report.
--
-- Nothing else about a snapshot changes: same content, same digest, same trigger, same
-- immutability, same deliveries.
-- ---------------------------------------------------------------------------
-- THE BACKFILL MUST NOT TOUCH A SINGLE EXISTING ROW, and the first version of it did.
--
-- Issue #18 protected a snapshot with `report_snapshots_immutable`, a BEFORE UPDATE OR DELETE row
-- trigger that refuses everybody including the definer owner. That is the guarantee a Director's
-- report rests on, and it is doing its job. But the obvious backfill — add the column nullable,
-- `UPDATE` the rows, then `SET NOT NULL` — is an UPDATE, so on any database that has ever produced
-- a report it fails outright:
--
--   ERROR: a report snapshot is immutable; a correction creates an amended version (SQLSTATE 23001)
--   At statement: 21 ... update public.report_snapshots s set attempt_ordinal = ...
--
-- An empty local database never showed it. A hosted one that had run a single night would have,
-- with the migration half-applied in the release window.
--
-- `ADD COLUMN ... NOT NULL DEFAULT 1` IS THE ANSWER, and not merely a shorter way of writing the
-- same thing. Since PostgreSQL 11 a non-volatile default is recorded once in the catalogue
-- (`pg_attribute.attmissingval`) and handed to readers of rows that predate the column. No heap is
-- rewritten and NO ROW IS UPDATED, so no row trigger fires and immutability is never contradicted.
-- The value is right for every row that can exist: issue #18 had exactly one attempt.
--
-- THE DEFAULT IS THEN DROPPED, because it is a migration device and would be a liability as a rule.
-- Every attempt from here on knows its own ordinal and states it; a column that quietly answered
-- "1" would label a third attempt's snapshot as the first one's, and the unique key that stops a
-- stalled attempt blocking its replacement would collapse back to one row per run.
--
-- IMMUTABILITY IS UNCHANGED AFTER THIS RUNS. The trigger is not dropped, disabled, or re-created,
-- and `session_replication_role` is not touched. A snapshot still refuses UPDATE and DELETE from
-- everybody, which `016_scheduled_report.sql` asserts and the populated migration-chain
-- fixture re-asserts on the far side of this migration.
alter table public.report_snapshots
  add column attempt_ordinal integer not null default 1;

alter table public.report_snapshots
  alter column attempt_ordinal drop default,
  add constraint report_snapshots_attempt_ordinal_check check (attempt_ordinal >= 1);

alter table public.report_snapshots
  drop constraint report_snapshots_run_id_key,
  add constraint report_snapshots_run_attempt_key unique (run_id, attempt_ordinal);

comment on column public.report_snapshots.attempt_ordinal is
  'Which scheduled attempt produced this snapshot. Part of the unique key so a stalled attempt '
  'cannot hold the index entry a later attempt needs; only one attempt ever commits. Backfilled to '
  '1 by a catalogue default, never by an UPDATE, because a snapshot is immutable.';

-- ---------------------------------------------------------------------------
-- report_alerts — one high-priority alert per business date that was never reported
--
-- The unique key IS the deduplication rule. Nothing about "have we already raised this?" is decided
-- in code that could be replayed, reordered or run twice at once.
--
-- There is no `resolved_at` and no acknowledgement, because this ticket adds neither. An alert is
-- UNRESOLVED for exactly as long as its business date has no successful report, and
-- `public.report_failure_alerts` below is where that is decided — so the screen cannot go on
-- warning about a night that has since been reported, and nobody can make a warning go away by
-- looking at it.
-- ---------------------------------------------------------------------------
create table public.report_alerts (
  id             uuid primary key default gen_random_uuid(),
  schedule_id    uuid not null references public.report_schedules (id) on delete restrict,
  business_date  date not null,
  alert_type     text not null check (alert_type = 'scheduled_report_failed'),
  priority       text not null check (priority = 'high'),
  raised_at      timestamptz not null default now(),
  correlation_id uuid not null,

  unique (schedule_id, business_date, alert_type)
);

create index report_alerts_date_idx on public.report_alerts (business_date desc);

comment on table public.report_alerts is
  'In-app alerts about the reporting schedule itself (product.md 18.2). One row per (schedule, '
  'business date, type): the unique constraint is what makes a replayed final slot raise nothing.';

-- ---------------------------------------------------------------------------
-- report_failure_alerts — what the screen reads
--
-- `security_invoker`, so the reader's own policies on all three underlying records decide what
-- comes back rather than the view owner's.
-- ---------------------------------------------------------------------------
create view public.report_failure_alerts
with (security_invoker = true) as
select a.id,
       s.code as schedule_code,
       a.business_date,
       a.alert_type,
       a.priority,
       a.raised_at
  from public.report_alerts a
  join public.report_schedules s on s.id = a.schedule_id
 where not exists (
   select 1
     from public.report_runs r
    where r.schedule_id = a.schedule_id
      and r.business_date = a.business_date
      and r.status = 'succeeded');

comment on view public.report_failure_alerts is
  'Unresolved scheduled-report failures. An alert leaves this view when its business date has a '
  'successful report, which is the only thing in V1 that resolves one — reading it does not.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants for the two new exposed tables
--
-- Same audiences and the same shape as issue #18's four tables: `authenticated` reads and never
-- writes, `anon` and `service_role` are given nothing, and `fv_definer_owner` gets exactly the
-- privileges the functions below use and no others.
-- ---------------------------------------------------------------------------
alter table public.report_schedule_slots enable row level security;
alter table public.report_alerts enable row level security;

grant select on public.report_schedule_slots to authenticated;
grant select on public.report_alerts to authenticated;
grant select on public.report_failure_alerts to authenticated;

revoke insert, update, delete on public.report_schedule_slots from authenticated;
revoke insert, update, delete on public.report_alerts from authenticated;

create policy report_schedule_slots_select on public.report_schedule_slots
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

create policy report_alerts_select on public.report_alerts
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

grant select on public.report_schedule_slots to fv_definer_owner;
grant select, insert on public.report_alerts to fv_definer_owner;

create policy report_schedule_slots_definer_owner_read on public.report_schedule_slots
  for select to fv_definer_owner using ( true );

create policy report_alerts_definer_owner_read on public.report_alerts
  for select to fv_definer_owner using ( true );
create policy report_alerts_definer_owner_insert on public.report_alerts
  for insert to fv_definer_owner with check ( true );

-- The run row is now UPDATED as well as inserted — claimed, then finalised. Issue #18 withheld
-- update because the generator genuinely never changed a run; it does now, and the grant says so
-- rather than the whole table being opened.
grant update on public.report_runs to fv_definer_owner;

create policy report_runs_definer_owner_update on public.report_runs
  for update to fv_definer_owner using ( true ) with check ( true );

revoke all on public.report_schedule_slots from anon, service_role;
revoke all on public.report_alerts from anon, service_role;
revoke all on public.report_failure_alerts from anon, service_role;

-- ---------------------------------------------------------------------------
-- daily_reports — a run is only a report once it has succeeded
--
-- The join to `report_snapshots` already excluded every failed run, because a failed attempt's
-- snapshot is discarded with the subtransaction that wrote it. The predicate is here anyway:
-- `generated_at` is nullable from this migration on, and a read path that depends on an invariant
-- holding elsewhere is one refactor away from surfacing a run that never produced a report.
--
-- THE JOIN NAMES THE ATTEMPT AS WELL AS THE RUN. A snapshot is keyed `(run_id, attempt_ordinal)`
-- now, so joining on the run alone would be a read path whose correctness depends on a losing
-- attempt's snapshot never surviving. It never does — but this view is what a Director reads, and
-- it says which attempt's report it is serving rather than trusting that there is only one.
--
-- Same columns, same order, same integrity recomputation. Nothing issue #18's screens read changes.
-- ---------------------------------------------------------------------------
create or replace view public.daily_reports
with (security_invoker = true) as
select r.id             as run_id,
       r.business_date,
       r.generated_at,
       r.correlation_id,
       s.id             as snapshot_id,
       s.schema_version,
       s.content,
       s.content_sha256,
       (s.content_sha256 = encode(sha256(convert_to(s.content::text, 'UTF8')), 'hex'))
                        as integrity_ok
  from public.report_runs r
  join public.report_snapshots s
    on s.run_id = r.id
   and s.attempt_ordinal = r.attempt_ordinal
 where r.status = 'succeeded';

-- ---------------------------------------------------------------------------
-- private.claim_report_attempt — the only way an attempt begins
--
-- ONE STATEMENT DECIDES IT, and there are two of them because there are two genuinely different
-- questions. Both are atomic: two callers arriving together for the same slot are serialised by the
-- row, the second re-reads what the first wrote, and its condition is then false. Nothing here
-- reads a row, decides, and writes back — which is the shape that produces two reports, two alerts
-- or two workers on one day.
--
-- ATTEMPT 1 BEGINS A RUN. It is the only ordinal that may create one, so it is an insert whose
-- conflict does nothing: a second slot-1 delivery for a date that already has a run writes nothing
-- at all.
--
-- EVERY OTHER ATTEMPT CONTINUES ONE, and only the NEXT one may. `attempt_ordinal = p_attempt - 1`
-- is the whole rule, and it is deliberately stricter than "a higher ordinal wins":
--
--   · A DUPLICATE delivery of the same slot finds its own ordinal already recorded and does
--     nothing. It cannot consume a further attempt.
--   · AN EARLY OR OUT-OF-ORDER slot — 4 arriving while only 1 has been spent — finds a gap and does
--     nothing. This is what stops a misfiring scheduler declaring a day terminally failed, and
--     alerting two Directors, while 00:15 and 00:30 have not even been tried.
--   · Reaching ordinal 4 therefore requires 1, 2 and 3 to have genuinely failed first, which is
--     what makes "only a genuine failure of the last attempt is terminal" true rather than hoped
--     for.
--
--   THE COST IS AN IMPLEMENTATION LIMITATION, NOT A PRODUCT RULE. If a scheduled slot never fires
--   at all, the sequence stops there: the day keeps its `failed` run and raises no alert, because
--   no attempt ever reached the last ordinal. A Cron worker that does not fire is out of this
--   ticket's scope — it is the case an external watchdog exists for — and the alternative, letting
--   any later slot jump the gap, buys that at the price of an early terminal alert, which is the
--   failure this ticket names explicitly. `architecture.md` §15.2 and the Stage 15 plan record it
--   as a limitation of this implementation. `product.md` requires nothing either way.
--
-- AND IN BOTH CASES the previous attempt must be finished with: either it FAILED, or its lease has
-- EXPIRED and it stopped without saying so. A worker still inside its lease is left alone, because
-- taking a run off it would put two generations on one business date at once.
--
-- THE ROW IS TAKEN WITH `for no key update skip locked`, AND THE LOCK MODE IS THE POINT.
--
-- `skip locked` is there so a slot never blocks on the run row: waiting would hand a stuck worker
-- the power to stall every later slot, which is the failure the lease exists to prevent arriving by
-- another route.
--
-- `for no key update` rather than `for update` is there because `for update` was a REAL DEFECT, and
-- a quiet one. Inserting into `report_snapshots` takes a `KEY SHARE` lock on the run row — that is
-- the foreign key doing its job, not the generator locking anything deliberately — and `KEY SHARE`
-- conflicts with `FOR UPDATE`. So a worker that stalled while generating made this SELECT skip the
-- very row it was sent to reclaim, and the slot reported `lease_held` about a lease that had
-- plainly expired. The night then died: the next slot found a gap and refused in turn.
--
-- `FOR NO KEY UPDATE` is compatible with `KEY SHARE`, and it is all this claim needs: the update
-- below changes `status`, the token, the times and the ordinal, and touches no key column. So a
-- concurrent generation cannot hide the row, and the claim still cannot race another claim —
-- `NO KEY UPDATE` conflicts with itself, so exactly one of two simultaneous slots takes the row.
--
-- The lock is still what makes the claim atomic, because the winner holds it across the update
-- that follows.
--
-- THE ACCEPTED CLAIM IS AUDITED HERE, in the same transaction as the claim itself
-- (architecture.md §14.2). The entry point commits immediately after this function returns, so the
-- claim and its audit record are both durable BEFORE any generation starts — which is what makes a
-- worker that dies mid-report leave something reclaimable behind.
--
-- The business date is derived here, as issue #18 derived it, and the caller supplies neither it
-- nor the token nor the correlation id.
--
-- THE RESULT COLUMNS ARE DELIBERATELY NOT THE COLUMN NAMES. A `returns table` name is a PL/pgSQL
-- variable for the whole body, and `business_date`, `claim_token` and `correlation_id` are all real
-- columns of `report_runs` — so naming them that way makes `on conflict (schedule_id,
-- business_date)` genuinely ambiguous and the claim fails at run time. Prefixed names cannot
-- collide with anything, and the caller reads them by name.
--
-- `claim_refusal` IS THE WHOLE ANSWER TO A REFUSED SLOT, shaped here rather than by the caller. The
-- entry point is a thin procedure that owns transaction boundaries and nothing else; giving it a
-- refusal to compose would be giving it a second opinion about what a refusal means.
-- ---------------------------------------------------------------------------
create or replace function private.claim_report_attempt(p_schedule_code text, p_attempt integer)
returns table (
  outcome           text,
  claimed_run_id    uuid,
  claimed_token     uuid,
  claimed_date      date,
  claim_correlation uuid,
  claim_refusal     jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule public.report_schedules;
  v_date     date;
  v_token    uuid := gen_random_uuid();
  v_corr     uuid := gen_random_uuid();
  v_now      timestamptz := now();
  v_run_id   uuid;
  v_locked   public.report_runs;
  v_existing public.report_runs;
  v_reason   text;
begin
  if p_attempt is null or p_attempt < 1 then
    raise exception 'an attempt ordinal is 1 or greater, not %', p_attempt
      using errcode = 'invalid_parameter_value';
  end if;

  select s.* into v_schedule
    from public.report_schedules s
   where s.code = p_schedule_code
     and s.is_active;

  if not found then
    return query select 'no_active_schedule'::text, null::uuid, null::uuid, null::date, null::uuid,
                        jsonb_build_object('ok', false, 'attempt', p_attempt,
                                           'reason', 'no_active_schedule');
    return;
  end if;

  if p_attempt > v_schedule.final_attempt_ordinal then
    raise exception 'attempt % is beyond the last attempt this schedule has', p_attempt
      using errcode = 'invalid_parameter_value';
  end if;

  -- 00:01, 00:05, 00:15 and 00:30 are all after local midnight, so "today" in Dar es Salaam is
  -- already the new day and every one of the four slots reports on the day that just closed. All
  -- four therefore name the SAME business date, which is what lets a later slot finish what an
  -- earlier one started.
  v_date := private.business_date() - 1;

  if p_attempt = 1 then
    insert into public.report_runs as r (
        schedule_id, business_date, attempt_ordinal, status,
        claim_token, claimed_at, lease_expires_at, correlation_id)
    values (
        v_schedule.id, v_date, p_attempt, 'claimed',
        v_token, v_now, v_now + v_schedule.lease_duration, v_corr)
    on conflict (schedule_id, business_date) do nothing
    returning r.id into v_run_id;
  else
    select r.* into v_locked
      from public.report_runs r
     where r.schedule_id = v_schedule.id
       and r.business_date = v_date
       and r.attempt_ordinal = p_attempt - 1
       and r.status in ('claimed', 'failed')
       and (r.status = 'failed' or r.lease_expires_at <= v_now)
       for no key update skip locked;

    if found then
      update public.report_runs r
         set attempt_ordinal    = p_attempt,
             status             = 'claimed',
             claim_token        = v_token,
             claimed_at         = v_now,
             lease_expires_at   = v_now + v_schedule.lease_duration,
             correlation_id     = v_corr,
             generated_at       = null,
             completed_at       = null,
             failure_diagnostic = null
       where r.id = v_locked.id
      returning r.id into v_run_id;
    end if;
  end if;

  if v_run_id is not null then
    insert into public.audit_events (
      actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
      after_state, correlation_id, source_operation)
    values (
      null, null, true, 'scheduled_report_attempt_claimed', 'report_run', v_run_id,
      jsonb_build_object('business_date', v_date, 'attempt_ordinal', p_attempt),
      v_corr, 'private.claim_report_attempt');

    return query select 'claimed'::text, v_run_id, v_token, v_date, v_corr, null::jsonb;
    return;
  end if;

  -- The claim was refused. WHICH refusal it was matters to the caller and to the audit trail, so it
  -- is named rather than reported as a bare failure.
  select r.* into v_existing
    from public.report_runs r
   where r.schedule_id = v_schedule.id
     and r.business_date = v_date;

  v_reason := case
                when v_existing.id is null                      then 'no_run_to_continue'
                when v_existing.status = 'succeeded'            then 'already_generated'
                when v_existing.status = 'terminally_failed'    then 'already_terminal'
                when v_existing.attempt_ordinal >= p_attempt    then 'attempt_already_used'
                when v_existing.attempt_ordinal < p_attempt - 1 then 'attempt_out_of_sequence'
                else 'lease_held'
              end;

  return query
  select v_reason, null::uuid, null::uuid, v_date, null::uuid,
         jsonb_build_object('ok', true, 'created', false,
                            'attempt',       p_attempt,
                            'reason',        v_reason,
                            'business_date', v_date);
end;
$$;

comment on function private.claim_report_attempt(text, integer) is
  'Claims one (schedule, business date, attempt ordinal) atomically, audits the accepted claim, and '
  'returns a fresh token and a bounded lease — or the shaped refusal saying why it was refused. The '
  'business date is derived here; no caller supplies it. It never waits on a locked run row.';

alter function private.claim_report_attempt(text, integer) owner to fv_definer_owner;
revoke execute on function private.claim_report_attempt(text, integer)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.complete_report_run — success, but only from a worker that still owns AND still holds
-- the run
--
-- TWO GUARDS, AND THE SECOND IS WHY THE LEASE MEANS ANYTHING.
--
--   THE TOKEN says nobody has taken this run from me. A newer claim mints a new one, so a
--   superseded worker's update matches nothing and it is told so — rather than marking a run
--   successful that somebody else is currently, and correctly, retrying.
--
--   THE LEASE says I am still inside the time I was given. Without it, a worker that ran long
--   could still finish — but only until somebody reclaimed it, so whether its half-finished work
--   became the day's report depended on the timing of a Cron slot. Worse, it meant an OVER-LEASE
--   worker was still writing: it would take the snapshot's index entry and the run's foreign-key
--   lock while the very slot sent to replace it was trying to make progress. **A worker past its
--   lease now commits no report**, which is the guarantee the retry design needs and the one the
--   reclaiming slot is entitled to assume.
--
-- A REFUSAL HERE DOES NOT SAY WHICH GUARD REFUSED, and the caller does not need it to. The report
-- is discarded either way; `run_report_attempt` then asks the failure path, whose own read and
-- UPDATE are guarded by the token alone. A worker that was REPLACED fails that guard and writes
-- nothing. A worker that merely RAN OVER still owns the run and records the failure — which on the
-- last ordinal is the terminal failure and its alert (review F2 at `bf49437`).
--
-- `clock_timestamp()` RATHER THAN `now()`, and this is not a preference. `now()` is the
-- TRANSACTION's start time, frozen — so a worker stalled for ten minutes inside its generation
-- would compare its lease against the moment it began and conclude it was comfortably in time. The
-- one function that must know how long this has actually taken is the one that must not use the
-- clock that stopped. The recorded times use it too, so `generated_at` is when the report was
-- generated rather than when its transaction opened.
-- ---------------------------------------------------------------------------
create or replace function private.complete_report_run(p_run_id uuid, p_claim_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_done boolean;
begin
  update public.report_runs r
     set status       = 'succeeded',
         generated_at = clock_timestamp(),
         completed_at = clock_timestamp()
   where r.id = p_run_id
     and r.claim_token = p_claim_token
     and r.status = 'claimed'
     and r.lease_expires_at > clock_timestamp();

  get diagnostics v_done = row_count;
  return v_done;
end;
$$;

comment on function private.complete_report_run(uuid, uuid) is
  'Marks a claimed run successful, if and only if the caller still holds its claim token AND is '
  'still inside its lease. Returns false to a worker that has been superseded or has run over, so '
  'a worker past its lease commits nothing and contends for nothing.';

alter function private.complete_report_run(uuid, uuid) owner to fv_definer_owner;
revoke execute on function private.complete_report_run(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.fail_report_run — the failure record, and where terminal is decided
--
-- Terminal is decided HERE, from the run's own ordinal and the schedule's last one, and nowhere
-- else. A duplicate slot never reaches this function because it never obtained a claim; a
-- concurrent call never reaches it because it never obtained a claim either; an early invocation
-- cannot reach it with ordinal 4 because ordinal 4 cannot be claimed until 3 has been spent.
--
-- ONE STATEMENT, AND IT USED TO BE THREE. The earlier version took `for update of r`, decided the
-- status in PL/pgSQL, and then updated — holding the strongest row lock there is across all of it.
-- `FOR UPDATE` conflicts with the `KEY SHARE` a snapshot insert takes on the run, so a failing
-- worker could sit on the row that a reclaiming slot was trying to read. Deciding the status inside
-- the UPDATE removes the gap and the lock with it: an ordinary UPDATE takes `NO KEY UPDATE`, which
-- a concurrent snapshot insert does not conflict with, and there is no longer a moment between
-- reading the ordinal and writing the status.
--
-- THE LEASE IS DELIBERATELY NOT CHECKED HERE, unlike in `complete_report_run`. A failure record is
-- information, not an outcome anybody acts on: it names the attempt that failed and why, and it
-- leaves the run RECLAIMABLE either way, because `failed` is a claimable state. Refusing to record
-- it would lose the diagnostic and change nothing else. What must not happen is a worker recording
-- a failure against a run somebody else now owns, and the TOKEN already prevents exactly that.
-- ---------------------------------------------------------------------------
create or replace function private.fail_report_run(
  p_run_id uuid, p_claim_token uuid, p_diagnostic text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.report_run_status;
begin
  -- Cast explicitly: `db lint` is right that assigning a text literal to an enum relies on an
  -- implicit conversion, and an enum that gained a fifth value would silently keep working here
  -- while meaning something else.
  update public.report_runs r
     set status = (case when r.attempt_ordinal >= s.final_attempt_ordinal
                        then 'terminally_failed' else 'failed' end)::public.report_run_status,
         completed_at = clock_timestamp(),
         -- Bounded twice: truncated here and constrained on the column. A diagnostic that grew
         -- without limit would be an exception dump in a table a Director can read.
         failure_diagnostic =
           left(coalesce(nullif(btrim(p_diagnostic), ''), 'unknown failure'), 240)
    from public.report_schedules s
   where s.id = r.schedule_id
     and r.id = p_run_id
     and r.claim_token = p_claim_token
     and r.status = 'claimed'
  returning r.status into v_status;

  if v_status is null then
    return 'not_owner';
  end if;

  return v_status::text;
end;
$$;

comment on function private.fail_report_run(uuid, uuid, text) is
  'Records a failed attempt against the run the caller still owns, and returns `failed`, '
  '`terminally_failed` or `not_owner`. Only a genuine failure of the schedule''s last ordinal is '
  'terminal.';

alter function private.fail_report_run(uuid, uuid, text) owner to fv_definer_owner;
revoke execute on function private.fail_report_run(uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.raise_report_failure_alert — one alert, however many times this is called
--
-- Deduplication is the unique constraint plus `on conflict do nothing`, so a second call writes no
-- second alert AND no second audit row.
--
-- IT TAKES THE CLAIM TOKEN TOO, so the alert is guarded exactly as the success and the failure are.
-- A superseded worker cannot alert two Directors about a night that the worker which replaced it is
-- still, correctly, retrying — and that guarantee no longer depends on the caller having checked
-- something first.
--
-- IT ACCEPTS A RUN THAT IS STILL `claimed`, AND THAT IS THE ORDERING FIX RATHER THAN A LOOSENING.
-- The alert is now raised BEFORE the run's status is written, because writing the status first
-- means holding a `NO KEY UPDATE` lock on the run row across this insert — the same defect the
-- success path had, on the other outcome. So the precondition can no longer be "the row says
-- terminal". It is the fact terminal is DERIVED FROM, checked here directly: this run is at the
-- schedule's LAST ordinal, and this caller still owns it. An early or duplicated slot still raises
-- nothing, for the reasons it never could — it cannot reach the last ordinal without spending the
-- ones before it, and it cannot hold the token if somebody else has taken the run.
--
-- `terminally_failed` IS STILL ACCEPTED, so a run whose status is already written can be asked
-- again and be refused BY THE UNIQUE CONSTRAINT rather than by the state check. That is the
-- deduplication rule seen from the outside, and it is what `017_scheduled_report_retries.sql`
-- asserts.
-- ---------------------------------------------------------------------------
create or replace function private.raise_report_failure_alert(p_run_id uuid, p_claim_token uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run      public.report_runs;
  v_alert_id uuid;
begin
  select r.* into v_run
    from public.report_runs r
    join public.report_schedules s on s.id = r.schedule_id
   where r.id = p_run_id
     and r.claim_token = p_claim_token
     and r.attempt_ordinal >= s.final_attempt_ordinal
     and r.status in ('claimed', 'terminally_failed');

  if not found then
    return null;
  end if;

  insert into public.report_alerts
    (schedule_id, business_date, alert_type, priority, correlation_id)
  values
    (v_run.schedule_id, v_run.business_date, 'scheduled_report_failed', 'high',
     v_run.correlation_id)
  on conflict (schedule_id, business_date, alert_type) do nothing
  returning id into v_alert_id;

  if v_alert_id is null then
    return null;
  end if;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    after_state, correlation_id, source_operation)
  values (
    null, null, true, 'scheduled_report_alert_raised', 'report_alert', v_alert_id,
    jsonb_build_object('business_date',   v_run.business_date,
                       'attempt_ordinal', v_run.attempt_ordinal,
                       'priority',        'high'),
    v_run.correlation_id, 'private.raise_report_failure_alert');

  return v_alert_id;
end;
$$;

comment on function private.raise_report_failure_alert(uuid, uuid) is
  'Raises the one high-priority alert for a run at the schedule''s LAST ordinal that the caller '
  'still owns, or returns null because one is already raised, the run is not at that ordinal, or '
  'the token is stale. Called before the terminal status is written, so it accepts a run that is '
  'still claimed. Never raises a second alert for a business date.';

alter function private.raise_report_failure_alert(uuid, uuid) owner to fv_definer_owner;
revoke execute on function private.raise_report_failure_alert(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The scheduler must be able to commit twice, and this migration refuses to install where it
-- cannot
--
-- The entry point below commits the claim BEFORE it generates anything. That is the whole point of
-- it, and PostgreSQL only permits it under conditions that are properties of the ENVIRONMENT rather
-- than of this file. They were established by measurement on PostgreSQL 17.6 with pg_cron 1.6.4,
-- not from the documentation:
--
--   · `cron.use_background_workers` must be OFF. With it on, pg_cron wraps the job in
--     `StartTransactionCommand`/`CommitTransactionCommand` and refuses transaction control outright
--     — its own message is `transaction control statements are not allowed in pg_cron`. With it
--     off, pg_cron sends the command over libpq as a plain simple query, and `CALL` may commit.
--   · The procedure may carry NEITHER `security definer` NOR a `SET` clause. Either one alone makes
--     `COMMIT` fail with `invalid transaction termination`; both were tested separately.
--   · The job command must be ONE statement. Several statements in one simple query become an
--     implicit transaction block, where transaction control is illegal again.
--
-- SO THIS FAILS LOUDLY HERE RATHER THAN AT 00:01. An environment with background workers on cannot
-- honour the lease, and the alternative to refusing is installing four Cron jobs that error every
-- night while the business believes a report is being written. The check is a fact about the
-- server, so it is asserted where the server can answer it.
-- ---------------------------------------------------------------------------
-- IT FAILS CLOSED ON AN UNKNOWN ANSWER AS WELL AS ON A WRONG ONE. `current_setting(..., true)`
-- returns NULL when the GUC does not exist, which happens when pg_cron is not in
-- `shared_preload_libraries` — and an earlier draft read that NULL as "off" via `coalesce`, so the
-- one server that could not run this feature at all was the one server the guard waved through.
-- An unreadable setting is not a reassuring setting: unless the answer is literally `off`, refuse.
do $guard$
declare
  v_setting text := current_setting('cron.use_background_workers', true);
begin
  if v_setting is distinct from 'off' then
    raise exception
      'the scheduled report needs cron.use_background_workers = off; this server reports %',
      coalesce(quote_literal(v_setting), 'no such setting -- is pg_cron preloaded?')
      using errcode = 'feature_not_supported',
            hint = 'pg_cron refuses transaction control in background-worker mode, and the report '
                   'claim must commit before generation begins. Set it off and restart, or the '
                   'lease cannot be honoured.';
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- private.run_report_attempt — everything an accepted claim then does
--
-- This is the second half of an attempt, and it is a function rather than part of the procedure
-- below for one reason: it can then keep `security definer` and `set search_path = ''`, which the
-- procedure cannot have and still commit. All the privileged work stays where the project's
-- convention puts it, and the procedure is left owning transaction boundaries and nothing else.
--
-- IT IS NOT AN ENTRY POINT and must not become one. It presumes a claim that has already been
-- accepted, committed and audited. Nothing is granted EXECUTE on it.
--
-- THE WORK IS IN FOUR PHASES, AND THE ORDER OF THEM IS THE WHOLE POINT OF THIS FUNCTION'S SHAPE.
-- Read it as one rule: **nothing that can stall may happen while the run row is locked.**
--
--   PHASE 1 — BUILDING THE REPORT — WRITES NOTHING AND LOCKS NOTHING. `private.report_content`
--   reads a day of trading across a dozen tables and is by far the longest thing an attempt does,
--   so it is also where a worker is most likely to be stalled, starved or wedged. Its result goes
--   into a local variable. Nothing on `report_runs` is locked, no index entry is taken, and a
--   reclaiming slot arriving during it is not delayed by a single millisecond.
--
--   PHASE 2 — THE SNAPSHOT AND THE DELIVERIES — is keyed on THIS attempt, so it contends with no
--   other attempt's in-flight rows for the same run.
--
--   PHASE 3 — THE AUDIT EVENT — is written before the run is completed, not after. It reads
--   backwards and it is right: the whole block is one subtransaction, so an audit event for a
--   generation that turns out not to belong to this worker is discarded with everything else.
--
--   PHASE 4 — COMPLETING THE RUN — IS THE LAST DATABASE STATEMENT THERE IS. It takes a
--   `NO KEY UPDATE` lock that is held until the entry point commits, which happens immediately
--   afterwards, so the window in which this worker holds the run row is one statement wide. It
--   refuses a stale token AND an expired lease, so an over-lease worker commits nothing.
--
-- THE ORDER WAS PHASE 4 THEN PHASE 3, and that was a real defect rather than untidiness. A worker
-- stalled on the audit insert held the run row's lock for as long as it was stuck; once its lease
-- expired the next slot's claim skipped the row and reported `lease_held` about a lease that had
-- plainly gone. Two live sessions prove the fix, in
-- `tests/integration/report-claim-concurrency.test.ts`.
--
-- THE SNAPSHOT IS KEYED ON THE ATTEMPT, so phase 2 contends with no other attempt even while it is
-- in flight. That is what lets the reclaiming slot make progress rather than merely take ownership
-- and then queue behind the stalled worker's index entry.
--
-- THE FAILURE PATH IS THE SAME FOUR PHASES IN THE SAME ORDER, and that is not symmetry for its own
-- sake — it is the identical defect, found on the identical statement, one outcome later:
--
--   The generation runs inside a subtransaction, so a failure discards the half-written snapshot
--   rather than leaving it. What is then recorded ABOUT that failure is a second subtransaction,
--   ordered exactly as a success is: the failure audit first, the terminal alert second if the
--   schedule's last ordinal has now been spent, and the TOKEN-GUARDED UPDATE OF `report_runs`
--   LAST, with nothing after it.
--
--   MARKING THE RUN `failed` USED TO COME FIRST, and it cost the same thing marking it `succeeded`
--   too early cost. `private.fail_report_run` is an UPDATE, so it takes a `NO KEY UPDATE` lock on
--   the run row and holds it until the entry point commits — and the failure audit, and the alert
--   after it, were both written while that lock was held. A worker stalled on either sat on the
--   run row; once its lease expired the next slot's claim skipped the row it had been sent to
--   reclaim and came back `lease_held`, and the retry sequence stopped there. Two live sessions
--   prove the new order in `tests/integration/report-claim-concurrency.test.ts`.
--
--   WHAT THE OUTCOME WILL BE IS THEREFORE DECIDED BEFORE ANY OF IT, by a plain read that locks
--   nothing. Terminal is still the schedule's last ordinal and nothing else, read off the run row
--   rather than taken from the caller — the same fact `fail_report_run` derives it from, asked one
--   statement earlier so that the alert can be raised before the status is.
--
--   `ZR001` is a user-defined SQLSTATE — Postgres reserves the classes beginning I through Z for
--   exactly this — so losing the lease is told apart from a genuine failure by its code and never
--   by matching a message. It is raised at BOTH ends now: by a success whose completion is refused,
--   and by a failure whose final update is refused. A superseded worker records nothing at all
--   either way: no snapshot, no delivery, no success, no failure, no terminal state, no alert and
--   no audit event of any kind. Everything is inside a subtransaction precisely so that the
--   ownership check can discard it after it has been written.
--
-- A REFUSED COMPLETION IS NOT YET A LOST LEASE, and treating it as one was review F2 at `bf49437`.
-- `complete_report_run` refuses a stale token AND an expired lease, and those are different facts.
-- A worker that ran past its lease with nobody sent to replace it — the last attempt, which has no
-- later slot, is the case that matters — still owns the run. Returning `lease_lost` for it left the
-- run `claimed` at the final ordinal with no diagnostic and no alert, and no slot left to take it.
--
-- So a refused completion discards the report exactly as before, and then goes down THE FAILURE
-- PATH BELOW, with a diagnostic saying the lease ran out. That path decides ownership by its own
-- token-guarded read and token-guarded UPDATE, which is the distinction wanted:
--
--   · STILL THE OWNER — the run is `claimed` under this token. The failure is recorded like any
--     other, in the same order and under the same lock discipline; on the last ordinal that is the
--     terminal state and its one alert.
--   · REPLACED — a newer claim holds the run, before the read or between the read and the UPDATE.
--     The read finds nothing, or the UPDATE matches nothing and raises `ZR001`, discarding the
--     audit and alert it had written. Nothing is recorded, and the answer is `lease_lost` as it
--     always was.
-- ---------------------------------------------------------------------------
create or replace function private.run_report_attempt(
  p_run_id         uuid,
  p_claim_token    uuid,
  p_business_date  date,
  p_correlation_id uuid,
  p_attempt        integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content    jsonb;
  v_snapshot   uuid;
  v_sha        text;
  v_recipients integer := 0;
  v_lease_lost boolean := false;
  v_failed     boolean := false;
  v_diagnostic text;
  v_state      text;
  v_alert_id   uuid;
  v_superseded boolean := false;
begin
  begin
    -- PHASE 1. The long read, into a variable. It takes no lock on `report_runs` and claims no
    -- index entry, so a slot sent to reclaim this run while it is running is never delayed by it.
    v_content := private.report_content(p_business_date);

    -- PHASE 2. Short, and keyed on THIS attempt, so it cannot collide with another attempt's
    -- in-flight snapshot for the same run.
    insert into public.report_snapshots
      (run_id, business_date, attempt_ordinal, schema_version, content)
    values (p_run_id, p_business_date, p_attempt, 1, v_content)
    returning id, content_sha256 into v_snapshot, v_sha;

    -- Every active Director and Manager present at generation (§18.1), unchanged from issue #18.
    insert into public.report_deliveries (snapshot_id, recipient_id, recipient_role)
    select v_snapshot, p.id, r.role
      from public.profiles p
      join public.user_roles r on r.user_id = p.id
     where p.is_active
       and r.role in ('director', 'manager');

    get diagnostics v_recipients = row_count;

    -- PHASE 3. The audit event goes in BEFORE the run is completed, and that order is deliberate.
    --
    -- It reads backwards — recording a generation this worker has not yet been told it may claim —
    -- and it is right for the same reason the snapshot above is written before the check: this is
    -- all one subtransaction, so if the check refuses, every row of it is discarded together. The
    -- audit trail cannot end up with a generation the run never had.
    --
    -- What the previous order cost, and it is the whole reason this moved: `complete_report_run`
    -- takes a `NO KEY UPDATE` lock on the run row and holds it until the transaction commits. With
    -- the audit AFTER it, a worker stalled on that one insert sat on the run row — so once its
    -- lease expired the next slot's claim skipped the row and reported `lease_held`, which is
    -- exactly the failure the lease exists to prevent, arriving one statement later than before.
    insert into public.audit_events (
      actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
      after_state, correlation_id, source_operation)
    values (
      null, null, true, 'scheduled_report_generated', 'report_snapshot', v_snapshot,
      jsonb_build_object('business_date',   p_business_date,
                         'content_sha256',  v_sha,
                         'recipient_count', v_recipients,
                         'attempt_ordinal', p_attempt),
      p_correlation_id, 'private.run_report_attempt');

    -- PHASE 4. THE LAST DATABASE STATEMENT OF A SUCCESSFUL ATTEMPT, and nothing may be added after
    -- it. From here the run row is locked until the entry point commits, which it does immediately;
    -- any statement placed below this line would extend that lock by however long it takes, and a
    -- worker that stalled there would take the night down with it.
    --
    -- It refuses a stale token and an expired lease alike, and either refusal raises — discarding
    -- the snapshot, the deliveries and the audit event above in one go, so an over-lease worker
    -- commits no report. Which of the two it was is settled below, by the failure path.
    if not private.complete_report_run(p_run_id, p_claim_token) then
      raise exception 'this worker no longer holds a live claim on the report run'
        using errcode = 'ZR001';
    end if;

  exception
    when sqlstate 'ZR001' then
      -- NOT A RETURN. The report is gone with the subtransaction; whether this worker still owns
      -- the run, and so must record the attempt as failed, is for the token-guarded failure path
      -- below to decide. Only if it does not is the answer `lease_lost`.
      v_lease_lost := true;
      v_failed     := true;
      v_diagnostic := 'ZR001: the attempt ran past its lease; its report was discarded';

    -- `QUERY_CANCELED` IS NAMED, BECAUSE `OTHERS` DOES NOT INCLUDE IT. PL/pgSQL's `OTHERS` matches
    -- every error except `query_canceled` and `assert_failure`, so a generation cancelled by
    -- `statement_timeout` or `pg_cancel_backend` used to skip this handler altogether: the error
    -- escaped, rolled transaction 2 back, and left the run `claimed` with no diagnostic. On attempts
    -- 1-3 only the lease rescued the night; on the last one nothing did — the ordinal was spent,
    -- there is no later slot, and no alert was ever written (review F1 at `04d5ab0`).
    --
    -- A cancelled generation is a failed generation, and it is recorded exactly like one: the
    -- subtransaction's partial work is discarded, and the token-guarded failure below is written.
    --
    -- TRAPPING IT ONCE IS BOUNDED. `statement_timeout` is one timer per top-level statement — the
    -- `CALL` — and it does not re-arm at the procedure's internal commits, so once it has fired the
    -- short failure record below runs to completion. That record survives ONE cancellation of its
    -- own and re-raises a second, so an operator who keeps cancelling is not overruled for long.
    when query_canceled or others then
      -- A SQLSTATE and a message, whitespace flattened and truncated. No `PG_EXCEPTION_DETAIL`,
      -- which carries the offending row's values; no `PG_EXCEPTION_CONTEXT`, which carries the
      -- statement text. What is left names the kind of failure and the object it happened on, which
      -- is what an operator needs and all they need.
      v_failed     := true;
      v_diagnostic := left(regexp_replace(sqlstate || ': ' || coalesce(sqlerrm, ''),
                                          '\s+', ' ', 'g'), 200);
  end;

  if v_failed then
    -- WHICH OUTCOME THIS IS, decided before a single row of it is written and by a read that takes
    -- no lock on the run. It is the same rule `fail_report_run` applies in its own UPDATE below and
    -- from the same two columns, asked early so that the audit event and the alert can name the
    -- outcome without the status having been written first.
    --
    -- The two cannot disagree. Both require this token and a `claimed` run, and the only thing that
    -- moves an ordinal is a new claim — which mints a new token, so a run reclaimed in between
    -- fails the guard on the UPDATE rather than being failed under the wrong ordinal.
    --
    -- THE RECORD IS TRIED AT MOST TWICE, and only a cancellation earns the second try. An ordinary
    -- failure that lands just before `statement_timeout` would otherwise have the timer fire HERE,
    -- inside the record rather than inside the generation — the same missing alert by a second
    -- route. Each try is its own subtransaction, so a cancelled first try leaves nothing behind for
    -- the second to duplicate. The timer does not re-arm within the `CALL`, so the second try runs
    -- to completion; a further, deliberate cancel during it is re-raised and not overruled.
    for v_try in 1 .. 2 loop
      begin
        select case when r.attempt_ordinal >= s.final_attempt_ordinal
                    then 'terminally_failed' else 'failed' end
          into v_state
          from public.report_runs r
          join public.report_schedules s on s.id = r.schedule_id
         where r.id = p_run_id
           and r.claim_token = p_claim_token
           and r.status = 'claimed';

        if v_state is null then
          -- Superseded before this worker wrote anything about its failure. There is nothing to
          -- discard, so there is nothing to discard it with.
          v_superseded := true;
          exit;
        end if;

        -- PHASE 3 AGAIN, and before the run row for the reason it precedes a success: this is one
        -- subtransaction, so an audit event for a failure that turns out not to be this worker's
        -- to record is discarded with the rest of it.
        insert into public.audit_events (
          actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
          after_state, correlation_id, source_operation)
        values (
          null, null, true, 'scheduled_report_attempt_failed', 'report_run', p_run_id,
          jsonb_build_object('business_date',   p_business_date,
                             'attempt_ordinal', p_attempt,
                             'status',          v_state,
                             'diagnostic',      v_diagnostic),
          p_correlation_id, 'private.run_report_attempt');

        -- The alert, and its own audit row, are raised by the same function as before — which now
        -- checks the LAST ORDINAL and the token rather than a status that has deliberately not been
        -- written yet. It is still deduplicated by the unique constraint, and a second call still
        -- writes neither a second alert nor a second audit row.
        if v_state = 'terminally_failed' then
          v_alert_id := private.raise_report_failure_alert(p_run_id, p_claim_token);
        end if;

        -- PHASE 4 AGAIN. THE LAST DATABASE STATEMENT OF A FAILED ATTEMPT, and nothing may be added
        -- after it. From here the run row is locked until the entry point commits, which it does
        -- immediately; the whole point of the two writes above is that they happen before this
        -- line rather than after it.
        if private.fail_report_run(p_run_id, p_claim_token, v_diagnostic) = 'not_owner' then
          raise exception 'a newer claim owns this report run'
            using errcode = 'ZR001';
        end if;

        exit;

      exception
        when sqlstate 'ZR001' then
          -- The audit event and the alert above go with it. A superseded worker leaves nothing.
          v_superseded := true;
          exit;

        when query_canceled then
          -- This try's audit event and alert were discarded with it. Try once more, then give up.
          v_alert_id := null;
          if v_try = 2 then
            raise;
          end if;
      end;
    end loop;

    if v_superseded then
      v_state    := 'not_owner';
      v_alert_id := null;

      -- A refused completion that turned out to be a replacement, not just an overrun: the same
      -- answer a superseded worker has always been given, and it has written nothing.
      if v_lease_lost then
        return jsonb_build_object('ok', true, 'created', false,
                                  'attempt',       p_attempt,
                                  'reason',        'lease_lost',
                                  'business_date', p_business_date,
                                  'run_id',        p_run_id);
      end if;
    end if;

    -- Returns NORMALLY. Raising here would roll the failure record back and leave the night looking
    -- as though nothing had been attempted at all.
    return jsonb_build_object('ok', false, 'created', false,
                              'attempt',        p_attempt,
                              'business_date',  p_business_date,
                              'run_id',         p_run_id,
                              'status',         v_state,
                              'terminal',       v_state = 'terminally_failed',
                              'alert_id',       v_alert_id,
                              'diagnostic',     v_diagnostic,
                              'correlation_id', p_correlation_id);
  end if;

  return jsonb_build_object('ok', true, 'created', true,
                            'attempt',         p_attempt,
                            'business_date',   p_business_date,
                            'run_id',          p_run_id,
                            'snapshot_id',     v_snapshot,
                            'content_sha256',  v_sha,
                            'recipient_count', v_recipients,
                            'correlation_id',  p_correlation_id);
end;
$$;

comment on function private.run_report_attempt(uuid, uuid, date, uuid, integer) is
  'The work of one already-claimed attempt: the snapshot, the deliveries, and the token-guarded '
  'success or failure. Not an entry point — it presumes a committed claim and is granted to nobody.';

alter function private.run_report_attempt(uuid, uuid, date, uuid, integer) owner to fv_definer_owner;
revoke execute on function private.run_report_attempt(uuid, uuid, date, uuid, integer)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.run_scheduled_report — the one scheduled entry point
--
-- IT TAKES ITS SLOT ORDINAL AND NOTHING ELSE. Not a business date, not an actor, not a correlation
-- id — those are still derived inside the database exactly as issue #18 derived them, so a caller
-- cannot aim this at another day, credit the work to somebody, or make two unrelated events look
-- like one. The ordinal is the one thing a scheduler legitimately knows: which of its four slots
-- has just fired.
--
-- IT IS A PROCEDURE, AND IT COMMITS TWICE, and that is the whole reason it exists separately from
-- the two functions it calls:
--
--   TRANSACTION 1 is the claim and its audit record. It commits before a single row of the report
--   is read. From that moment the run row says `claimed`, with a token and a lease that expires —
--   so a worker that is killed, disconnected or wedged mid-generation leaves a claim the next slot
--   can take, instead of a rolled-back transaction that leaves the night looking untouched.
--
--   TRANSACTION 2 is the generation. It holds NO lock on the run row while it works, because the
--   claim already committed and released it. A worker that hangs for an hour inside `report_content`
--   therefore cannot stall the 00:05 slot behind a row lock — which it could when the claim and the
--   work were one transaction, and which would have made the lease unenforceable in exactly the
--   case it was written for.
--
-- IT CARRIES NO `security definer` AND NO `SET` CLAUSE, because either one makes `COMMIT` illegal
-- (see the guard above). Two things follow, and both are deliberate:
--
--   · EVERY IDENTIFIER IN THIS BODY IS SCHEMA-QUALIFIED. It cannot pin its own `search_path`, so it
--     relies on nothing that a `search_path` could redirect. There is no table access here at all.
--   · THE PRIVILEGED WORK IS STILL DONE BY DEFINER FUNCTIONS owned by `fv_definer_owner`. This
--     procedure runs as whoever Cron runs jobs as and writes nothing itself, so the least-privilege
--     boundary is exactly where it was.
--
-- Transaction control is legal here only because the outer block has no exception handler. A
-- failure inside `run_report_attempt` is handled by that function's own subtransaction; a failure
-- this procedure cannot handle rolls transaction 2 back and leaves the committed claim behind,
-- which is the correct outcome and not a lost night.
-- ---------------------------------------------------------------------------
drop function if exists private.generate_scheduled_report();
drop function if exists private.generate_scheduled_report(integer);

create or replace procedure private.run_scheduled_report(
  p_attempt integer,
  inout p_result jsonb default null)
language plpgsql
as $$
declare
  v_claim record;
begin
  select c.* into v_claim
    from private.claim_report_attempt('daily_pilot_report', p_attempt) c;

  if v_claim.outcome <> 'claimed' then
    -- Every refusal is a no-op that says which one it was, in the words the claim itself chose.
    -- None of them writes anything: no run, no snapshot, no delivery, no spent ordinal, no alert.
    p_result := v_claim.claim_refusal;
    commit;
    return;
  end if;

  -- THE CLAIM BECOMES DURABLE HERE, and nothing has been generated yet.
  commit;

  p_result := private.run_report_attempt(
    v_claim.claimed_run_id,
    v_claim.claimed_token,
    v_claim.claimed_date,
    v_claim.claim_correlation,
    p_attempt);

  -- AND THE COMMIT IS THE VERY NEXT THING, with no read and no write between it and the attempt
  -- returning. A successful attempt ends on `complete_report_run`, which holds a `NO KEY UPDATE`
  -- lock on the run row until this line runs; anything inserted here would extend that lock by
  -- however long it took, and put back the window that assigning `p_result` — a variable, not a
  -- statement — deliberately does not open.
  commit;
end;
$$;

comment on procedure private.run_scheduled_report(integer, jsonb) is
  'The scheduled report entry point, called by all four Cron slots with their own fixed attempt '
  'ordinal. Commits the claim before generating anything, so a worker that dies leaves a '
  'reclaimable claim and a worker that hangs holds no lock on the run row.';

-- Outside the Data API twice over, exactly as issue #18 left it: `private` is not an exposed
-- schema, AND no Data API role holds EXECUTE. The only grant is to the role Supabase Cron runs
-- jobs as.
revoke execute on procedure private.run_scheduled_report(integer, jsonb)
  from public, anon, authenticated, service_role;
grant execute on procedure private.run_scheduled_report(integer, jsonb) to postgres;

-- ---------------------------------------------------------------------------
-- Supabase Cron — four named jobs, four fixed ordinals
--
-- IN THE SAME TRANSACTION AS EVERYTHING ABOVE, so this migration lands whole or not at all.
--
-- 21:01, 21:05, 21:15 and 21:30 UTC are 00:01, 00:05, 00:15 and 00:30 the next day in Dar es
-- Salaam. Tanzania is UTC+3 with no daylight saving, so these are exact correspondences.
--
-- No job exists before this point (the success migration registers none). The 00:01 job keeps the
-- name issue #18 gave it, and `cron.schedule` upserts on the name, so re-running this block
-- re-registers the same four jobs rather than accumulating duplicates.
--
-- EACH COMMAND IS A SINGLE `CALL`. That is a requirement rather than a style: several statements in
-- one pg_cron command become one implicit transaction block, and the entry point could then not
-- commit its claim. There is nothing else on these lines for the same reason.
--
-- The commands are BUILT FROM `report_schedule_slots`, so the jobs and the rows describing them
-- cannot drift apart: there is one place where "attempt 3 fires at 21:15 UTC" is written down.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;

do $cron$
declare
  v_slot record;
begin
  for v_slot in
    select slot.attempt_ordinal, slot.cron_expression, slot.job_name
      from public.report_schedule_slots slot
      join public.report_schedules s on s.id = slot.schedule_id
     where s.code = 'daily_pilot_report'
     order by slot.attempt_ordinal
  loop
    perform cron.schedule(
      v_slot.job_name,
      v_slot.cron_expression,
      format('call private.run_scheduled_report(%s);', v_slot.attempt_ordinal));
  end loop;
end
$cron$;

commit;
