-- Issue #73 · Imprest: link a supplier delivery paid from imprest to its disbursement
--
-- product.md §9.1, §13.9 and AC-31. A supplier delivery paid from imprest must not be entered twice.
-- When a stock receipt is ENTERED (Owner decision, 28 September 2026), the person entering it marks
-- it Paid from imprest and picks the disbursement that paid for it. Nothing about the payment is
-- typed again, and Manager approval of the receipt is unchanged.
--
--   stock_receipt_imprest_links   one row per linked receipt, keyed by the receipt, so a receipt
--                                 names at most one disbursement and a disbursement may pay for
--                                 several receipts. Written with the receipt, by the person who
--                                 entered it, in the same transaction, and never changed or deleted.
--
-- WHAT IT CHANGES. Nothing but the record. A link moves no imprest figure (it is not a posting and
-- sets nothing aside) and no stock figure (stock still increases only on the Manager's approval of
-- the receipt).
--
-- WHO. The Manager links to any disbursement of the active fund, and a Cashier to one of their own:
-- the same disbursements each can read. A Sales Representative enters receipts but sees no imprest
-- record, so is refused a link. Only a disbursement that has been handed out, settled, sent back or
-- verified paid for anything, so only those can be picked.
--
-- THE COMMAND. `api.staff_enter_stock_receipt` gains a seventh argument, the disbursement, or null.
-- Its body moves to a seven-argument `private.impl_staff_enter_stock_receipt`; every line of the
-- released body is kept, and the link is checked with the other inputs before anything is written.
-- The six-argument `api` form stays, calling the new body with no link, so the application released
-- before this migration keeps entering receipts while the two deploy.
--
-- THREE READS. The disbursements a receipt can be linked to, the disbursement of each receipt, and
-- the receipts of a disbursement, each for everyone who can read the side it starts from.

begin;

-- ---------------------------------------------------------------------------
-- The link
-- ---------------------------------------------------------------------------
create table public.stock_receipt_imprest_links (
  receipt_id       uuid primary key references public.stock_receipts (id) on delete restrict,
  disbursement_id  uuid not null references public.imprest_disbursements (id) on delete restrict,
  -- The disbursement's fund, kept so a retired fund refuses a new link like any other new row.
  fund_id          uuid not null references public.imprest_funds (id) on delete restrict,
  linked_by        uuid not null references public.profiles (id),
  linked_role      public.app_role not null check (linked_role in ('manager', 'cashier')),
  linked_at        timestamptz not null default now(),
  correlation_id   uuid not null
);

comment on table public.stock_receipt_imprest_links is
  'A stock receipt paid from imprest and the disbursement that paid for it (issue #73, product.md '
  '§9.1, §13.9, AC-31). Written when the receipt is entered, by the person who entered it, and '
  'never changed or deleted. Moves no imprest or stock figure.';

create index stock_receipt_imprest_links_disbursement_idx
  on public.stock_receipt_imprest_links (disbursement_id, linked_at desc);
create index stock_receipt_imprest_links_fund_idx on public.stock_receipt_imprest_links (fund_id);
create index stock_receipt_imprest_links_linked_by_idx
  on public.stock_receipt_imprest_links (linked_by);

create trigger stock_receipt_imprest_links_append_only
  before update or delete on public.stock_receipt_imprest_links
  for each row execute function private.refuse_imprest_settlement_edit();
create trigger stock_receipt_imprest_links_no_truncate
  before truncate on public.stock_receipt_imprest_links
  for each statement execute function private.refuse_imprest_settlement_edit();
create trigger stock_receipt_imprest_links_fund_active
  before insert on public.stock_receipt_imprest_links
  for each row execute function private.refuse_retired_imprest_fund();

-- Consistent, whoever writes the row: made with the receipt, by the person who entered it, to a
-- disbursement of that fund that paid out, by someone who may read it.
create or replace function private.check_stock_receipt_imprest_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.stock_receipts%rowtype;
  v_d       public.imprest_disbursements%rowtype;
