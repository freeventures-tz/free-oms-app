-- Issue #62 · Imprest spending, part 2a: hand the cash out, then settle it
--
-- product.md §13.3 points 3 and 4, §13.4, AC-55, AC-99, AC-100 and AC-102. After the Manager
-- approves a disbursement the Cashier who proposed it hands the approved amount out and names who
-- received it. When the spending is done the Cashier settles it: one line per thing paid for, each
-- with a receipt file or a No-receipt reason, and the cash that came back.
--
-- THE RULE. Every disbursement ends with its approved amount fully explained:
--
--     Approved = Used (the sum of the lines) + Returned + Not accounted for
--
-- Used and Not accounted for are calculated here and never typed. Used plus Returned above
-- Approved is refused. A remainder is recorded, not blocked: it needs a written explanation and
-- flags the disbursement for good.
--
--   imprest_disbursement_handouts  one row per hand-out. Never changed.
--   imprest_receipts               one row per receipt file, holding its encryption key. Never
--                                  changed, and the key is readable by no client.
--   imprest_settlements            one row per settlement cycle (only cycle 1 in this release).
--                                  Part 2b adds a new cycle on a send-back instead of editing.
--   imprest_settlement_lines       the lines of one settlement. Never changed.
--
-- Hand-out and settlement keep the full approved amount set aside, so Free to approve does not
-- move (AC-102). Verification in part 2b releases what came back and posts what was used.
--
-- RECEIPTS ARE ENCRYPTED, AND WHY. They live in the private `imprest-evidence` bucket. The obvious
-- protection against a leaked secret key would be to revoke `service_role` from `storage.objects`,
-- as every imprest table does. It cannot work: `supabase_storage_admin` owns the storage schema
-- and granted those privileges, `postgres` (which runs this migration, locally and hosted) is not
-- a member of it, so the revoke removes nothing and only warns. `service_role` is also a reserved
-- role that `postgres` may not alter, and it bypasses row-level security. Two things stand in its
-- place, and the Owner chose both on 27 September 2026:
--
--   1. A trigger on `storage.objects` refuses every insert into this bucket that does not come
--      from a signed-in session, and every update and delete from anybody. The secret key can
--      neither plant, replace nor remove a receipt.
--   2. Every file is encrypted in the Cashier's browser (AES-256-GCM) before upload, with a key
--      made here for that one receipt. Keys stay in `imprest_receipts.encryption_key`, which no
--      client role and not `service_role` can read. `api.staff_open_imprest_receipt` hands a key
--      only to somebody allowed to see that receipt. The secret key can still read the stored
--      bytes, and they are unreadable without the key.
--
-- Source material was the archived `feat/stage-14-imprest-application` tag: the bucket, the path
-- checks and the six No-receipt reasons. Its revoke is replaced by the two measures above, and its
-- one-receipt-per-expense shape by lines.

begin;

-- ---------------------------------------------------------------------------
-- The approved row may now also be handed out or settled
-- ---------------------------------------------------------------------------
alter table public.imprest_disbursements drop constraint disbursement_approval_shape;
alter table public.imprest_disbursements
  add constraint disbursement_approval_shape check (
    (status in ('approved', 'handed_out', 'settled', 'cancelled')) = (approved_by is not null)
    and (approved_by is null) = (approved_at is null)
  );

create type public.imprest_no_receipt_reason as enum (
  'vendor_did_not_issue',
  'informal_or_casual_labour',
  'transport_fare',
  'emergency_purchase',
  'receipt_lost_or_damaged',
  'other'
);

comment on type public.imprest_no_receipt_reason is
  'The six reasons a settlement line may have no receipt, as the Owner approved them on '
  '27 September 2026. `receipt_lost_or_damaged` and `other` also need a written explanation.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.imprest_disbursement_handouts (
  id               uuid primary key default gen_random_uuid(),
  disbursement_id  uuid not null unique references public.imprest_disbursements (id)
                     on delete restrict,
  recipient        text not null check (length(btrim(recipient)) between 2 and 120),
  -- Always the approved amount. Stored so the row says on its own what left the fund.
  amount_tzs       bigint not null check (amount_tzs > 0),
  handed_out_by    uuid not null references public.profiles (id),
  handed_out_at    timestamptz not null default now()
);

comment on table public.imprest_disbursement_handouts is
  'The approved amount handed out, and to whom (issue #62). One per disbursement, never changed.';

create index imprest_handouts_by_idx on public.imprest_disbursement_handouts (handed_out_by);

create table public.imprest_receipts (
  id               uuid primary key default gen_random_uuid(),
  disbursement_id  uuid not null references public.imprest_disbursements (id) on delete restrict,
  object_path      text not null unique,
  file_name        text not null check (length(btrim(file_name)) between 1 and 200),
  content_type     text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp',
                                                          'image/heic', 'application/pdf')),
  byte_size        bigint not null check (byte_size between 1 and 15728640),
  encryption_key   bytea not null check (length(encryption_key) = 32),
  uploaded_by      uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  constraint imprest_receipt_path_shape
    check (object_path = 'imprest/' || disbursement_id::text || '/' || id::text)
);

