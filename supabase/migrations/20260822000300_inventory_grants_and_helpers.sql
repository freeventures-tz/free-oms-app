-- Stage 10D · Grants, row-level security, and the helpers the stock commands share
--
-- The same two independent mechanisms as every stage before this one (architecture.md §13.1):
-- GRANT decides which tables a role may touch, RLS decides which rows. Both are required and
-- neither may be the only one.
--
-- READS follow design.md §4.2 exactly:
--
--   suppliers          all four live roles. A delegated Cashier or Sales Representative entering a
--                      receipt has to pick one, and §14.5 lists suppliers among imprest payees.
--   stock and ledger   Manager and Director. §4.2 gives "Inventory & stock" to those two alone.
--                      A Sales Representative will need availability when orders arrive; widening
--                      it then, for a reason that exists then, beats widening it now for one that
--                      does not.
--   receipts, transfers, adjustments
--                      Manager and Director, PLUS whoever entered the record. Entry is delegable
--                      (§9.1) and a Cashier who enters a receipt must be able to see what became
--                      of it — otherwise the system takes their work and shows them nothing.
--
-- WRITES: there is no INSERT, UPDATE or DELETE grant to `authenticated` on any table in this file,
-- and no policy for those actions either, so a hand-rolled PostgREST call fails on privilege before
-- a policy is consulted. Every write goes through an `api` function that derives its actor from the
-- verified session.

begin;

alter table public.suppliers             enable row level security;
alter table public.inventory_ledger      enable row level security;
alter table public.opening_stock_entries enable row level security;
alter table public.stock_receipts        enable row level security;
alter table public.stock_receipt_lines   enable row level security;
alter table public.stock_transfers       enable row level security;
alter table public.stock_transfer_lines  enable row level security;
alter table public.stock_adjustments     enable row level security;

-- ---------------------------------------------------------------------------
-- Reads for `authenticated`
--
-- ONE permissive policy per table and action. Two would be ORed and evaluated separately on every
-- row, which the advisors flag and which turns "who can see this?" into a question with two
-- answers. Where a rule needs an OR it is written inside the single policy.
--
-- `private.authorize` is wrapped in a scalar subquery so the planner evaluates it once per
-- statement rather than once per row (the `auth_rls_initplan` rule).
-- ---------------------------------------------------------------------------
grant select on public.suppliers             to authenticated;
grant select on public.inventory_ledger      to authenticated;
grant select on public.current_stock         to authenticated;
grant select on public.opening_stock_entries to authenticated;
grant select on public.stock_receipts        to authenticated;
grant select on public.stock_receipt_lines   to authenticated;
grant select on public.stock_transfers       to authenticated;
grant select on public.stock_transfer_lines  to authenticated;
grant select on public.stock_adjustments     to authenticated;

create policy suppliers_select_live_staff on public.suppliers
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

create policy inventory_ledger_select_oversight on public.inventory_ledger
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

create policy opening_stock_select_oversight on public.opening_stock_entries
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

-- The enterer sees their own work; oversight sees everything. One policy, one OR.
create policy stock_receipts_select on public.stock_receipts
  for select to authenticated
  using (
    entered_by = (select private.request_uid())
    or (select private.authorize(array['director','manager']::public.app_role[]))
  );

-- Lines follow their header rather than repeating its rule, so the two can never disagree about
-- who may read a receipt.
create policy stock_receipt_lines_select on public.stock_receipt_lines
  for select to authenticated
  using (
    exists (
      select 1 from public.stock_receipts r
       where r.id = stock_receipt_lines.receipt_id
         and (r.entered_by = (select private.request_uid())
              or (select private.authorize(array['director','manager']::public.app_role[])))
    )
  );

create policy stock_transfers_select on public.stock_transfers
  for select to authenticated
  using (
    entered_by = (select private.request_uid())
    or (select private.authorize(array['director','manager']::public.app_role[]))
  );

create policy stock_transfer_lines_select on public.stock_transfer_lines
  for select to authenticated
  using (
    exists (
      select 1 from public.stock_transfers t
       where t.id = stock_transfer_lines.transfer_id
         and (t.entered_by = (select private.request_uid())
              or (select private.authorize(array['director','manager']::public.app_role[])))
    )
  );

create policy stock_adjustments_select on public.stock_adjustments
  for select to authenticated
  using (
    entered_by = (select private.request_uid())
    or (select private.authorize(array['director','manager']::public.app_role[]))
  );

