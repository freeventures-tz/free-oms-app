-- Stage 15 · The scheduled pilot report: one visible reporting success path
--
-- ISSUE #51 INTEGRATION. This is the reviewed success path of issue #18 (source `0d15524`, as
-- amended by issue #19 at `a34704a`), brought onto the released v0.1.0 schema. Two things differ
-- from that source and both are deliberate:
--
--   · THE IMPREST SECTION READS THE RELEASED FUNDING SCHEMA. The source read a fund number, a fund
--     status, approval and provision columns on the funding row, an expense table, a position view
--     and a reconciliation table — none of which exists on main. It now follows the Owner-approved
--     presentation of 23 September 2026, "receipts plus explicit unavailable states": see
--     `private.report_content` below.
--   · NO CRON JOB IS REGISTERED HERE. This migration and
--     `20260923000200_scheduled_report_retries_and_alerts.sql` are ONE release unit; the four named
--     jobs are registered at the foot of that one, once the retry machinery exists. A success-only
--     scheduler never runs, even between the two files.
--
-- At 00:01 Africa/Dar_es_Salaam the database writes yesterday's report by itself, and a Director or
-- a Manager reads it on a phone. That is the whole of this slice. Four rules shape every object
-- below, and each one is a place where the obvious model is the wrong one.
--
--   0. EVERY OBJECT STATES ITS OWN EXPOSURE. architecture.md §5.5: "Every table, view, and
--      function states its exposure and grants in the migration that creates it." So the four
--      tables, the view, their row-level security, their policies and their exact GRANTs are all
--      here — there is no window in which one of them exists unprotected, and the generator and
--      the schedule further down state their own grants beside themselves.
--
--   1. THE SCHEDULE IS INSIDE THE DATABASE. product.md §18 puts the report in the app and nowhere
--      else, and the data it summarises is already in Postgres. Supabase Cron (registered by the
--      next migration) calls one `private` entry point directly, so there is no HTTP route, no `CRON_SECRET`, no service key and no
--      deployment in the execution path — nothing to leak and nothing to keep in step with a
--      release. The mechanism decision and the alternatives it beat are recorded in the workspace
--      research note `docs/research/scheduled-report-execution-mechanism.md`.
--
--   2. THE BUSINESS DATE IS DERIVED, NEVER SUPPLIED. `private.generate_scheduled_report()` takes no
--      arguments at all: no date, no actor, no correlation id. A function that cannot be told which
--      day to report on cannot be made to rewrite a different day's history, whoever calls it.
--
--   3. A SNAPSHOT IS IMMUTABLE, AND SO IS ITS DIGEST (§18.3). The SHA-256 is stamped by a trigger
--      from the content itself, so no caller can store a digest that does not match what it
--      describes; a second trigger refuses every UPDATE and DELETE; and `public.daily_reports`
--      recomputes the digest at READ time, so the screen states an integrity fact rather than
--      repeating a stored claim.
--
--   4. MISSING IS NOT ZERO (§15.2a, §18.2a). A count that was never taken is `not_counted` with a
--      NULL amount and a NULL variance. A count the Manager has not confirmed is
--      `awaiting_manager_confirmation`, which is a different thing again. Neither is ever written
--      as a zero, and neither blocks the report.
--
-- WHO MAY READ A REPORT. Both Directors and the Manager, and nobody else (product.md §18.1). A
-- Cashier and a Sales Representative are refused by the database, not merely denied a menu entry:
-- every policy below names the two allowed roles, and `private.authorize` re-checks that the
-- account is active and past its first-login gate on every candidate row.
--
-- WHO MAY WRITE ONE. Nothing with a session. `authenticated` is granted SELECT and nothing else,
-- `service_role` is granted nothing at all, and the generator lives in `private` — a schema absent
-- from the Data API list in `supabase/config.toml` — granted to one database role. Nothing
-- schedules it: the next migration replaces it with the retrying entry point and registers the
-- Cron jobs for that.
--
-- ONE RULE DECIDES WHICH DAY A FACT BELONGS TO. Where a table already stores a business date —
-- invoices and payments do — that column is authoritative, because it was computed when the
-- document was issued and can never drift. Everywhere else the fact belongs to the local calendar
-- date of the moment the business RECORDED it, asked as the day's two Africa/Dar_es_Salaam
-- endpoints and a bare `column >= start and column < next start`. Two sections are a position
-- rather than a flow and say so in the snapshot: paid-but-unreleased goods and pending approvals
-- are stated as at the moment of generation, because "how many are still waiting" has no meaning
-- as a daily total.
--
-- AND EVERY FIGURE IS AS AT THE CUTOFF, never as at now. What was cancelled, corrected or paid
-- after midnight belongs to a later day's report. A snapshot that moved as the world moved would
-- not be a snapshot — which is why an invoice cancelled after the report's date is still counted
-- as outstanding on it.
--
-- WHAT THIS SLICE DID NOT HAVE, AND WHAT ARRIVED NEXT. The 00:05, 00:15 and 00:30 retries,
-- failed-run records, claims, leases, terminal failure and the final-failure alert are issue #19,
-- the next ticket in the publication sequence approved on issue #16, and they are added by
-- `20260923000200_scheduled_report_retries_and_alerts.sql`. READ THIS FILE AS THE FIRST HALF: what
-- it says about `report_runs` having no status, and about a failure leaving no row behind, was true
-- when it was written and is superseded there. Manual and amended reports, PDF export and
-- reconciliation ENTRY screens are later still, and none of them exists yet.