comment on table public.imprest_receipts is
  'One receipt file in the private imprest-evidence bucket, stored encrypted. The key is for '
  'api.staff_open_imprest_receipt alone: no client role may select it.';

create index imprest_receipts_disbursement_idx on public.imprest_receipts (disbursement_id);
create index imprest_receipts_uploaded_by_idx on public.imprest_receipts (uploaded_by);

create table public.imprest_settlements (
  id                       uuid primary key default gen_random_uuid(),
  disbursement_id          uuid not null references public.imprest_disbursements (id)
                             on delete restrict,
  cycle                    integer not null check (cycle >= 1),
  approved_tzs             bigint not null check (approved_tzs > 0),
  used_tzs                 bigint not null check (used_tzs >= 0),
  returned_tzs             bigint not null check (returned_tzs >= 0),
  unaccounted_tzs          bigint not null check (unaccounted_tzs >= 0),
  unaccounted_explanation  text check (unaccounted_explanation is null
                                       or length(btrim(unaccounted_explanation)) between 3 and 500),
  line_count               integer not null check (line_count between 0 and 20),
  no_receipt_lines         integer not null check (no_receipt_lines between 0 and line_count),
  settled_by               uuid not null references public.profiles (id),
  settled_at               timestamptz not null default now(),
  unique (disbursement_id, cycle),
  constraint settlement_explains_the_approval
    check (approved_tzs = used_tzs + returned_tzs + unaccounted_tzs),
  constraint settlement_remainder_explained
    check ((unaccounted_tzs > 0) = (unaccounted_explanation is not null))
);

comment on table public.imprest_settlements is
  'One settlement of a handed-out disbursement (issue #62): Approved = Used + Returned + Not '
  'accounted for. Append-only; a later cycle is a new row (§13.3a, AC-103b).';

create index imprest_settlements_by_idx on public.imprest_settlements (settled_by);

create table public.imprest_settlement_lines (
  id                 uuid primary key default gen_random_uuid(),
  settlement_id      uuid not null references public.imprest_settlements (id) on delete restrict,
  line_no            integer not null check (line_no between 1 and 20),
  amount_tzs         bigint not null check (amount_tzs > 0 and amount_tzs <= 100000000),
  purpose            text not null check (length(btrim(purpose)) between 2 and 120),
  receipt_id         uuid references public.imprest_receipts (id) on delete restrict,
  no_receipt_reason  public.imprest_no_receipt_reason,
  no_receipt_note    text check (no_receipt_note is null
                                 or length(btrim(no_receipt_note)) between 3 and 500),
  unique (settlement_id, line_no),
  unique (settlement_id, receipt_id),
  -- AC-55: a receipt, or a reason for its absence. Never both, never neither.
  constraint line_receipt_or_reason
    check ((receipt_id is null) <> (no_receipt_reason is null)),
  constraint line_note_needs_reason
    check (no_receipt_note is null or no_receipt_reason is not null),
  constraint line_note_where_required
    check (no_receipt_reason is null
           or no_receipt_reason not in ('receipt_lost_or_damaged', 'other')
           or no_receipt_note is not null)
);

comment on table public.imprest_settlement_lines is
  'One thing paid for in a settlement: amount, purpose, and a receipt or a No-receipt reason.';

create index imprest_settlement_lines_receipt_idx on public.imprest_settlement_lines (receipt_id);

-- ---------------------------------------------------------------------------
-- Append-only, and consistent
-- ---------------------------------------------------------------------------
create or replace function private.refuse_imprest_settlement_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are never changed or deleted', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

comment on function private.refuse_imprest_settlement_edit() is
  'Hand-outs, receipts, settlements and their lines are records: a correction is a new cycle.';

create trigger imprest_handouts_append_only
  before update or delete on public.imprest_disbursement_handouts
  for each row execute function private.refuse_imprest_settlement_edit();
create trigger imprest_receipts_append_only
  before update or delete on public.imprest_receipts
  for each row execute function private.refuse_imprest_settlement_edit();
create trigger imprest_settlements_append_only
  before update or delete on public.imprest_settlements
  for each row execute function private.refuse_imprest_settlement_edit();
create trigger imprest_settlement_lines_append_only
  before update or delete on public.imprest_settlement_lines
  for each row execute function private.refuse_imprest_settlement_edit();

-- A settlement's totals are what its lines add up to, checked when the transaction commits, so the
-- row and its lines can be written in either order but never disagree.
create or replace function private.check_imprest_settlement_totals()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_id    uuid;
  v_s     public.imprest_settlements%rowtype;
  v_used  bigint;
  v_count integer;
  v_none  integer;
begin
  -- An IF, not a CASE: PL/pgSQL resolves every field a CASE names, and `new` of the settlement
  -- table has no `settlement_id`.
  if tg_table_name = 'imprest_settlements' then
    v_id := new.id;
  else
    v_id := new.settlement_id;
  end if;

  select * into v_s from public.imprest_settlements where id = v_id;
  select coalesce(sum(amount_tzs), 0), count(*), count(*) filter (where no_receipt_reason is not null)
    into v_used, v_count, v_none
    from public.imprest_settlement_lines where settlement_id = v_id;
  if v_s.used_tzs <> v_used or v_s.line_count <> v_count or v_s.no_receipt_lines <> v_none then
    raise exception 'imprest settlement % says Used %, % lines, % without receipt; its lines say %, %, %',
      v_id, v_s.used_tzs, v_s.line_count, v_s.no_receipt_lines, v_used, v_count, v_none
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger imprest_settlement_totals
  after insert on public.imprest_settlements
  deferrable initially deferred
  for each row execute function private.check_imprest_settlement_totals();