-- ---------------------------------------------------------------------------
-- What the definer owner needs, and no more
--
-- `fv_definer_owner` is not the owner of these tables, so RLS applies to it inside SECURITY DEFINER
-- functions and it needs both a grant and a policy. It gets SELECT and INSERT. It does NOT get
-- UPDATE or DELETE on the ledger — and neither does anybody else, which is two independent reasons
-- a movement cannot be rewritten, on top of the trigger that refuses the write for every role.
-- ---------------------------------------------------------------------------
grant select, insert on public.suppliers             to fv_definer_owner;
grant update         on public.suppliers             to fv_definer_owner;
grant select, insert on public.inventory_ledger      to fv_definer_owner;
grant select, insert on public.opening_stock_entries to fv_definer_owner;
grant select, insert on public.stock_receipts        to fv_definer_owner;
grant select, insert on public.stock_receipt_lines   to fv_definer_owner;
grant select, insert on public.stock_transfers       to fv_definer_owner;
grant select, insert on public.stock_transfer_lines  to fv_definer_owner;
grant select, insert on public.stock_adjustments     to fv_definer_owner;
grant select         on public.current_stock         to fv_definer_owner;

-- Part B granted the definer owner SELECT on `units` and overlooked `inventory_locations`, because
-- no command had yet needed to check that a location exists. Four of them do now, and without this
-- every one of them fails with "permission denied for table inventory_locations" — which a pgTAP
-- run found on the first attempt and no amount of reading the migration would have.
grant select on public.inventory_locations to fv_definer_owner;
grant select on public.products            to fv_definer_owner;

-- Stage 8A built these two and granted the definer owner nothing on them, because nothing wrote an
-- approval yet. Receiving and transfers do.
grant select, insert, update on public.approval_requests  to fv_definer_owner;
grant select, insert         on public.approval_decisions to fv_definer_owner;

-- RLS applies to `fv_definer_owner` on this table because it is not its owner, so the grant above
-- is only half of what a definer function needs to read it.
create policy locations_definer_owner_read on public.inventory_locations
  for select to fv_definer_owner using ( true );

create policy suppliers_definer_owner_read on public.suppliers
  for select to fv_definer_owner using ( true );
create policy suppliers_definer_owner_insert on public.suppliers
  for insert to fv_definer_owner with check ( true );
-- UPDATE, uniquely on this table, and only because §3.2's "deactivated, never deleted" rule needs
-- one column to change. There is no rename path: `api.admin_set_supplier_active` touches
-- `is_active` and nothing else, and the pgTAP suite asserts a supplier's name never changes.
create policy suppliers_definer_owner_update on public.suppliers
  for update to fv_definer_owner using ( true ) with check ( true );

create policy inventory_ledger_definer_owner_read on public.inventory_ledger
  for select to fv_definer_owner using ( true );
create policy inventory_ledger_definer_owner_insert on public.inventory_ledger
  for insert to fv_definer_owner with check ( true );

create policy opening_stock_definer_owner_read on public.opening_stock_entries
  for select to fv_definer_owner using ( true );
create policy opening_stock_definer_owner_insert on public.opening_stock_entries
  for insert to fv_definer_owner with check ( true );

create policy stock_receipts_definer_owner_read on public.stock_receipts
  for select to fv_definer_owner using ( true );
create policy stock_receipts_definer_owner_insert on public.stock_receipts
  for insert to fv_definer_owner with check ( true );

create policy stock_receipt_lines_definer_owner_read on public.stock_receipt_lines
  for select to fv_definer_owner using ( true );
create policy stock_receipt_lines_definer_owner_insert on public.stock_receipt_lines
  for insert to fv_definer_owner with check ( true );

create policy stock_transfers_definer_owner_read on public.stock_transfers
  for select to fv_definer_owner using ( true );
create policy stock_transfers_definer_owner_insert on public.stock_transfers
  for insert to fv_definer_owner with check ( true );

create policy stock_transfer_lines_definer_owner_read on public.stock_transfer_lines
  for select to fv_definer_owner using ( true );
create policy stock_transfer_lines_definer_owner_insert on public.stock_transfer_lines
  for insert to fv_definer_owner with check ( true );

create policy stock_adjustments_definer_owner_read on public.stock_adjustments
  for select to fv_definer_owner using ( true );
create policy stock_adjustments_definer_owner_insert on public.stock_adjustments
  for insert to fv_definer_owner with check ( true );

create policy approval_requests_definer_owner_read on public.approval_requests
  for select to fv_definer_owner using ( true );
create policy approval_requests_definer_owner_insert on public.approval_requests
  for insert to fv_definer_owner with check ( true );
-- The projection of the latest decision, and the only reason UPDATE exists here. The authoritative
-- record is `approval_decisions`, which is insert-only.
create policy approval_requests_definer_owner_update on public.approval_requests
  for update to fv_definer_owner using ( true ) with check ( true );