begin
  select * into v_receipt from public.stock_receipts where id = new.receipt_id;
  select * into v_d from public.imprest_disbursements where id = new.disbursement_id;

  -- `now()` is the transaction's start, so a link made after the entry's own transaction differs.
  if v_receipt.id is null or new.linked_by <> v_receipt.entered_by
     or new.linked_at <> v_receipt.entered_at then
    raise exception 'stock receipt % is linked when it is entered, by who entered it',
      new.receipt_id using errcode = 'restrict_violation';
  end if;

  if new.fund_id <> v_d.fund_id
     or v_d.status::text not in ('handed_out', 'settled', 'sent_back', 'verified') then
    raise exception 'stock receipt % can only be linked to a disbursement of its fund that paid out',
      new.receipt_id using errcode = 'restrict_violation';
  end if;

  if new.linked_role = 'cashier' and v_d.proposed_by <> new.linked_by then
    raise exception 'a Cashier links a stock receipt only to their own disbursement'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

comment on function private.check_stock_receipt_imprest_link() is
  'A stock receipt''s imprest link is made with the receipt, by the person who entered it, to a '
  'disbursement of the named fund that was handed out, settled, sent back or verified; a Cashier''s '
  'to their own (issue #73).';

create trigger stock_receipt_imprest_links_check
  before insert on public.stock_receipt_imprest_links
  for each row execute function private.check_stock_receipt_imprest_link();

-- ---------------------------------------------------------------------------
-- Grants and row-level security: whoever can read the receipt or the disbursement
-- ---------------------------------------------------------------------------
alter table public.stock_receipt_imprest_links enable row level security;

revoke all on public.stock_receipt_imprest_links from public, anon, authenticated, service_role;
grant select on public.stock_receipt_imprest_links to authenticated;
grant select, insert on public.stock_receipt_imprest_links to fv_definer_owner;

create policy stock_receipt_imprest_links_select on public.stock_receipt_imprest_links
  for select to authenticated
  using (
    (select private.authorize(array['director', 'manager']::public.app_role[]))
    or exists (select 1 from public.stock_receipts r
                where r.id = stock_receipt_imprest_links.receipt_id
                  and r.entered_by = (select private.request_uid()))
    or ((select private.authorize(array['cashier']::public.app_role[]))
        and exists (select 1 from public.imprest_disbursements d
                     where d.id = stock_receipt_imprest_links.disbursement_id
                       and d.proposed_by = (select auth.uid())))
  );

create policy stock_receipt_imprest_links_definer_owner on public.stock_receipt_imprest_links
  for all to fv_definer_owner using (true) with check (true);

-- ---------------------------------------------------------------------------
-- What a picker and a record show of a disbursement
-- ---------------------------------------------------------------------------
create or replace function private.stock_receipt_disbursement_summary(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', d.id, 'disbursement_no', d.disbursement_no,
                            'status', d.status, 'category', d.category,
                            'recipient', h.recipient, 'handed_out_at', h.handed_out_at,
                            'approved_tzs', private.imprest_approved_tzs(d.id))
    from public.imprest_disbursements d
    left join public.imprest_disbursement_handouts h on h.disbursement_id = d.id
   where d.id = p_id;
$$;

comment on function private.stock_receipt_disbursement_summary(uuid) is
  'A disbursement as a stock receipt shows it: number, status, category, payee (the recipient it '
  'was handed out to) and approved amount (issue #73).';