create constraint trigger imprest_settlement_line_totals
  after insert on public.imprest_settlement_lines
  deferrable initially deferred
  for each row execute function private.check_imprest_settlement_totals();

-- A settlement belongs to a disbursement that was handed out, its approved figure is that
-- disbursement's, and a receipt on a line belongs to the same disbursement.
create or replace function private.check_imprest_settlement_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_d public.imprest_disbursements%rowtype;
begin
  if tg_table_name = 'imprest_settlements' then
    select * into v_d from public.imprest_disbursements where id = new.disbursement_id;
    if v_d.status is distinct from 'handed_out' or new.approved_tzs <> v_d.amount_tzs then
      raise exception 'imprest disbursement % is not handed out at %', new.disbursement_id,
        new.approved_tzs using errcode = 'check_violation';
    end if;
  elsif new.receipt_id is not null and not exists (
          select 1 from public.imprest_receipts rc
            join public.imprest_settlements s on s.disbursement_id = rc.disbursement_id
           where rc.id = new.receipt_id and s.id = new.settlement_id) then
    raise exception 'receipt % belongs to another disbursement', new.receipt_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger imprest_settlements_target
  before insert on public.imprest_settlements
  for each row execute function private.check_imprest_settlement_target();
create trigger imprest_settlement_lines_target
  before insert on public.imprest_settlement_lines
  for each row execute function private.check_imprest_settlement_target();

-- The disbursement row moves forward only: approved to handed out, handed out to settled. Part 1's
-- guard already keeps what was proposed and approved; this adds the order of the new states.
create or replace function private.guard_imprest_disbursement_progress()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
     and ((old.status in ('handed_out', 'settled'))
          or new.status in ('handed_out', 'settled'))
     and not ((old.status = 'approved' and new.status = 'handed_out'
               and exists (select 1 from public.imprest_disbursement_handouts h
                            where h.disbursement_id = new.id))
              or (old.status = 'handed_out' and new.status = 'settled'
                  and exists (select 1 from public.imprest_settlements s
                               where s.disbursement_id = new.id))) then
    raise exception 'imprest disbursement % cannot go from % to %', old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

comment on function private.guard_imprest_disbursement_progress() is
  'Approved goes to handed out only with a hand-out row, handed out to settled only with a '
  'settlement row, and neither goes back.';

create trigger imprest_disbursements_progress
  before update on public.imprest_disbursements
  for each row execute function private.guard_imprest_disbursement_progress();

-- ---------------------------------------------------------------------------
-- Grants and row-level security
--
-- The same readers as the disbursement itself: a Director and the Manager read everything, a
-- Cashier only what belongs to their own disbursements, a Sales Representative nothing. Writes go
-- through the api commands alone. `service_role` holds nothing on any of it.
-- ---------------------------------------------------------------------------
create or replace function private.imprest_disbursement_visible(p_disbursement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.authorize(array['director', 'manager']::public.app_role[])
      or (private.authorize(array['cashier']::public.app_role[])
          and exists (select 1 from public.imprest_disbursements d
                       where d.id = p_disbursement_id and d.proposed_by = private.request_uid()));
$$;

comment on function private.imprest_disbursement_visible(uuid) is
  'Whether the caller may read this disbursement: the rule of its own table policy, for the rows '
  'and files that hang off it.';

alter table public.imprest_disbursement_handouts enable row level security;
alter table public.imprest_receipts enable row level security;
alter table public.imprest_settlements enable row level security;
alter table public.imprest_settlement_lines enable row level security;

revoke all on public.imprest_disbursement_handouts, public.imprest_receipts,
              public.imprest_settlements, public.imprest_settlement_lines
  from public, anon, authenticated, service_role;
grant select on public.imprest_disbursement_handouts, public.imprest_settlements,
                public.imprest_settlement_lines
  to authenticated;
-- Every column but the key.
grant select (id, disbursement_id, object_path, file_name, content_type, byte_size, uploaded_by,
              created_at)
  on public.imprest_receipts to authenticated;
grant select, insert on public.imprest_disbursement_handouts, public.imprest_receipts,
                       public.imprest_settlements, public.imprest_settlement_lines
  to fv_definer_owner;

-- The disbursement's own rule. The subquery reads `imprest_disbursements` under that table's policy,
-- so a Cashier's `exists` can only ever find their own. Written out in each policy rather than as a
-- helper, because signed-in callers may execute exactly three functions in `private`.
create policy imprest_handouts_select on public.imprest_disbursement_handouts
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[]))
         or ((select private.authorize(array['cashier']::public.app_role[]))
             and exists (select 1 from public.imprest_disbursements d
                          where d.id = disbursement_id and d.proposed_by = (select auth.uid()))));
create policy imprest_receipts_select on public.imprest_receipts
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[]))
         or ((select private.authorize(array['cashier']::public.app_role[]))
             and exists (select 1 from public.imprest_disbursements d
                          where d.id = disbursement_id and d.proposed_by = (select auth.uid()))));