create policy approval_decisions_definer_owner_read on public.approval_decisions
  for select to fv_definer_owner using ( true );
create policy approval_decisions_definer_owner_insert on public.approval_decisions
  for insert to fv_definer_owner with check ( true );

-- The two new trigger functions are reachable by nobody: PostgreSQL does not check EXECUTE when
-- firing a trigger, so this costs nothing and closes the default PUBLIC grant that the Stage 8A
-- surface tests refuse to tolerate.
revoke execute on function private.refuse_ledger_edit()     from public, anon, authenticated, service_role;
revoke execute on function private.refuse_negative_stock()  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.acting_staff — authority for a command that is not Director-only
--
-- `private.acting_director()` answers one question: is the person making this request a live
-- Director? Receiving, transfers and adjustments are performed by other roles, so they need the
-- same question asked about a different set — and they need it asked THE SAME WAY, from the
-- verified session, with no parameter a caller could aim.
--
-- It checks exactly what `acting_director` checks: a real session, an active profile, the
-- first-login gate cleared, and a live role. Somebody halfway through their forced password change
-- is not staff yet.
-- ---------------------------------------------------------------------------
create or replace function private.acting_staff(p_allowed public.app_role[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.request_uid();
  v_role  public.app_role;
begin
  if v_actor is null then
    raise exception 'this command requires an authenticated session'
      using errcode = 'insufficient_privilege';
  end if;

  v_role := private.live_role_of(v_actor);

  -- `live_role_of` checks active and role; the gate is checked here so the refusal is identical in
  -- shape to `acting_director`'s and a half-provisioned account cannot move stock.
  if v_role is null
     or not (v_role = any (p_allowed))
     or exists (select 1 from public.profiles p
                 where p.id = v_actor and p.must_change_password) then
    raise exception 'actor % may not perform this command', v_actor
      using errcode = 'insufficient_privilege';
  end if;

  return v_actor;
end;
$$;

comment on function private.acting_staff(public.app_role[]) is
  'The live staff member making THIS request, refused unless they hold one of the allowed roles. '
  'No actor parameter, for the same reason private.acting_director() has none: nobody — server, '
  'script or leaked key — may nominate somebody else as the actor.';

alter function private.acting_staff(public.app_role[]) owner to fv_definer_owner;
revoke execute on function private.acting_staff(public.app_role[])
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.write_stock_movement — the one place a ledger row is created
--
-- Seven commands in this stage and more in the stages after it all end in the same insert. Writing
-- it once means the columns that make a movement traceable — cause, actor, authoriser, correlation
-- — cannot be forgotten by the eighth.
-- ---------------------------------------------------------------------------
create or replace function private.write_stock_movement(
  p_product_id     uuid,
  p_location_code  text,
  p_stock_state    public.stock_state,
  p_quantity_delta bigint,
  p_movement_kind  public.stock_movement_kind,
  p_source_type    text,
  p_source_id      uuid,
  p_actor_id       uuid,
  p_actor_role     public.app_role,
  p_approved_by    uuid,
  p_approved_role  public.app_role,
  p_correlation_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A movement of nothing is not a movement. Callers pass whatever a line worked out to, and a
  -- fully-damaged receipt line legitimately works out to zero, so this is a normal early return
  -- rather than a refusal.
  if p_quantity_delta = 0 then
    return;
  end if;

  insert into public.inventory_ledger (
    product_id, location_code, stock_state, quantity_delta, movement_kind,
    source_type, source_id, actor_id, actor_role, approved_by, approved_role, correlation_id
  )
  values (
    p_product_id, p_location_code, p_stock_state, p_quantity_delta, p_movement_kind,
    p_source_type, p_source_id, p_actor_id, p_actor_role, p_approved_by, p_approved_role,
    p_correlation_id
  );
end;
$$;

comment on function private.write_stock_movement(
  uuid, text, public.stock_state, bigint, public.stock_movement_kind, text, uuid,
  uuid, public.app_role, uuid, public.app_role, uuid) is
  'Appends one inventory_ledger row. The single writer, so every movement carries its cause, its '
  'actor and its authoriser whatever module created it (AC-82).';

alter function private.write_stock_movement(
  uuid, text, public.stock_state, bigint, public.stock_movement_kind, text, uuid,
  uuid, public.app_role, uuid, public.app_role, uuid) owner to fv_definer_owner;
revoke execute on function private.write_stock_movement(
  uuid, text, public.stock_state, bigint, public.stock_movement_kind, text, uuid,
  uuid, public.app_role, uuid, public.app_role, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.stock_on_hand — the balance, for a decision rather than for a screen
--
-- The view is for reading. This is for the moment a command must know whether a movement is
-- allowed, and it is deliberately a separate function so the caller has already taken the advisory
-- lock that makes the answer still true a line later.
-- ---------------------------------------------------------------------------
create or replace function private.stock_on_hand(
  p_product_id    uuid,
  p_location_code text,
  p_stock_state   public.stock_state
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.quantity_delta), 0)
    from public.inventory_ledger l
   where l.product_id    = p_product_id
     and l.location_code = p_location_code
     and l.stock_state   = p_stock_state;
$$;

comment on function private.stock_on_hand(uuid, text, public.stock_state) is
  'Physical stock of one product at one location in one state. Not available stock: §8.1 subtracts '
  'reserved and committed, which arrive with orders.';

alter function private.stock_on_hand(uuid, text, public.stock_state) owner to fv_definer_owner;
revoke execute on function private.stock_on_hand(uuid, text, public.stock_state)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.open_approval / private.settle_approval
--
-- §4.2 and §4.3 in two functions, so four commands cannot implement them four ways.
--
--   open    records that a decision is owed, by whom, and from which role.
--   settle  appends the decision to append-only history and moves the projection with it.
--
-- The check constraint on `approval_requests` does the actual enforcing — only an approved outcome
-- may carry an approver — and these functions are what make sure it is always the constraint that
-- gets the last word rather than a `case` somebody wrote in a hurry.
-- ---------------------------------------------------------------------------
create or replace function private.open_approval(
  p_entity_type   text,
  p_entity_id     uuid,
  p_approval_type public.approval_type,
  p_requested_by  uuid,
  p_requested_role public.app_role,
  p_required_role public.app_role
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.approval_requests (
    entity_type, entity_id, approval_type, requested_by, requested_role, required_role, status
  )
  values (
    p_entity_type, p_entity_id, p_approval_type, p_requested_by, p_requested_role,
    p_required_role, 'pending'
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function private.open_approval(
  text, uuid, public.approval_type, uuid, public.app_role, public.app_role) is
  'Records that a decision is owed on an entity, who asked for it, and which role must give it '
  '(product.md §4.1). Entry is never approval (§4.2), so this leaves the row pending.';

alter function private.open_approval(
  text, uuid, public.approval_type, uuid, public.app_role, public.app_role)
  owner to fv_definer_owner;
revoke execute on function private.open_approval(
  text, uuid, public.approval_type, uuid, public.app_role, public.app_role)
  from public, anon, authenticated, service_role;

create or replace function private.settle_approval(
  p_request_id   uuid,
  p_outcome      public.decision_outcome,
  p_decided_by   uuid,
  p_decided_role public.app_role,
  p_reason       text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision_id uuid;
begin
  insert into public.approval_decisions (
    request_id, outcome, decided_by, decided_role, note
  )
  values (p_request_id, p_outcome, p_decided_by, p_decided_role, p_reason)
  returning id into v_decision_id;

  -- The projection. §4.3: a rejected, cancelled, expired, superseded or withdrawn record is a
  -- completed decision and NOT an approval, so it records the deciding actor as a rejector in
  -- `approval_decisions` above and leaves `approved_by` null here. The table's own check constraint
  -- refuses the row if this `case` is ever written wrong, which is the point of having both.
  update public.approval_requests
     set status        = p_outcome::text::public.approval_status,
         approved_by   = case when p_outcome = 'approved' then p_decided_by   else null end,
         approved_role = case when p_outcome = 'approved' then p_decided_role else null end,
         approved_at   = case when p_outcome = 'approved' then now()          else null end
   where id = p_request_id;

  return v_decision_id;
end;
$$;

comment on function private.settle_approval(
  uuid, public.decision_outcome, uuid, public.app_role, text) is
  'Appends one decision to append-only history and moves the request projection to match it. Only '
  'an approved outcome records an approver (product.md §4.3, AC-84).';

alter function private.settle_approval(uuid, public.decision_outcome, uuid, public.app_role, text)
  owner to fv_definer_owner;
revoke execute on function private.settle_approval(
  uuid, public.decision_outcome, uuid, public.app_role, text)
  from public, anon, authenticated, service_role;

-- service_role holds no table privilege in `public`, and the eight new tables and the new view must
-- not have quietly acquired one. Re-asserted rather than assumed; the advisors fail the run
-- otherwise.
revoke all on public.suppliers             from service_role;
revoke all on public.inventory_ledger      from service_role;
revoke all on public.current_stock         from service_role;
revoke all on public.opening_stock_entries from service_role;
revoke all on public.stock_receipts        from service_role;
revoke all on public.stock_receipt_lines   from service_role;
revoke all on public.stock_transfers       from service_role;
revoke all on public.stock_transfer_lines  from service_role;
revoke all on public.stock_adjustments     from service_role;

commit;