-- ---------------------------------------------------------------------------
-- The command: the released body, with the link checked and written
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_enter_stock_receipt(
  p_supplier_id       uuid,
  p_location_code     text,
  p_delivery_date     date,
  p_delivery_note_ref text,
  p_lines             jsonb,
  p_disbursement_id   uuid,
  p_idempotency_key   text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := private.acting_staff(
                         array['manager','cashier','sales_rep']::public.app_role[]);
  v_role       public.app_role := private.live_role_of(v_actor);
  v_note_ref   text := private.normalise_label(p_delivery_note_ref);
  v_corr       uuid := gen_random_uuid();
  v_receipt_id uuid := gen_random_uuid();
  v_receipt    public.stock_receipts%rowtype;
  v_link       public.stock_receipt_imprest_links%rowtype;
  v_d          public.imprest_disbursements%rowtype;
  v_class      jsonb;
  v_claimed    integer;
  v_line       jsonb;
  v_expected   numeric;
  v_received   numeric;
  v_damaged    numeric;
  v_distinct   integer;
  v_total      integer;
  v_request    jsonb := jsonb_build_object(
    'supplier_id',       p_supplier_id,
    'location_code',     p_location_code,
    'delivery_date',     p_delivery_date,
    'delivery_note_ref', private.canonical_identity(v_note_ref),
    -- The lines as presented. Two retries of the same submission send the identical payload, and
    -- anything else — a different order, a changed quantity — is a CONFLICT, which changes nothing.
    -- That is the safe direction to be wrong in.
    'lines',             coalesce(p_lines, '[]'::jsonb)
  )
  -- Only when there is one, so a receipt without a link is the same request it always was.
  || case when p_disbursement_id is null then '{}'::jsonb
          else jsonb_build_object('disbursement_id', p_disbursement_id) end;
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.enter_receipt', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    return private.stock_receipt_entry_result('replayed', (v_class ->> 'result_ref')::uuid);
  end if;

  if not exists (
    select 1 from public.suppliers s where s.id = p_supplier_id and s.is_active
  ) then
    return jsonb_build_object('ok', false, 'reason', 'no_supplier');
  end if;

  if not exists (select 1 from public.inventory_locations l where l.code = p_location_code) then
    return jsonb_build_object('ok', false, 'reason', 'no_location');
  end if;

  if length(v_note_ref) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'delivery_note_required');
  end if;

  if p_delivery_date is null then
    return jsonb_build_object('ok', false, 'reason', 'delivery_date_required');
  end if;

  -- A delivery cannot have arrived tomorrow. The business day is Africa/Dar_es_Salaam (§15.3), so
  -- the comparison is made there rather than in whatever zone the server happens to run in.
  if p_delivery_date > (now() at time zone 'Africa/Dar_es_Salaam')::date then
    return jsonb_build_object('ok', false, 'reason', 'delivery_date_future');
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'lines_required');
  end if;

  select count(distinct t.elem ->> 'product_id'), count(*)
    into v_distinct, v_total
    from jsonb_array_elements(p_lines) as t(elem);

  if v_distinct is distinct from v_total then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_product_line');
  end if;

  -- Every line is checked before ANY of them is written, so a bad fifth line does not leave four
  -- good ones behind for somebody to wonder about.
  for v_line in select t.elem from jsonb_array_elements(p_lines) as t(elem) loop
    if jsonb_typeof(v_line -> 'product_id')        <> 'string'
       or jsonb_typeof(v_line -> 'expected_quantity') <> 'number'
       or jsonb_typeof(v_line -> 'received_quantity') <> 'number' then
      return jsonb_build_object('ok', false, 'reason', 'line_invalid');
    end if;

    if not exists (
      select 1 from public.products p
       where p.id = (v_line ->> 'product_id')::uuid and p.is_active
    ) then
      return jsonb_build_object('ok', false, 'reason', 'no_product');
    end if;

    v_expected := (v_line ->> 'expected_quantity')::numeric;
    v_received := (v_line ->> 'received_quantity')::numeric;
    v_damaged  := coalesce((v_line ->> 'damaged_quantity')::numeric, 0);

    -- Whole counting units only (product.md §6.1 rule 1). Half a bag is not a quantity this system
    -- can express, and rounding one silently is how a ledger stops reconciling.
    if v_expected <> trunc(v_expected) or v_received <> trunc(v_received)
       or v_damaged <> trunc(v_damaged) then
      return jsonb_build_object('ok', false, 'reason', 'quantity_not_whole');
    end if;

    if v_expected < 0 or v_received < 0 or v_damaged < 0
       or v_expected > 10000000 or v_received > 10000000 then
      return jsonb_build_object('ok', false, 'reason', 'quantity_invalid');
    end if;

    if v_damaged > v_received then
      return jsonb_build_object('ok', false, 'reason', 'damaged_exceeds_received');
    end if;
  end loop;

  -- Paid from imprest (issue #73): a disbursement of the active fund that paid out, which the
  -- person entering the receipt may read. A Sales Representative reads no imprest record.
  if p_disbursement_id is not null then
    if v_role = 'sales_rep' then
      return jsonb_build_object('ok', false, 'reason', 'imprest_link_not_permitted');
    end if;

    select * into v_d from public.imprest_disbursements where id = p_disbursement_id;

    if v_d.id is null or (v_role = 'cashier' and v_d.proposed_by <> v_actor) then
      return jsonb_build_object('ok', false, 'reason', 'no_disbursement');
    end if;

    if not exists (select 1 from public.imprest_funds f where f.id = v_d.fund_id and f.is_active) then
      return jsonb_build_object('ok', false, 'reason', 'disbursement_fund_retired');
    end if;

    if v_d.status::text not in ('handed_out', 'settled', 'sent_back', 'verified') then
      return jsonb_build_object('ok', false, 'reason', 'disbursement_not_paid',
                                'status', v_d.status::text);
    end if;
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.enter_receipt', v_receipt_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.enter_receipt', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    return private.stock_receipt_entry_result('replayed', (v_class ->> 'result_ref')::uuid);
  end if;

  insert into public.stock_receipts (
    id, supplier_id, location_code, delivery_note_ref, delivery_date, entered_by, entered_role
  )
  values (
    v_receipt_id, p_supplier_id, p_location_code, v_note_ref, p_delivery_date, v_actor, v_role
  )
  returning * into v_receipt;

  insert into public.stock_receipt_lines (
    receipt_id, product_id, expected_quantity, received_quantity, damaged_quantity, damage_note
  )
  select v_receipt_id,
         (t.elem ->> 'product_id')::uuid,
         (t.elem ->> 'expected_quantity')::bigint,
         (t.elem ->> 'received_quantity')::bigint,
         coalesce((t.elem ->> 'damaged_quantity')::bigint, 0),
         nullif(private.normalise_label(t.elem ->> 'damage_note'), '')
    from jsonb_array_elements(p_lines) as t(elem);

  -- Entry is not approval (§4.2). This records that a decision is OWED, from a Manager, and the
  -- record stays pending until one is made.
  perform private.open_approval(
    'stock_receipt', v_receipt_id, 'supplier_receipt', v_actor, v_role, 'manager');

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false,
    'stock_receipt_entered', 'stock_receipt', v_receipt_id,
    null, to_jsonb(v_receipt), v_corr, 'api.staff_enter_stock_receipt'
  );

  if p_disbursement_id is not null then
    insert into public.stock_receipt_imprest_links (
      receipt_id, disbursement_id, fund_id, linked_by, linked_role, correlation_id
    )
    values (v_receipt_id, v_d.id, v_d.fund_id, v_actor, v_role, v_corr)
    returning * into v_link;

    insert into public.audit_events (
      actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
      before_state, after_state, correlation_id, source_operation
    )
    values (
      v_actor, v_role, false,
      'stock_receipt_paid_from_imprest', 'stock_receipt', v_receipt_id,
      null, to_jsonb(v_link), v_corr, 'api.staff_enter_stock_receipt'
    );
  end if;

  return private.stock_receipt_entry_result('entered', v_receipt_id);