create policy imprest_settlements_select on public.imprest_settlements
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[]))
         or ((select private.authorize(array['cashier']::public.app_role[]))
             and exists (select 1 from public.imprest_disbursements d
                          where d.id = disbursement_id and d.proposed_by = (select auth.uid()))));
create policy imprest_settlement_lines_select on public.imprest_settlement_lines
  for select to authenticated
  using (exists (select 1 from public.imprest_settlements s where s.id = settlement_id));

create policy imprest_handouts_definer_owner on public.imprest_disbursement_handouts
  for all to fv_definer_owner using (true) with check (true);
create policy imprest_receipts_definer_owner on public.imprest_receipts
  for all to fv_definer_owner using (true) with check (true);
create policy imprest_settlements_definer_owner on public.imprest_settlements
  for all to fv_definer_owner using (true) with check (true);
create policy imprest_settlement_lines_definer_owner on public.imprest_settlement_lines
  for all to fv_definer_owner using (true) with check (true);

-- ---------------------------------------------------------------------------
-- The bucket
--
-- It stores ciphertext only: 15 MiB of content plus the 12-byte nonce and 16-byte tag of
-- AES-256-GCM. The five accepted file types are checked when a receipt is registered, because the
-- stored bytes no longer say what they were.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imprest-evidence', 'imprest-evidence', false, 15728640 + 28,
        array['application/octet-stream'])
on conflict (id) do update
   set public             = excluded.public,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- Uploading: a Cashier, to the path of a receipt they registered on their own disbursement while it
-- is handed out. Nobody else, and nowhere else. Reading: whoever may read the receipt's row, which
-- is the rule of the disbursement it is filed under. Both lean on the tables' own policies.
create policy imprest_evidence_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'imprest-evidence'
              and (select private.authorize(array['cashier']::public.app_role[]))
              and exists (select 1 from public.imprest_receipts rc
                            join public.imprest_disbursements d on d.id = rc.disbursement_id
                           where rc.object_path = name
                             and rc.uploaded_by = (select auth.uid())
                             and d.proposed_by = (select auth.uid())
                             and d.status = 'handed_out'));

create policy imprest_evidence_select on storage.objects
  for select to authenticated
  using (bucket_id = 'imprest-evidence'
         and exists (select 1 from public.imprest_receipts rc where rc.object_path = name));

-- The settle command checks that a cited file really is in the bucket, and who put it there.
-- `postgres` holds both privileges with grant option, locally and hosted.
grant usage on schema storage to fv_definer_owner;
grant select on storage.objects to fv_definer_owner;
create policy imprest_evidence_definer_owner on storage.objects
  for select to fv_definer_owner
  using (bucket_id = 'imprest-evidence');

-- No update and no delete policy exists, so a signed-in person reaches no stored receipt to change.
-- This trigger closes the door row-level security cannot: `service_role` bypasses every policy, so
-- the secret key could otherwise plant, overwrite or delete a file.
--
-- WHAT IT CAN AND CANNOT SEE. The Storage API checks a signed-in upload against the policies above
-- in a rehearsal it rolls back, then writes the real row as `service_role`, with no user in the
-- request claims. So the role that writes cannot tell a Cashier from the secret key (measured
-- against the local Storage API, 27 September 2026). What does tell them apart is the object's
-- `owner_id`: the Storage API takes it from the uploader's session, and the secret key has no user
-- behind it. So a new object is accepted only when it is exactly a registered receipt: its path,
-- uploaded by the Cashier who registered it, while the disbursement is handed out. Nobody may
-- change or remove one.
create or replace function private.guard_imprest_evidence_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.bucket_id = 'imprest-evidence'
       and not exists (select 1 from public.imprest_receipts rc
                         join public.imprest_disbursements d on d.id = rc.disbursement_id
                        where rc.object_path = new.name
                          and rc.uploaded_by::text = new.owner_id
                          and new.owner is not distinct from rc.uploaded_by
                          and d.status = 'handed_out') then
      raise exception 'only the Cashier who registered this receipt may add it'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if old.bucket_id = 'imprest-evidence'
     or (tg_op = 'UPDATE' and new.bucket_id = 'imprest-evidence') then
    raise exception 'an imprest receipt is never changed or deleted'
      using errcode = 'insufficient_privilege';
  end if;
  return coalesce(new, old);
end;
$$;

comment on function private.guard_imprest_evidence_object() is
  'Keeps the imprest-evidence bucket append-only for everybody, including the secret key, which '
  'row-level security does not restrain (issue #62).';

create trigger imprest_evidence_guard
  before insert or update or delete on storage.objects
  for each row execute function private.guard_imprest_evidence_object();