begin;

-- ---------------------------------------------------------------------------
-- report_schedules — what runs, when, and in which zone
--
-- The local time and the UTC cron expression are stored TOGETHER so the correspondence between
-- them is a fact a test can read rather than a comment somebody has to trust. 21:01 UTC is 00:01 on
-- the following calendar day in Africa/Dar_es_Salaam, which is UTC+3 with no daylight saving
-- (architecture.md §5.12).
-- ---------------------------------------------------------------------------
create table public.report_schedules (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique check (length(btrim(code)) between 1 and 60),
  time_zone       text not null default 'Africa/Dar_es_Salaam',
  local_run_time  time not null,
  cron_expression text not null check (length(btrim(cron_expression)) between 1 and 100),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

comment on table public.report_schedules is
  'The named daily report schedules (product.md 18.2). One row today: the previous business day''s '
  'report at 00:01 Africa/Dar_es_Salaam, registered with Supabase Cron as 21:01 UTC.';

insert into public.report_schedules (code, local_run_time, cron_expression)
values ('daily_pilot_report', '00:01', '1 21 * * *');

-- ---------------------------------------------------------------------------
-- report_runs — one successful scheduled generation per business date
--
-- The unique constraint IS the idempotency rule of §18.2: "once a report has generated
-- successfully, later attempts do nothing". A duplicate invocation loses the insert race and takes
-- the `do nothing` branch, so a replayed cron slot cannot produce a second snapshot or a second
-- set of deliveries.
--
-- A row here meant the report was generated, and nothing else: a generation that failed raised, the
-- transaction rolled back, and no run existed. THAT IS NO LONGER THE WHOLE STORY — issue #19 adds
-- `status`, `attempt_ordinal`, a claim token, a lease and a bounded failure diagnostic to this
-- table, so a row is now a run in one of four states. The unique constraint below is unchanged and
-- still carries the same rule.
-- ---------------------------------------------------------------------------
create table public.report_runs (
  id             uuid primary key default gen_random_uuid(),
  schedule_id    uuid not null references public.report_schedules (id) on delete restrict,
  business_date  date not null,
  generated_at   timestamptz not null default now(),

  -- Minted inside the function. Nothing outside supplies it, so it cannot be reused to make two
  -- unrelated events look like one (architecture.md §14.2).
  correlation_id uuid not null,

  unique (schedule_id, business_date)
);

create index report_runs_date_idx on public.report_runs (business_date desc);

comment on table public.report_runs is
  'One successful scheduled report generation per (schedule, business date). Its existence is the '
  'success; the unique constraint is what makes a duplicate cron invocation a no-op.';

-- ---------------------------------------------------------------------------
-- report_snapshots — the immutable structured report (§18.3)
--
-- `content` is the whole report. Everything the screen shows is read from it, so what a Director
-- reads in a year is what the business looked like on the night it was written, whatever has been
-- corrected since.
-- ---------------------------------------------------------------------------
create table public.report_snapshots (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null unique references public.report_runs (id) on delete restrict,
  business_date  date not null,
  schema_version integer not null check (schema_version > 0),
  content        jsonb not null,

  -- Stamped by a trigger from `content`, never accepted from a caller. The check is a shape check
  -- only; the guarantee that the value DESCRIBES the content is the trigger's.
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),

  created_at     timestamptz not null default now()
);

create index report_snapshots_date_idx on public.report_snapshots (business_date desc);

comment on column public.report_snapshots.content_sha256 is
  'SHA-256 of the canonical jsonb text of content, stamped on insert and reproducible: the same '
  'content always digests to the same value, and public.daily_reports recomputes it on every read.';

-- ---------------------------------------------------------------------------
-- The digest, and the immutability that gives it meaning
-- ---------------------------------------------------------------------------
create or replace function private.stamp_report_digest()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- jsonb has one canonical text form — keys ordered, whitespace fixed, duplicates already resolved
  -- — so this digest is reproducible from the stored value alone, on any server, in any session.
  new.content_sha256 := encode(sha256(convert_to(new.content::text, 'UTF8')), 'hex');
  return new;
end;
$$;

alter function private.stamp_report_digest() owner to fv_definer_owner;
revoke execute on function private.stamp_report_digest()
  from public, anon, authenticated, service_role;

create trigger report_snapshots_stamp_digest
  before insert on public.report_snapshots
  for each row execute function private.stamp_report_digest();

create or replace function private.refuse_report_snapshot_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'a report snapshot is immutable; a correction creates an amended version'
    using errcode = 'restrict_violation';
end;
$$;

alter function private.refuse_report_snapshot_change() owner to fv_definer_owner;
revoke execute on function private.refuse_report_snapshot_change()
  from public, anon, authenticated, service_role;

-- BEFORE, and for every row, so the refusal happens whoever holds the privilege — including the
-- definer owner that wrote the row in the first place. The GRANTs below withhold UPDATE and DELETE
-- as well; a table protected twice is still protected when somebody edits one of the two.
create trigger report_snapshots_immutable
  before update or delete on public.report_snapshots
  for each row execute function private.refuse_report_snapshot_change();