end;
$$;

comment on function private.impl_staff_enter_stock_receipt(uuid, text, date, text, jsonb, uuid, text) is
  'Records what arrived from a supplier (product.md §9) and, when it was paid from imprest, the '
  'disbursement that paid for it (issue #73). Writes NO ledger row and no imprest figure.';

-- The receipt and its link, as the command returns them.
create or replace function private.stock_receipt_entry_result(p_reason text, p_receipt_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true, 'reason', p_reason,
    'receipt', (select to_jsonb(r) from public.stock_receipts r where r.id = p_receipt_id),
    'imprest_link', (select to_jsonb(l) from public.stock_receipt_imprest_links l
                      where l.receipt_id = p_receipt_id));
$$;

drop function private.impl_staff_enter_stock_receipt(uuid, text, date, text, jsonb, text);

-- The api surface. The seven-argument form is what the application calls; the six-argument form
-- enters a receipt with no link, for the application released before this migration.
create or replace function api.staff_enter_stock_receipt(
  p_supplier_id uuid, p_location_code text, p_delivery_date date, p_delivery_note_ref text,
  p_lines jsonb, p_disbursement_id uuid, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  -- A link joins the active fund, so it waits for a retirement being approved, as a proposal does.
  if p_disbursement_id is not null then
    perform pg_advisory_xact_lock_shared(hashtextextended('imprest:active_fund', 0));
  end if;

  v_result := private.impl_staff_enter_stock_receipt(p_supplier_id, p_location_code,
    p_delivery_date, p_delivery_note_ref, p_lines, p_disbursement_id, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  -- A refusal of the link is about the disbursement; any other is about the delivery.
  if v_result ->> 'reason' in ('imprest_link_not_permitted', 'no_disbursement',
                               'disbursement_fund_retired', 'disbursement_not_paid') then
    return private.refuse('api.staff_enter_stock_receipt', 'imprest_disbursement',
                          p_disbursement_id, v_result);
  end if;
  return private.refuse('api.staff_enter_stock_receipt', 'supplier', p_supplier_id, v_result);
end;
$$;

comment on function api.staff_enter_stock_receipt(uuid, text, date, text, jsonb, uuid, text) is
  'Records what arrived from a supplier (product.md §9). Entry may be delegated to a Cashier or '
  'a Sales Representative (§9.1). Writes NO ledger row: stock increases only on Manager '
  'approval. A Manager or Cashier may mark it paid from imprest by naming a disbursement of the '
  'active fund that was handed out, settled, sent back or verified (issue #73).';

create or replace function api.staff_enter_stock_receipt(
  p_supplier_id uuid, p_location_code text, p_delivery_date date, p_delivery_note_ref text,
  p_lines jsonb, p_idempotency_key text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select api.staff_enter_stock_receipt(p_supplier_id, p_location_code, p_delivery_date,
                                       p_delivery_note_ref, p_lines, null, p_idempotency_key);
$$;

comment on function api.staff_enter_stock_receipt(uuid, text, date, text, jsonb, text) is
  'Records what arrived from a supplier (product.md §9) with no imprest link. Kept for the '
  'application released before issue #73; it calls the seven-argument form.';

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
-- The disbursements a receipt can be linked to: the active fund's that paid out, newest hand-out
-- first. The Manager sees all of them and a Cashier their own. Not capped: a verified payment stays
-- pickable until the fund retires, and a cap would drop the oldest from the list without saying so.
-- The fund's own life bounds how many there are.
create or replace function api.staff_imprest_receipt_payment_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.acting_staff(array['manager', 'cashier']::public.app_role[]);
  v_role  public.app_role := private.live_role_of(v_actor);
begin
  return coalesce((
    select jsonb_agg(private.stock_receipt_disbursement_summary(d.id) order by h.handed_out_at desc,
                                                                               d.id)
      from public.imprest_disbursements d
      join public.imprest_funds f on f.id = d.fund_id and f.is_active
      join public.imprest_disbursement_handouts h on h.disbursement_id = d.id
     where d.status::text in ('handed_out', 'settled', 'sent_back', 'verified')
       and (v_role = 'manager' or d.proposed_by = v_actor)), '[]'::jsonb);
end;
$$;

comment on function api.staff_imprest_receipt_payment_options() is
  'The disbursements a stock receipt can be marked paid from (issue #73): the active fund''s that '
  'were handed out, settled, sent back or verified, newest first. The Manager sees all '
  'and a Cashier their own.';

-- The disbursement of each receipt, for the receipts the caller can read (who entered it, the
-- Manager and Directors).
create or replace function api.staff_stock_receipt_imprest_links(p_receipt_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.acting_staff(
                    array['director', 'manager', 'cashier', 'sales_rep']::public.app_role[]);
  v_role  public.app_role := private.live_role_of(v_actor);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'receipt_id', l.receipt_id, 'linked_by', p.full_name, 'linked_role', l.linked_role,
             'linked_at', l.linked_at,
             'disbursement', private.stock_receipt_disbursement_summary(l.disbursement_id))
             order by l.linked_at desc, l.receipt_id)
      from public.stock_receipt_imprest_links l
      join public.stock_receipts r on r.id = l.receipt_id
      join public.profiles p on p.id = l.linked_by
     where l.receipt_id = any (p_receipt_ids)
       and (v_role in ('director', 'manager') or r.entered_by = v_actor)), '[]'::jsonb);