-- ---------------------------------------------------------------------------
-- The figures, calculated in one place
-- ---------------------------------------------------------------------------
create or replace function private.imprest_spending_figures(p_fund_id uuid)
returns table (posted_funding_tzs bigint, set_aside_tzs bigint, free_to_approve_tzs bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with posted as (
    select coalesce(sum(f.received_amount_tzs) filter (where f.status = 'received'), 0)::bigint
             as tzs
      from public.imprest_fundings f
     where f.fund_id = p_fund_id
  ), aside as (
    -- Handed out and settled stay set aside until the Manager verifies them (AC-102).
    select coalesce(sum(d.amount_tzs), 0)::bigint as tzs
      from public.imprest_disbursements d
     where d.fund_id = p_fund_id and d.status in ('approved', 'handed_out', 'settled')
  )
  select posted.tzs, aside.tzs, posted.tzs - aside.tzs from posted, aside;
$$;

comment on function private.imprest_spending_figures(uuid) is
  'Posted imprest funding, what approved, handed-out and settled disbursements set aside, and the '
  'difference: Free to approve (AC-99, AC-102). Calculated on every read, never stored.';

create or replace function private.imprest_awaiting_verification_tzs(p_fund_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  -- Cash that has left the fund and is not verified: the whole amount while it is out, then Used
  -- plus Not accounted for once settled. Returned cash is back in the fund.
  select coalesce(sum(case when d.status = 'handed_out' then d.amount_tzs
                           else s.used_tzs + s.unaccounted_tzs end), 0)::bigint
    from public.imprest_disbursements d
    left join lateral (select st.used_tzs, st.unaccounted_tzs from public.imprest_settlements st
                        where st.disbursement_id = d.id
                        order by st.cycle desc limit 1) s on true
   where d.fund_id = p_fund_id and d.status in ('handed_out', 'settled');
$$;

comment on function private.imprest_awaiting_verification_tzs(uuid) is
  'Awaiting verification (product.md §13.4): cash that has left the fund and has not been checked '
  'by the Manager. Expected cash in the tin = posted balance minus this. Never stored.';

drop function api.staff_imprest_spending_position();

create function api.staff_imprest_spending_position()
returns table (fund_id uuid, posted_funding_tzs bigint, set_aside_tzs bigint,
               free_to_approve_tzs bigint, awaiting_verification_tzs bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.acting_staff(array['director', 'manager', 'cashier']::public.app_role[]);
  v_role  public.app_role := private.live_role_of(v_actor);
begin
  -- No active fund returns no row, so a screen can tell "nothing yet" from a read that failed.
  return query
    select fu.id,
           case when v_role = 'cashier' then null else s.posted_funding_tzs end,
           case when v_role = 'cashier' then null else s.set_aside_tzs end,
           s.free_to_approve_tzs,
           case when v_role = 'cashier' then null
                else private.imprest_awaiting_verification_tzs(fu.id) end
      from public.imprest_funds fu
      cross join lateral private.imprest_spending_figures(fu.id) s
     where fu.is_active;
end;
$$;

comment on function api.staff_imprest_spending_position() is
  'The spending figures of the active fund. A Director and the Manager see all four; a Cashier '
  'sees only Free to approve. Calculated here because a Cashier reads only their own rows.';

-- ---------------------------------------------------------------------------
-- Command helpers
-- ---------------------------------------------------------------------------

-- The opening every part-2a command shares: the disbursement exists and is the caller's own (any
-- other is answered as missing, as withdraw does), then part 1's replay, lock, version and status
-- checks, with the status refusal named for what this command needs.
create or replace function private.imprest_own_disbursement_open(
  p_key text, p_operation text, p_actor uuid, p_request jsonb, p_id uuid,
  p_expected_version integer, p_needs public.imprest_disbursement_status)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stop jsonb;
begin
  if not exists (select 1 from public.imprest_disbursements
                  where id = p_id and proposed_by = p_actor) then
    return jsonb_build_object('ok', false, 'reason', 'no_disbursement');
  end if;

  v_stop := private.imprest_disbursement_open(p_key, p_operation, p_actor, p_request, p_id,
                                              p_expected_version, p_needs);
  if v_stop ->> 'reason' = 'not_approved' and p_needs = 'handed_out' then
    v_stop := jsonb_set(v_stop, '{reason}', '"not_handed_out"');
  end if;
  return v_stop;
end;
$$;

create or replace function private.imprest_receipt_json(p_id uuid, p_with_key boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', rc.id, 'disbursement_id', rc.disbursement_id,
                            'object_path', rc.object_path, 'file_name', rc.file_name,
                            'content_type', rc.content_type, 'byte_size', rc.byte_size)
         || case when p_with_key then jsonb_build_object('key', encode(rc.encryption_key, 'base64'))
                 else '{}'::jsonb end
    from public.imprest_receipts rc where rc.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Hand out (the Cashier who proposed it). There is no amount: the approved amount goes out.
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_hand_out_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_recipient text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor     uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_recipient text := private.normalise_label(p_recipient);
  v_stop      jsonb;
  v_d         public.imprest_disbursements%rowtype;
  v_request   jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                          'recipient', v_recipient);
begin
  v_stop := private.imprest_own_disbursement_open(p_idempotency_key,
    'imprest.hand_out_disbursement', v_actor, v_request, p_id, p_expected_version, 'approved');
  if v_stop is not null then
    return v_stop;
  end if;

  if length(v_recipient) < 2 or length(v_recipient) > 120 then
    return jsonb_build_object('ok', false, 'reason', 'recipient_invalid');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.hand_out_disbursement', v_actor,
                               v_request, p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  select * into v_d from public.imprest_disbursements where id = p_id;

  insert into public.imprest_disbursement_handouts (disbursement_id, recipient, amount_tzs,
                                                    handed_out_by)
  values (p_id, v_recipient, v_d.amount_tzs, v_actor);

  update public.imprest_disbursements
     set status = 'handed_out', version = version + 1
   where id = p_id;

  perform private.imprest_disbursement_audit(v_actor, 'imprest_disbursement_handed_out', p_id,
    jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', 'handed_out', 'recipient', v_recipient,
                       'amount_tzs', v_d.amount_tzs, 'set_aside', true),
    'api.staff_hand_out_imprest_disbursement');

  return private.imprest_disbursement_result('handed_out', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Register a receipt (the Cashier who proposed it, while it is handed out). The file itself goes
-- straight from the phone to the bucket, encrypted with the key this returns.
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_register_imprest_receipt(
  p_disbursement_id uuid, p_file_name text, p_content_type text, p_byte_size bigint,
  p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_name    text := private.normalise_label(p_file_name);
  v_id      uuid := gen_random_uuid();
  v_class   jsonb;
  v_status  public.imprest_disbursement_status;
  v_request jsonb := jsonb_build_object('disbursement_id', p_disbursement_id, 'file_name', v_name,
                                        'content_type', p_content_type, 'byte_size', p_byte_size);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'imprest.register_receipt', v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return jsonb_build_object('ok', true, 'reason', 'replayed',
      'receipt', private.imprest_receipt_json((v_class ->> 'result_ref')::uuid, true));
  end if;

  select status into v_status from public.imprest_disbursements
   where id = p_disbursement_id and proposed_by = v_actor
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_disbursement');
  elsif v_status <> 'handed_out' then
    return jsonb_build_object('ok', false, 'reason', 'not_handed_out', 'status', v_status::text);
  elsif p_content_type is null or p_content_type not in ('image/jpeg', 'image/png', 'image/webp',
                                                          'image/heic', 'application/pdf') then
    return jsonb_build_object('ok', false, 'reason', 'receipt_type_invalid');
  elsif p_byte_size is null or p_byte_size < 1 or p_byte_size > 15728640 then
    return jsonb_build_object('ok', false, 'reason', 'receipt_too_large');
  elsif length(v_name) < 1 or length(v_name) > 200 then
    return jsonb_build_object('ok', false, 'reason', 'receipt_name_invalid');
  elsif (select count(*) from public.imprest_receipts
          where disbursement_id = p_disbursement_id) >= 60 then
    -- Twenty lines at most, so sixty files leaves room for retakes and not for a file store.
    return jsonb_build_object('ok', false, 'reason', 'too_many_receipts');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.register_receipt', v_actor, v_request,
                               v_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.imprest_receipts (id, disbursement_id, object_path, file_name, content_type,
                                       byte_size, encryption_key, uploaded_by)
  values (v_id, p_disbursement_id, 'imprest/' || p_disbursement_id::text || '/' || v_id::text,
          v_name, p_content_type, p_byte_size, extensions.gen_random_bytes(32), v_actor);

  return jsonb_build_object('ok', true, 'reason', 'registered',
                            'receipt', private.imprest_receipt_json(v_id, true));
end;
$$;

-- The receipt key comes from pgcrypto's `gen_random_bytes`, a cryptographic source. `postgres`
-- owns the `extensions` schema, and the function itself is executable by everyone.
grant usage on schema extensions to fv_definer_owner;

-- ---------------------------------------------------------------------------
-- Open a receipt: its key, for somebody allowed to see it. A read, so nothing is claimed.
-- ---------------------------------------------------------------------------
create or replace function api.staff_open_imprest_receipt(p_receipt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.acting_staff(array['director', 'manager', 'cashier']::public.app_role[]);
  v_disb  uuid;
begin
  select disbursement_id into v_disb from public.imprest_receipts where id = p_receipt_id;
  if v_actor is null or v_disb is null or not private.imprest_disbursement_visible(v_disb) then
    return jsonb_build_object('ok', false, 'reason', 'no_receipt');
  end if;
  return jsonb_build_object('ok', true, 'reason', 'opened',
                            'receipt', private.imprest_receipt_json(p_receipt_id, true));
end;
$$;

comment on function api.staff_open_imprest_receipt(uuid) is
  'The key to one receipt, for a Director, the Manager, or the Cashier whose disbursement it is. '
  'The file is fetched separately through a short-lived signed link.';

-- ---------------------------------------------------------------------------
-- Settle (the Cashier who proposed it, while it is handed out)
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_settle_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_lines jsonb, p_returned_tzs bigint,
  p_explanation text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_explanation text := nullif(private.normalise_label(p_explanation), '');
  v_stop        jsonb;
  v_d           public.imprest_disbursements%rowtype;
  v_lines       jsonb := '[]'::jsonb;
  v_line        jsonb;
  v_i           integer := 0;
  v_amount      bigint;
  v_purpose     text;
  v_receipt     uuid;
  v_reason      text;
  v_note        text;
  v_rc          public.imprest_receipts%rowtype;
  v_owner       text;
  v_seen        uuid[] := '{}';
  v_used        bigint := 0;
  v_none        integer := 0;
  v_remainder   bigint;
  v_settlement  uuid := gen_random_uuid();
  v_request     jsonb;
begin
  -- The lines are compared as the Cashier sent them, tidied the way they are stored, so a retry
  -- with any line, file, amount or explanation changed is a conflict and never a replay.
  if p_lines is not null and jsonb_typeof(p_lines) = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'amount_tzs', e -> 'amount_tzs',
             'purpose', private.normalise_label(e ->> 'purpose'),
             'receipt_id', e -> 'receipt_id',
             'no_receipt_reason', e -> 'no_receipt_reason',
             'no_receipt_note', nullif(private.normalise_label(e ->> 'no_receipt_note'), ''))
             order by n), '[]'::jsonb)
      into v_lines
      from jsonb_array_elements(p_lines) with ordinality as t(e, n);
  end if;
  v_request := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                  'lines', v_lines, 'returned_tzs', p_returned_tzs,
                                  'explanation', v_explanation);

  v_stop := private.imprest_own_disbursement_open(p_idempotency_key,
    'imprest.settle_disbursement', v_actor, v_request, p_id, p_expected_version, 'handed_out');
  if v_stop is not null then
    return v_stop;
  end if;

  select * into v_d from public.imprest_disbursements where id = p_id;

  if p_returned_tzs is null or p_returned_tzs < 0 or p_returned_tzs > v_d.amount_tzs then
    return jsonb_build_object('ok', false, 'reason',
      case when p_returned_tzs > v_d.amount_tzs then 'over_approval' else 'returned_invalid' end,
      'amount_tzs', v_d.amount_tzs, 'returned_tzs', p_returned_tzs);
  elsif p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'lines_invalid');
  elsif jsonb_array_length(p_lines) > 20 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_lines');
  end if;

  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_i := v_i + 1;

    -- A missing key is null, and null slips past every comparison, so its type is required first.
    if coalesce(jsonb_typeof(v_line -> 'amount_tzs'), 'missing') <> 'number'
       or (v_line ->> 'amount_tzs')::numeric <> trunc((v_line ->> 'amount_tzs')::numeric)
       or (v_line ->> 'amount_tzs')::numeric <= 0
       or (v_line ->> 'amount_tzs')::numeric > 100000000 then
      return jsonb_build_object('ok', false, 'reason', 'line_amount_invalid', 'line', v_i);
    end if;
    v_amount := (v_line ->> 'amount_tzs')::bigint;

    v_purpose := coalesce(v_line ->> 'purpose', '');
    if length(v_purpose) < 2 or length(v_purpose) > 120 then
      return jsonb_build_object('ok', false, 'reason', 'line_purpose_invalid', 'line', v_i);
    end if;

    v_reason := nullif(v_line ->> 'no_receipt_reason', '');
    v_note := v_line ->> 'no_receipt_note';
    if jsonb_typeof(v_line -> 'receipt_id') = 'string' then
      begin
        v_receipt := (v_line ->> 'receipt_id')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_found', 'line', v_i);
      end;
    else
      v_receipt := null;
    end if;

    if v_receipt is null and v_reason is null then
      return jsonb_build_object('ok', false, 'reason', 'line_evidence_required', 'line', v_i);
    elsif v_receipt is not null and (v_reason is not null or v_note is not null) then
      return jsonb_build_object('ok', false, 'reason', 'line_evidence_both', 'line', v_i);
    end if;

    if v_reason is not null then
      if not (v_reason = any (enum_range(null::public.imprest_no_receipt_reason)::text[])) then
        return jsonb_build_object('ok', false, 'reason', 'no_receipt_reason_invalid', 'line', v_i);
      elsif private.imprest_text_problem(v_note,
              v_reason in ('receipt_lost_or_damaged', 'other')) then
        return jsonb_build_object('ok', false, 'reason', 'no_receipt_note_required', 'line', v_i);
      end if;
      v_none := v_none + 1;
    else
      -- THE PATH IS CHECKED, NEVER TRUSTED (issue #62 criterion 10).
      select * into v_rc from public.imprest_receipts where id = v_receipt;
      if not found then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_found', 'line', v_i);
      elsif v_rc.disbursement_id <> p_id
            or v_rc.object_path not like 'imprest/' || p_id::text || '/%' then
        return jsonb_build_object('ok', false, 'reason', 'receipt_wrong_disbursement', 'line', v_i);
      elsif v_rc.uploaded_by <> v_actor then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_yours', 'line', v_i);
      elsif v_receipt = any (v_seen) then
        return jsonb_build_object('ok', false, 'reason', 'receipt_cited_twice', 'line', v_i);
      end if;

      select o.owner_id into v_owner from storage.objects o
       where o.bucket_id = 'imprest-evidence' and o.name = v_rc.object_path;
      if not found then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_uploaded', 'line', v_i);
      elsif v_owner is distinct from v_actor::text then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_yours', 'line', v_i);
      end if;
      v_seen := v_seen || v_receipt;
    end if;

    v_used := v_used + v_amount;
  end loop;

  -- AC-100: the lines and the returned cash may not claim more than was approved.
  if v_used + p_returned_tzs > v_d.amount_tzs then
    return jsonb_build_object('ok', false, 'reason', 'over_approval', 'amount_tzs', v_d.amount_tzs,
                              'used_tzs', v_used, 'returned_tzs', p_returned_tzs);
  end if;

  v_remainder := v_d.amount_tzs - v_used - p_returned_tzs;
  if v_remainder > 0 and private.imprest_text_problem(v_explanation, true) then
    return jsonb_build_object('ok', false, 'reason', 'explanation_required',
                              'unaccounted_tzs', v_remainder);
  elsif v_remainder = 0 and v_explanation is not null then
    return jsonb_build_object('ok', false, 'reason', 'explanation_not_needed');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.settle_disbursement', v_actor,
                               v_request, p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.imprest_settlements (id, disbursement_id, cycle, approved_tzs, used_tzs,
                                          returned_tzs, unaccounted_tzs, unaccounted_explanation,
                                          line_count, no_receipt_lines, settled_by)
  values (v_settlement, p_id, 1, v_d.amount_tzs, v_used, p_returned_tzs, v_remainder,
          case when v_remainder > 0 then v_explanation end, v_i, v_none, v_actor);

  insert into public.imprest_settlement_lines (settlement_id, line_no, amount_tzs, purpose,
                                               receipt_id, no_receipt_reason, no_receipt_note)
  select v_settlement, n::integer, (e ->> 'amount_tzs')::bigint, e ->> 'purpose',
         (e ->> 'receipt_id')::uuid,
         (nullif(e ->> 'no_receipt_reason', ''))::public.imprest_no_receipt_reason,
         e ->> 'no_receipt_note'
    from jsonb_array_elements(v_lines) with ordinality as t(e, n);

  update public.imprest_disbursements
     set status = 'settled', version = version + 1
   where id = p_id;

  perform private.imprest_disbursement_audit(v_actor, 'imprest_disbursement_settled', p_id,
    jsonb_build_object('status', 'handed_out'),
    jsonb_build_object('status', 'settled', 'cycle', 1, 'approved_tzs', v_d.amount_tzs,
                       'used_tzs', v_used, 'returned_tzs', p_returned_tzs,
                       'unaccounted_tzs', v_remainder, 'lines', v_i, 'no_receipt_lines', v_none,
                       'set_aside', true),
    'api.staff_settle_imprest_disbursement');

  return private.imprest_disbursement_result('settled', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The api surface: each wrapper commits a refusal to the audit trail
-- ---------------------------------------------------------------------------
create or replace function api.staff_hand_out_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_recipient text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_hand_out_imprest_disbursement(
  p_id, p_expected_version, p_recipient, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_hand_out_imprest_disbursement', 'imprest_disbursement', p_id, v);
end $$;

comment on function api.staff_hand_out_imprest_disbursement(uuid, integer, text, text) is
  'The Cashier who proposed an approved disbursement hands the approved amount out and names who '
  'received it (issue #62). The amount stays set aside.';

create or replace function api.staff_register_imprest_receipt(
  p_disbursement_id uuid, p_file_name text, p_content_type text, p_byte_size bigint,
  p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_register_imprest_receipt(
  p_disbursement_id, p_file_name, p_content_type, p_byte_size, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_register_imprest_receipt', 'imprest_disbursement',
                        p_disbursement_id, v);
end $$;

comment on function api.staff_register_imprest_receipt(uuid, text, text, bigint, text) is
  'Files one receipt on a handed-out disbursement and returns its path and encryption key. The '
  'phone encrypts the file with that key and uploads it to that path.';

create or replace function api.staff_settle_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_lines jsonb, p_returned_tzs bigint, p_explanation text,
  p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_settle_imprest_disbursement(
  p_id, p_expected_version, p_lines, p_returned_tzs, p_explanation, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_settle_imprest_disbursement', 'imprest_disbursement', p_id, v);
end $$;

comment on function api.staff_settle_imprest_disbursement(uuid, integer, jsonb, bigint, text, text) is
  'The Cashier settles a handed-out disbursement: its lines, the cash returned, and an explanation '
  'for any remainder. Approved = Used + Returned + Not accounted for (issue #62).';

-- ---------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature, n.nspname, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'api'
            and p.proname in ('staff_hand_out_imprest_disbursement', 'staff_register_imprest_receipt',
                              'staff_open_imprest_receipt', 'staff_settle_imprest_disbursement',
                              'staff_imprest_spending_position'))
        or (n.nspname = 'private'
            and p.proname in ('refuse_imprest_settlement_edit', 'check_imprest_settlement_totals',
                              'check_imprest_settlement_target',
                              'guard_imprest_disbursement_progress',
                              'imprest_disbursement_visible', 'guard_imprest_evidence_object',
                              'imprest_spending_figures', 'imprest_awaiting_verification_tzs',
                              'imprest_own_disbursement_open', 'imprest_receipt_json',
                              'impl_staff_hand_out_imprest_disbursement',
                              'impl_staff_register_imprest_receipt',
                              'impl_staff_settle_imprest_disbursement'))
  loop
    execute format('alter function %s owner to fv_definer_owner', fn.signature);
    execute format('revoke execute on function %s from public, anon, authenticated, service_role',
                   fn.signature);
    if fn.nspname = 'api' then
      execute format('grant execute on function %s to authenticated', fn.signature);
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';

commit;