-- ---------------------------------------------------------------------------
-- report_deliveries — who the report was produced for (§18.1)
--
-- Recipients are both Directors and the Manager, and the CHECK says so in the schema rather than
-- only in the function that writes it: a Cashier or a Sales Representative cannot be given a
-- delivery row by any future code path, correct or careless.
-- ---------------------------------------------------------------------------
create table public.report_deliveries (
  id             uuid primary key default gen_random_uuid(),
  snapshot_id    uuid not null references public.report_snapshots (id) on delete restrict,
  recipient_id   uuid not null references public.profiles (id) on delete restrict,
  recipient_role public.app_role not null
    check (recipient_role in ('director', 'manager')),
  delivered_at   timestamptz not null default now(),

  unique (snapshot_id, recipient_id)
);

create index report_deliveries_recipient_idx
  on public.report_deliveries (recipient_id, delivered_at desc);

comment on table public.report_deliveries is
  'In-app delivery records (product.md 18.1). One row per active Director and Manager present '
  'when the report was generated. There is no email, SMS or WhatsApp channel in V1.';

-- ---------------------------------------------------------------------------
-- daily_reports — what a screen reads
--
-- `integrity_ok` is RECOMPUTED here from the stored content on every read. A view that simply
-- returned the stored digest would be reporting the claim rather than checking it.
-- ---------------------------------------------------------------------------
create view public.daily_reports
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
  join public.report_snapshots s on s.run_id = r.id;

comment on view public.daily_reports is
  'One generated daily report, with its integrity recomputed from the stored snapshot at read '
  'time. security_invoker, so the reader''s own policies decide what they may see.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------
alter table public.report_schedules  enable row level security;
alter table public.report_runs       enable row level security;
alter table public.report_snapshots  enable row level security;
alter table public.report_deliveries enable row level security;

grant select on public.report_schedules  to authenticated;
grant select on public.report_runs       to authenticated;
grant select on public.report_snapshots  to authenticated;
grant select on public.report_deliveries to authenticated;
grant select on public.daily_reports     to authenticated;

-- Explicit, though nothing granted them: a report is written by the schedule alone, and saying so
-- here means a later `grant all` on the schema cannot quietly hand a session write access.
revoke insert, update, delete on public.report_schedules  from authenticated;
revoke insert, update, delete on public.report_runs       from authenticated;
revoke insert, update, delete on public.report_snapshots  from authenticated;
revoke insert, update, delete on public.report_deliveries from authenticated;

create policy report_schedules_select on public.report_schedules
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

create policy report_runs_select on public.report_runs
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

create policy report_snapshots_select on public.report_snapshots
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

create policy report_deliveries_select on public.report_deliveries
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

-- The definer owner is not the table owner, so RLS applies to it inside SECURITY DEFINER functions
-- exactly as it does to anybody else. It needs read on the schedule and write on the three records
-- the generator creates — and no UPDATE or DELETE anywhere, because it never changes one. (Issue
-- #19 grants it UPDATE on `report_runs` alone, and says so beside the grant: a run is claimed and
-- then finalised, so that one table really is changed. A snapshot and a delivery still never are.)
grant select         on public.report_schedules  to fv_definer_owner;
grant select, insert on public.report_runs       to fv_definer_owner;
grant select, insert on public.report_snapshots  to fv_definer_owner;
grant select, insert on public.report_deliveries to fv_definer_owner;

create policy report_schedules_definer_owner_read on public.report_schedules
  for select to fv_definer_owner using ( true );

create policy report_runs_definer_owner_read on public.report_runs
  for select to fv_definer_owner using ( true );
create policy report_runs_definer_owner_insert on public.report_runs
  for insert to fv_definer_owner with check ( true );

create policy report_snapshots_definer_owner_read on public.report_snapshots
  for select to fv_definer_owner using ( true );
create policy report_snapshots_definer_owner_insert on public.report_snapshots
  for insert to fv_definer_owner with check ( true );

create policy report_deliveries_definer_owner_read on public.report_deliveries
  for select to fv_definer_owner using ( true );
create policy report_deliveries_definer_owner_insert on public.report_deliveries
  for insert to fv_definer_owner with check ( true );

-- The secret key reaches `api.service_*` and nothing else (architecture.md §5.5). A report is not
-- its business, and a leaked key must not become a way to read one.
revoke all on public.report_schedules  from anon, service_role;
revoke all on public.report_runs       from anon, service_role;
revoke all on public.report_snapshots  from anon, service_role;
revoke all on public.report_deliveries from anon, service_role;
revoke all on public.daily_reports     from anon, service_role;

-- ---------------------------------------------------------------------------
-- private.report_reconciliation_state — one shape for every count, taken or not
--
-- Four places in this file report a cash count: the till, and an imprest count that is missing,
-- unconfirmed or confirmed. They must produce the SAME six keys, because the screen reads them by
-- name and a key missing from one of the four is a figure that silently disappears. Building the
-- object four times by hand is how that happens — it already had, once, before this function
-- existed.
-- ---------------------------------------------------------------------------
create or replace function private.report_reconciliation_state(
  p_state           text,
  p_counted_tzs     bigint,
  p_expected_tzs    bigint,
  p_variance_tzs    bigint,
  p_variance_reason text,
  p_missing_reason  text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'state',           p_state,
    'counted_tzs',     p_counted_tzs,
    'expected_tzs',    p_expected_tzs,
    'variance_tzs',    p_variance_tzs,
    'variance_reason', p_variance_reason,
    'missing_reason',  p_missing_reason);