end;
$$;

comment on function api.staff_stock_receipt_imprest_links(uuid[]) is
  'For each named stock receipt the caller can read, the disbursement that paid for it and who '
  'linked it (issue #73). Directors, the Manager, and whoever entered the receipt.';

-- The receipts a disbursement paid for, for whoever can read the disbursement (the Manager,
-- Directors, and the Cashier who proposed it). Null when it cannot be read.
create or replace function api.staff_imprest_disbursement_stock_receipts(p_disbursement_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.acting_staff(array['director', 'manager', 'cashier']::public.app_role[]);
  v_role  public.app_role := private.live_role_of(v_actor);
begin
  if not exists (select 1 from public.imprest_disbursements d
                  where d.id = p_disbursement_id
                    and (v_role in ('director', 'manager') or d.proposed_by = v_actor)) then
    return null;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'receipt_id', r.id, 'supplier', s.name, 'delivery_note_ref', r.delivery_note_ref,
             'delivery_date', r.delivery_date, 'location_code', r.location_code,
             'entered_by', p.full_name, 'entered_role', r.entered_role, 'linked_at', l.linked_at,
             'approval_status', coalesce(a.status::text, 'pending'))
             order by l.linked_at desc, r.id)
      from public.stock_receipt_imprest_links l
      join public.stock_receipts r on r.id = l.receipt_id
      join public.suppliers s on s.id = r.supplier_id
      join public.profiles p on p.id = r.entered_by
      left join public.approval_requests a
             on a.entity_type = 'stock_receipt' and a.entity_id = r.id
     where l.disbursement_id = p_disbursement_id), '[]'::jsonb);
end;
$$;

comment on function api.staff_imprest_disbursement_stock_receipts(uuid) is
  'The stock receipts a disbursement paid for, newest first, with supplier, delivery note, date, '
  'location, who entered each and whether the Manager approved it (issue #73). Directors, the '
  'Manager, and the Cashier who proposed the disbursement; null for anyone else.';

-- ---------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature, n.nspname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'api'
            and p.proname in ('staff_enter_stock_receipt', 'staff_imprest_receipt_payment_options',
                              'staff_stock_receipt_imprest_links',
                              'staff_imprest_disbursement_stock_receipts'))
        or (n.nspname = 'private'
            and p.proname in ('check_stock_receipt_imprest_link',
                              'stock_receipt_disbursement_summary',
                              'impl_staff_enter_stock_receipt', 'stock_receipt_entry_result'))
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