$$;

comment on function private.report_reconciliation_state(text, bigint, bigint, bigint, text, text) is
  'One cash count as the report carries it (product.md 15.2a). A count nobody took passes NULL '
  'amounts and a reason; it is never given zeroes.';

alter function private.report_reconciliation_state(text, bigint, bigint, bigint, text, text)
  owner to fv_definer_owner;
revoke execute on function private.report_reconciliation_state(text, bigint, bigint, bigint, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.report_content — the approved pilot content for one business date
--
-- Separate from the entry point on purpose. This one takes a date because it is a pure reader with
-- no side effect, which is what makes it testable; the ENTRY POINT takes nothing, which is what
-- makes it unabusable. Splitting them is how both are true at once.
--
-- Every figure comes from existing database truth. Nothing here defines a new sales, settlement,
-- stock, production or imprest rule, and nothing here writes.
-- ---------------------------------------------------------------------------
create or replace function private.report_content(p_business_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- THE BUSINESS DAY AS TWO MOMENTS. Every section below asks "did this happen on the report's
  -- day", and there are two ways to ask it. Wrapping the column — `local_date(col) = the_date` —
  -- reads well and is the wrong one: the expression has to be evaluated for every row in the table
  -- before anything can be discarded, so no index on that column can be used and the planner has no
  -- statistics for what it is about to do. Computing the day's two endpoints ONCE and comparing the
  -- bare column against them asks the same question in a form an index can answer.
  --
  -- Half-open on purpose: `>= v_from and < v_to`. A closed upper bound needs the last representable
  -- instant of the day, and every attempt to write one either loses the microseconds after 23:59:59
  -- or counts midnight into two business days at once.
  --
  -- A NULL column falls outside both comparisons, which is the same answer the previous form gave:
  -- `confirmed_at` and `released_at` are null until the thing happens, and a thing that has not
  -- happened belongs to no business day.
  v_from            timestamptz;
  v_to              timestamptz;

  v_sales           jsonb;
  v_invoices        jsonb;
  v_payments        jsonb;
  v_pay_count       bigint;
  v_pay_total       bigint;
  v_pay_reversals   bigint;
  v_pay_methods     jsonb;
  v_credit          jsonb;
  v_disc_count      bigint;
  v_disc_total      bigint;
  v_appr_by_type    jsonb;
  v_appr_requested  bigint;
  v_unreleased      jsonb;
  v_released        jsonb;
  v_variances       jsonb;
  v_shortages       jsonb;
  v_batches         jsonb;
  v_moulded         bigint;
  v_mould_rejects   bigint;
  v_inspected       bigint;
  v_accepted        bigint;
  v_insp_rejects    bigint;
  v_pending         jsonb;
  v_fund_id         uuid;
  v_funding         jsonb;
  v_imprest         jsonb;
begin
  -- Africa/Dar_es_Salaam is UTC+3 with no daylight saving, so the day really is 24 hours long. It
  -- is still written as two local midnights rather than as `+ interval '24 hours'`, because the
  -- rule the business states is "the local calendar day" and that is what this says.
  v_from := (p_business_date::timestamp)       at time zone 'Africa/Dar_es_Salaam';
  v_to   := ((p_business_date + 1)::timestamp) at time zone 'Africa/Dar_es_Salaam';

  -- SALES (product.md §12). Counted by the moment each transition was recorded, in local time.
  --
  -- Three different columns are being asked about, so the WHERE clause is their union and the
  -- FILTER clauses separate them again. Without that outer clause the aggregate would read every
  -- order the business has ever taken in order to report on one day.
  select jsonb_build_object(
           'orders_created',
             count(*) filter (where o.created_at >= v_from and o.created_at < v_to),
           'orders_confirmed',
             count(*) filter (where o.confirmed_at >= v_from and o.confirmed_at < v_to),
           'orders_cancelled',
             count(*) filter (where o.cancelled_at >= v_from and o.cancelled_at < v_to),
           'cash_sales_confirmed',
             count(*) filter (
               where o.is_cash_sale
                 and o.confirmed_at >= v_from and o.confirmed_at < v_to))
    into v_sales
    from public.orders o
   where (o.created_at   >= v_from and o.created_at   < v_to)
      or (o.confirmed_at >= v_from and o.confirmed_at < v_to)
      or (o.cancelled_at >= v_from and o.cancelled_at < v_to);

  -- INVOICES (§12.2). `business_date` is stored on the row, so the number and the day it encodes
  -- can never disagree.
  --
  -- `cancelled_count` is invoices issued that day AND cancelled by the end of it. Counting every
  -- cancellation recorded since would make the figure drift each time somebody cancelled an old
  -- invoice, and would contradict the credit section below — which counts an invoice cancelled
  -- after the cutoff as still owing on the night in question. One cutoff, both sections.
  select jsonb_build_object(
           'issued_count',    count(*),
           'cancelled_count', count(*) filter (where i.cancelled_at < v_to),
           'subtotal_tzs',    coalesce(sum(i.subtotal_tzs), 0),
           'discount_tzs',    coalesce(sum(i.discount_tzs), 0),
           'total_tzs',       coalesce(sum(i.total_tzs), 0))
    into v_invoices
    from public.invoices i
   where i.business_date = p_business_date;

  -- PAYMENTS BY METHOD (§12.5). An approved reversal is a negative payment, so the totals here are
  -- NET takings — which is what the money in the tin actually is — and the reversals are counted
  -- separately so a net figure is never mistaken for a gross one.
  select count(*),
         coalesce(sum(p.amount_tzs), 0),
         count(*) filter (where p.reverses_id is not null)
    into v_pay_count, v_pay_total, v_pay_reversals
    from public.payments p
   where p.business_date = p_business_date;

  select coalesce(
           jsonb_agg(jsonb_build_object('method', m.method, 'count', m.entries,
                                        'amount_tzs', m.amount)
                     order by m.method),
           '[]'::jsonb)
    into v_pay_methods
    from (select p.method::text as method,
                 count(*)       as entries,
                 sum(p.amount_tzs) as amount
            from public.payments p
           where p.business_date = p_business_date
           group by p.method) m;

  v_payments := jsonb_build_object('count', v_pay_count, 'total_tzs', v_pay_total,
                                   'reversal_count', v_pay_reversals, 'methods', v_pay_methods);

  -- OUTSTANDING CREDIT, as at the end of the business date and not as at now: invoices issued on or
  -- before it, less the payments recorded on or before it. Both dates are stored columns, so this
  -- is a point-in-time figure that reads the same whenever the report is regenerated.
  --
  -- `public.invoice_settlement` is deliberately NOT the source, unlike the section above. That view
  -- subtracts EVERY payment ever recorded, which is the right answer for a screen showing what a
  -- customer owes now and the wrong one for a report about a night three weeks ago: a payment taken
  -- since would silently reduce a historical figure. The arithmetic looks the same; the question is
  -- not.
  --
  -- A CANCELLATION IS THE SAME TRAP, one level in. `cancelled_at is null` asks whether the invoice
  -- stands TODAY; this report has to ask whether it stood at the cutoff. An invoice cancelled a
  -- week later was money genuinely owed on the night being described, so it is counted — and the
  -- alternative is worse than a wrong total: the figure would change every time the same day was
  -- rebuilt, which is the one thing an immutable snapshot may not do.
  select jsonb_build_object(
           'as_at_business_date', p_business_date,
           'invoice_count',       count(*),
           'outstanding_tzs',     coalesce(sum(x.outstanding), 0))
    into v_credit
    from (select (i.total_tzs
                  - coalesce((select sum(p.amount_tzs)
                                from public.payments p
                               where p.invoice_id = i.id
                                 and p.business_date <= p_business_date), 0)) as outstanding
            from public.invoices i
           where i.business_date <= p_business_date
             and (i.cancelled_at is null or i.cancelled_at >= v_to)) x
   where x.outstanding > 0;

  -- DISCOUNTS AND APPROVALS (§4.3, §12.3). The discount is what was granted on the day's invoices;
  -- the approvals are every authority decision asked for on the day, whatever it was about.
  --
  -- WHERE EACH ONE STOOD AT THE CUTOFF, NOT WHERE IT STANDS NOW. `approval_requests.status` is a
  -- projection of the latest decision, and a request made at 23:55 and approved at 00:02 would
  -- read as approved in a report the 00:05 retry writes for the day it was still waiting. The
  -- answer is read from the append-only `approval_decisions` history instead: the last decision
  -- made before the cutoff, or `pending` if none was. The projection is used only when no decision
  -- at all came after the cutoff, because then it IS the state at the cutoff and it settles two
  -- decisions stamped in one transaction without a tie-break.
  select count(*) filter (where i.discount_tzs > 0), coalesce(sum(i.discount_tzs), 0)
    into v_disc_count, v_disc_total
    from public.invoices i
   where i.business_date = p_business_date;

  select coalesce(sum(a.requested), 0),
         coalesce(jsonb_agg(jsonb_build_object('approval_type', a.approval_type,
                                               'requested',     a.requested,
                                               'approved',      a.approved,
                                               'rejected',      a.rejected)
                            order by a.approval_type), '[]'::jsonb)
    into v_appr_requested, v_appr_by_type
    from (select r.approval_type::text as approval_type,
                 count(*)                                        as requested,
                 count(*) filter (where c.status = 'approved')   as approved,
                 count(*) filter (where c.status = 'rejected')   as rejected
            from public.approval_requests r
           cross join lateral (
             select case
                      when not exists (select 1
                                         from public.approval_decisions d
                                        where d.request_id = r.id
                                          and d.decided_at >= v_to)
                        then r.status::text
                      else coalesce((select d.outcome::text
                                       from public.approval_decisions d
                                      where d.request_id = r.id
                                        and d.decided_at < v_to
                                      order by d.decided_at desc, d.id desc
                                      limit 1),
                                    'pending')
                    end as status) c
           where r.requested_at >= v_from and r.requested_at < v_to
           group by r.approval_type) a;

  -- PAID BUT UNRELEASED (§8, §12.4). A POSITION: goods the business has been paid for and still
  -- holds. A daily total would be meaningless, so the snapshot records what was outstanding at the
  -- moment of generation and says so.
  --
  -- Read from the EXISTING view, not from a second copy of its predicate. Which allocations count
  -- as paid-but-unreleased is a settled question with one answer, and two definitions of it would
  -- agree today and drift the first time either is corrected.
  select jsonb_build_object(
           'as_at',                'generation',
           'allocation_count',     count(*),
           'outstanding_quantity', coalesce(sum(u.outstanding_quantity), 0))
    into v_unreleased
    from public.paid_but_unreleased u;

  -- RELEASED STOCK (§12.6 step 14). Stock has left the yard only once a Manager confirmed a signed
  -- dispatch note, so a release belongs to the day it was RELEASED, not the day it was assigned.
  select jsonb_build_object(
           'dispatch_count',    count(distinct d.id),
           'released_quantity', coalesce(sum(l.quantity), 0))
    into v_released
    from public.dispatches d
    join public.dispatch_lines l on l.dispatch_id = d.id
   where d.status = 'released'
     and d.released_at >= v_from and d.released_at < v_to;

  -- INVENTORY VARIANCES (§10). Corrections entered on the day, kept as two directions rather than
  -- one net figure: a day that lost 40 and gained 40 is not a quiet day.
  select jsonb_build_object(
           'adjustment_count',  count(*),
           'increase_quantity', coalesce(sum(s.quantity_delta) filter (where s.quantity_delta > 0), 0),
           'decrease_quantity',
             coalesce(-(sum(s.quantity_delta) filter (where s.quantity_delta < 0)), 0),
           'net_quantity',      coalesce(sum(s.quantity_delta), 0))
    into v_variances
    from public.stock_adjustments s
   where s.entered_at >= v_from and s.entered_at < v_to;

  -- SUPPLIER SHORTAGES (§9.1). Short and damaged are different failures and are never added
  -- together: one is a delivery that was light, the other is goods that arrived broken.
  select jsonb_build_object(
           'receipt_count',    count(distinct r.id),
           'short_line_count', count(*) filter (where l.short_quantity > 0),
           'short_quantity',   coalesce(sum(l.short_quantity), 0),
           'damaged_quantity', coalesce(sum(l.damaged_quantity), 0))
    into v_shortages
    from public.stock_receipts r
    join public.stock_receipt_lines l on l.receipt_id = r.id
   where r.entered_at >= v_from and r.entered_at < v_to;

  -- PRODUCTION BATCHES (§11.1). Entered on the day, and shown by the decision each one had reached
  -- AT THE CUTOFF. A batch leaves `draft` exactly once, and the command that moves it stamps
  -- `decided_at` in the same statement, so a batch decided at or after midnight was still a draft
  -- on the day being reported — whatever it has become since.
  select jsonb_build_object(
           'entered',   count(*),
           'draft',     count(*) filter (where c.status = 'draft'),
           'approved',  count(*) filter (where c.status = 'approved'),
           'rejected',  count(*) filter (where c.status = 'rejected'),
           'cancelled', count(*) filter (where c.status = 'cancelled'))
    into v_batches
    from public.production_batches b
   cross join lateral (
     select case when b.decided_at < v_to then b.status
                 else 'draft'::public.production_batch_status
            end as status) c
   where b.entered_at >= v_from and b.entered_at < v_to;

  -- PRODUCTION OUTPUT AND REJECTS (§11.2, §11.5). Two different days are involved and they are not
  -- merged: bricks are moulded on the day their batch was entered, and accepted or rejected on the
  -- day they were inspected — which is at least 72 hours later (§11.4).
  select coalesce(sum(l.quantity_moulded), 0), coalesce(sum(l.rejected_at_moulding), 0)
    into v_moulded, v_mould_rejects
    from public.production_lots l
    join public.production_batches b on b.id = l.batch_id
   where b.entered_at >= v_from and b.entered_at < v_to;

  select count(*), coalesce(sum(l.accepted_quantity), 0), coalesce(sum(l.rejected_at_inspection), 0)
    into v_inspected, v_accepted, v_insp_rejects
    from public.production_lots l
   where l.inspected_at >= v_from and l.inspected_at < v_to;

  -- PENDING APPROVALS. A POSITION again: what is still waiting on somebody at the moment of
  -- generation, which is the only reading that would make a Director act on it.
  select jsonb_build_object(
           'as_at',   'generation',
           'count',   coalesce(sum(t.waiting), 0),
           'by_type', coalesce(jsonb_agg(jsonb_build_object('approval_type', t.approval_type,
                                                            'count',         t.waiting)
                                         order by t.approval_type), '[]'::jsonb))
    into v_pending
    from (select r.approval_type::text as approval_type, count(*) as waiting
            from public.approval_requests r
           where r.status = 'pending'
           group by r.approval_type) t;

  -- IMPREST (§13), AS THE RELEASED SCHEMA CAN HONESTLY STATE IT (issue #51).
  --
  -- The Owner approved "receipts plus explicit unavailable states" on 23 September 2026, and every
  -- line below follows from it. The shape stays schema version 1: every key the reader already
  -- knows keeps its meaning or becomes NULL, which its contract already allows, and what is new is
  -- additive — the fund's real identity, and an `unavailable` map naming each figure withheld and
  -- why.
  --
  --   · THE FUND. main has one active fund at a time (`imprest_one_active_fund_idx`) and no fund
  --     number. `fund_no` is kept and is NULL: printing the uuid there, or making a number up, would
  --     put a false identifier on the page. The real identity is `fund_id`.
  --   · NO FUND AT ALL is its own state, as it always was. The first funding request opens the fund,
  --     so there is no funding to report either, and nothing is written as zero.
  --   · REQUESTED is the requests made on the day, counted and summed. Unchanged.
  --   · RECEIVED is `received_amount_tzs` on the receipts the Manager confirmed on the day. That is
  --     the only thing in the released schema that posts money (AC-47, AC-48), so it is the only
  --     money reported. Several receipts on one day are summed; a receipt confirmed after the cutoff
  --     belongs to a later day and cannot reach this snapshot, which is immutable once written.
  --   · APPROVED AND PROVIDED ARE WITHHELD, not zeroed. main keeps them as append-only histories —
  --     increases, corrected handovers after a mismatch — and summing those rows as the day's money
  --     would count an increase or a correction as new cash. How to aggregate them is a decision
  --     for a later ticket; until then the rows stay visible, marked unavailable, and the history is
  --     on the imprest screen.
  --   · EXPENSES, THE POSITION AND THE COUNT DO NOT EXIST ON main. Spending, verification and
  --     reconciliation entry are later tickets. Expenses and position are withheld; the count is
  --     `not_counted` with NULL amounts, exactly as a count nobody took has always been reported.
  --     Cumulative funding is NOT offered in their place: posted funding is not cash in the tin,
  --     and a report that called it a balance would be telling a Director something untrue.
  --
  -- `awaiting_manager_confirmation` is still a state the reader understands. Nothing on main can
  -- produce one, and nothing here invents it.
  select f.id
    into v_fund_id
    from public.imprest_funds f
   where f.is_active
   order by f.opened_at
   limit 1;

  if v_fund_id is null then
    -- No fund has been opened yet. That is an absence of information, not a balanced fund, so every
    -- figure is NULL and the reason is written down.
    v_imprest := jsonb_build_object(
      'fund_no',           null,
      'fund_id',           null,
      'state',             'no_fund',
      'funding',           null,
      'approved_expenses', null,
      'position',          null,
      'unavailable',       jsonb_build_object(
                             'approved_expenses', 'imprest_spending_not_built',
                             'position',          'imprest_spending_not_built'),
      'reconciliation',    private.report_reconciliation_state(
                             'not_counted', null, null, null, null, 'no_imprest_fund'));
  else
    -- Two different columns are asked about, so the WHERE clause is their union and the FILTER
    -- clauses separate them again — the same shape as the sales section above.
    select jsonb_build_object(
             'requested_count',
               count(*) filter (where fu.requested_at >= v_from and fu.requested_at < v_to),
             'requested_tzs',
               coalesce(sum(fu.requested_amount_tzs) filter (
                 where fu.requested_at >= v_from and fu.requested_at < v_to), 0),
             'approved_tzs',  null,
             'provided_tzs',  null,
             'received_tzs',
               coalesce(sum(fu.received_amount_tzs) filter (
                 where fu.status = 'received'
                   and fu.received_at >= v_from and fu.received_at < v_to), 0),
             'unavailable', jsonb_build_object(
               'approved_tzs', 'funding_aggregation_deferred',
               'provided_tzs', 'funding_aggregation_deferred'))
      into v_funding
      from public.imprest_fundings fu
     where fu.fund_id = v_fund_id
       and ((fu.requested_at >= v_from and fu.requested_at < v_to)
         or (fu.received_at  >= v_from and fu.received_at  < v_to));

    v_imprest := jsonb_build_object(
      'fund_no',           null,
      'fund_id',           v_fund_id,
      'state',             'active',
      'funding',           v_funding,
      'approved_expenses', null,
      'position',          null,
      'unavailable',       jsonb_build_object(
                             'approved_expenses', 'imprest_spending_not_built',
                             'position',          'imprest_spending_not_built'),
      -- §15.2a: never performed is UNKNOWN. NULL amount, NULL variance, and a stated reason. There
      -- is no reconciliation table on main, so there is no record to find.
      'reconciliation',    private.report_reconciliation_state(
                             'not_counted', null, null, null, null, 'no_reconciliation_record'));
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'business_date',  p_business_date,
    'time_zone',      'Africa/Dar_es_Salaam',
    'sections', jsonb_build_object(
      'sales',                  v_sales,
      'invoices',               v_invoices,
      'payments_by_method',     v_payments,
      'outstanding_credit',     v_credit,
      'discounts_and_approvals', jsonb_build_object(
        'discounted_invoice_count', v_disc_count,
        'discount_tzs',             v_disc_total,
        'approvals_requested',      v_appr_requested,
        'by_type',                  v_appr_by_type),
      'paid_but_unreleased',    v_unreleased,
      'released_stock',         v_released,
      'inventory_variances',    v_variances,
      'supplier_shortages',     v_shortages,
      'production_batches',     v_batches,
      'production_output', jsonb_build_object(
        'quantity_moulded',       v_moulded,
        'rejected_at_moulding',   v_mould_rejects,
        'inspected_lot_count',    v_inspected,
        'accepted_quantity',      v_accepted,
        'rejected_at_inspection', v_insp_rejects),
      -- The Cashier's till count has no table yet: §15's reconciliation ENTRY screens are a later
      -- ticket. That absence is reported as an absence. Turning it into a zero would tell a
      -- Director the till balanced on a night nobody counted it, which is the one lie §15.2a exists
      -- to prevent.
      --
      -- NOT THE SAME COUNT AS THE IMPREST ONE BELOW, and the two must never be merged. §15.1 lists
      -- "Cash" and "Imprest" as separate variance categories: this is the day's takings in the
      -- till, and the imprest count below is the petty-cash tin of §13.7. One report can honestly
      -- say the imprest was counted and confirmed while the till was never counted at all.
      'cashier_reconciliation', private.report_reconciliation_state(
        'not_counted', null, null, null, null, 'no_cash_reconciliation_record'),
      'pending_approvals',      v_pending,
      'imprest',                v_imprest));
end;
$$;

comment on function private.report_content(date) is
  'The approved pilot report content for one business date, built entirely from existing database '
  'truth. Reads only. Private: it is never reachable through the Data API.';

alter function private.report_content(date) owner to fv_definer_owner;
revoke execute on function private.report_content(date)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.generate_scheduled_report — the scheduled entry point
--
-- NO PARAMETERS AT ALL. Not a business date, not an actor, not a correlation id. Everything it
-- needs it derives, and everything it derives it derives from the database's own clock.
--
-- A duplicate invocation for a business date that already has a report loses the insert race and
-- returns `created: false`. It creates no second snapshot and no second delivery, which is §18.2's
-- "later attempts do nothing" enforced by a constraint rather than by a check somebody could
-- forget.
-- ---------------------------------------------------------------------------
create or replace function private.generate_scheduled_report()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule   public.report_schedules;
  v_date       date;
  v_corr       uuid := gen_random_uuid();
  v_run_id     uuid;
  v_snapshot   uuid;
  v_sha        text;
  v_recipients integer;
begin
  select s.* into v_schedule
    from public.report_schedules s
   where s.code = 'daily_pilot_report'
     and s.is_active;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_active_schedule');
  end if;

  -- THE BUSINESS DATE, DERIVED HERE AND NOWHERE ELSE. The job fires at 00:01 local, so "today" in
  -- Dar es Salaam is already the new day and the report is for the one that just closed at 23:59
  -- (product.md §15.3, §18.2).
  v_date := private.business_date() - 1;

  insert into public.report_runs (schedule_id, business_date, correlation_id)
  values (v_schedule.id, v_date, v_corr)
  on conflict (schedule_id, business_date) do nothing
  returning id into v_run_id;

  if v_run_id is null then
    return jsonb_build_object('ok', true, 'created', false, 'reason', 'already_generated',
                              'business_date', v_date);
  end if;

  insert into public.report_snapshots (run_id, business_date, schema_version, content)
  values (v_run_id, v_date, 1, private.report_content(v_date))
  returning id, content_sha256 into v_snapshot, v_sha;

  -- Every active Director and Manager present at generation (§18.1). A colleague still holding a
  -- temporary password is included: the delivery records who the report was FOR, and their own
  -- first-login gate decides when they may read it.
  insert into public.report_deliveries (snapshot_id, recipient_id, recipient_role)
  select v_snapshot, p.id, r.role
    from public.profiles p
    join public.user_roles r on r.user_id = p.id
   where p.is_active
     and r.role in ('director', 'manager');

  get diagnostics v_recipients = row_count;

  -- A SYSTEM operation: no actor and no role, which is the only shape `audit_actor_shape` permits
  -- when `is_system_actor` is true. Nobody generated this report, and the audit trail says so
  -- rather than crediting whoever happened to be awake.
  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    after_state, correlation_id, source_operation)
  values (
    null, null, true, 'scheduled_report_generated', 'report_snapshot', v_snapshot,
    jsonb_build_object('business_date', v_date, 'content_sha256', v_sha,
                       'recipient_count', v_recipients),
    v_corr, 'private.generate_scheduled_report');

  return jsonb_build_object('ok', true, 'created', true,
                            'business_date',   v_date,
                            'run_id',          v_run_id,
                            'snapshot_id',     v_snapshot,
                            'content_sha256',  v_sha,
                            'recipient_count', v_recipients,
                            'correlation_id',  v_corr);
end;
$$;

comment on function private.generate_scheduled_report() is
  'The issue #18 success-path generator. Takes no arguments: the business date, the actor and the '
  'correlation id are all derived inside the database. No Cron job calls it; the next migration '
  'replaces it with private.run_scheduled_report and registers the jobs for that.';

alter function private.generate_scheduled_report() owner to fv_definer_owner;

-- Outside the Data API twice over: `private` is not an exposed schema, AND no Data API role holds
-- EXECUTE. The only grant is to the role Supabase Cron runs jobs as.
revoke execute on function private.generate_scheduled_report()
  from public, anon, authenticated, service_role;
grant execute on function private.generate_scheduled_report() to postgres;

-- ---------------------------------------------------------------------------
-- NO SCHEDULE IS REGISTERED HERE
--
-- Issue #18 registered its 00:01 job at this point. The integrated release does not, because the
-- ticket forbids a success-only scheduler even for the moment between the two migrations: a night
-- whose one attempt failed would leave nothing behind and raise no alert. The four jobs are
-- registered by `20260923000200_scheduled_report_retries_and_alerts.sql`, after the claim, the
-- lease, the failure record and the alert all exist.
-- ---------------------------------------------------------------------------

commit;
