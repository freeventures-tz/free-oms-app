-- Stage 11 · The shared machinery every order command is built from
--
-- Row-level security, grants and policies are NOT here. Each sales table carries its own in
-- 20260822000500, the migration that creates it, so a table is never exposed by one file and
-- protected by another and no reader has to join two migrations to answer who may read or write it.
--
-- What is here is the machinery those commands share: the business date, the daily document
-- counter, the order arithmetic, proforma issuance and line validation. Each is `security definer`,
-- owned by `fv_definer_owner`, with an empty `search_path`, and executable by nobody outside the
-- commands in 20260822000700.
--
-- WHO MAY DO WHAT, and where each rule comes from:
--
--   | Operation                | Who            | Source |
--   | Create an order          | Sales Rep, Manager, Director | §12.6 step 1; design.md §4.2 gives "Create New Order" to those three |
--   | Revise a proforma        | the same three | §12.6 step 3 |
--   | Request a discount       | the same three | §4 makes it a request; §4.1 makes it an approval |
--   | Approve a discount ≤ 5% on an order above TZS 1,000,000 | Manager | §4 |
--   | Approve any other discount | Director     | §4: "anything beyond these limits" |
--   | Record customer confirmation | Sales Rep, Manager, Director | §12.6 step 4 |
--   | Cancel an order          | the same three | §4.3 makes cancellation a decision, not an approval |

begin;

-- ---------------------------------------------------------------------------
-- Three exposures on tables this release did not create, so they stay out of
-- 20260822000500, whose rule is that a table carries its access decision beside itself.
--
-- Part B granted `product_current_prices` to `authenticated` and overlooked the definer owner,
-- because no command had yet needed to read a price. Order creation does, and without this every
-- order fails with "permission denied for view product_current_prices" — which a pgTAP run found
-- on the first attempt and no amount of reading the migration would have.
-- ---------------------------------------------------------------------------
grant select on public.product_current_prices to fv_definer_owner;

-- A Sales Representative must be able to see that an order is WAITING ON A DECISION, including one
-- somebody else asked for.
--
-- Stage 8A's `approval_requests_select` admits a Cashier, a Manager and a Director to everything,
-- and everyone else only to the rows they raised themselves. That is right for a stock adjustment
-- or an imprest expense. It is wrong for a discount on an order, because §12.6 lets ANY of the three
-- order roles confirm ANY order: a second Sales Representative saw no pending discount, was offered
-- an enabled Confirm button, and was refused by `staff_confirm_order` with `discount_pending` after
-- pressing it. The database was right and the screen was lying about what it knew.
--
-- The Stage 8A rule is REPLACED rather than joined by a second policy. Two permissive policies for
-- one role and one action is a finding the advisors block on, and PostgreSQL would OR them anyway —
-- so the disjunction is written where a reader can see the whole rule at once. This is the same
-- move 20260812001400 made when it replaced `approval_requests_select_own` and `_deciders`.
--
-- The new clause is scoped by both columns: `sales_rep` only, order discounts only. A Sales
-- Representative gains nothing on stock adjustments, payment reversals, accountability or imprest,
-- and gains no approval DECISION history either — `approval_decisions` still admits a Cashier, a
-- Manager and a Director alone. What they gain is exactly the pending state of an order they may
-- already read in full and are allowed to act on.
drop policy approval_requests_select on public.approval_requests;

create policy approval_requests_select on public.approval_requests
  for select to authenticated
  using (
    requested_by = (select private.request_uid())
    or (select private.authorize(array['cashier','manager','director']::public.app_role[]))
    or (
      entity_type = 'order'
      and approval_type = 'discount'
      and (select private.authorize(array['sales_rep']::public.app_role[]))
    )
  );

-- ---------------------------------------------------------------------------
-- api.staff_order_creator_name — the ONE name an order screen needs, and nothing else
--
-- design.md §7.3 puts "who wrote this order" on the order, and §4.2 lets every live role read every
-- order. `profiles` admits a Manager and a Director and otherwise only your own row — correctly,
-- because it holds the phone number somebody signs in with, the first-login gate and the active
-- flag. So a Cashier or a second Sales Representative opening a colleague's order got a null join
-- and the screen read "Created by  (Sales Representative)": a sentence with a hole where a person
-- should be.
--
-- Widening `profiles` was not an option, and neither was a column-limited grant: the same
-- `authenticated` role is what a Director reads phone numbers with on the accounts screen, so
-- narrowing the columns there would take the accounts screen with it.
--
-- A VIEW was the obvious shape and is the wrong one here. It would have to be
-- `security_invoker = false` to see past the caller's own policies, and all three views in this
-- schema are `security_invoker = true` on purpose — a view is never a way around RLS. Bounding a
-- definer view to `fv_definer_owner` is also impossible: that role holds `usage, create` on
-- `private` alone and owns nothing in an exposed schema, which is a property worth keeping.
--
-- So it is a function, the shape this database already uses for a deliberate, bounded bypass:
-- SECURITY DEFINER, owned by `fv_definer_owner` (`select` on `profiles` and `orders`, nothing
-- more), empty `search_path`, schema-qualified. It returns ONE column for ONE order — the display
-- name — and nothing for a caller who is not a live Director, Manager, Cashier or Sales
-- Representative. There is no phone number, no role assignment, no active flag, no first-login
-- state, no row for anybody who has not created an order, and no way to ask it for a staff list.
--
-- Ownership and the `authenticated` grant come from the prefix rule at the end of 20260822000700,
-- which runs over the whole `api` schema: `staff_` means granted to `authenticated` and refused
-- inside unless the caller holds a live role.
-- ---------------------------------------------------------------------------
create or replace function api.staff_order_creator_name(p_order_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.full_name
    from public.orders o
    join public.profiles p on p.id = o.created_by
   where o.id = p_order_id
     and (select private.authorize(
            array['director','manager','cashier','sales_rep']::public.app_role[]));
$$;

comment on function api.staff_order_creator_name(uuid) is
  'The display name of whoever created one order, for the live roles allowed to read that order '
  '(design.md §7.3, §4.2). One value and no more: `profiles` itself stays closed, because it holds '
  'the phone number an account signs in with.';

-- ---------------------------------------------------------------------------
-- private.business_date — the Tanzania business day (product.md §15.3)
--
-- One definition, used by invoice numbering, by the delivery-date check in Stage 10D's receiving
-- command, and by everything that follows. `00:00:00`–`23:59:59` in `Africa/Dar_es_Salaam`,
-- whatever zone the server happens to run in.
-- ---------------------------------------------------------------------------
create or replace function private.business_date()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Africa/Dar_es_Salaam')::date;
$$;

comment on function private.business_date() is
  'Today, in Africa/Dar_es_Salaam (product.md §15.3). The business day is not the server''s day, '
  'and every daily number, report and reconciliation uses this one.';

alter function private.business_date() owner to fv_definer_owner;
revoke execute on function private.business_date() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.next_document_number — `FV-INV-YYYYMMDD-####` and its siblings (§12.2)
--
-- The counter is claimed with one statement, so there is no read-then-write window for two
-- transactions to pass through together. `on conflict do update` takes a row lock, so the second
-- caller waits for the first to commit and then reads the value it left.
-- ---------------------------------------------------------------------------
create or replace function private.next_document_number(p_kind text, p_prefix text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_date  date := private.business_date();
  v_value integer;
begin
  insert into public.document_sequences (kind, business_date, next_value)
  values (p_kind, v_date, 1)
  on conflict (kind, business_date)
    do update set next_value = public.document_sequences.next_value + 1
  returning next_value into v_value;

  -- Four digits as §12.2 writes it. A day that somehow issues more than 9 999 documents produces a
  -- five-digit tail rather than a collision — the number stays unique, which is the rule that
  -- matters, and `lpad` simply stops padding.
  return p_prefix || '-' || to_char(v_date, 'YYYYMMDD') || '-' || lpad(v_value::text, 4, '0');
end;
$$;

comment on function private.next_document_number(text, text) is
  'The next daily document number (product.md §12.2), on the Africa/Dar_es_Salaam business date. '
  'Never reused: the counter only ever increases, and every number column is unique besides.';

alter function private.next_document_number(text, text) owner to fv_definer_owner;
revoke execute on function private.next_document_number(text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.order_totals — the arithmetic, in ONE place
--
-- §5.2 lists line totals, subtotal and discount among the values a user must never be asked to
-- type. Three commands need them — create, revise, confirm — and three copies of this sum is three
-- chances for a proforma and the invoice it becomes to disagree about what the customer owes.
--
-- Money is whole shillings (architecture.md §5.12) and the rounding rule is stated once: `round()`
-- on numeric rounds half away from zero, and every amount here is positive, so it is half-up.
-- ---------------------------------------------------------------------------
create or replace function private.order_totals(p_order_id uuid)
returns table (subtotal_tzs bigint, discount_tzs bigint, total_tzs bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select coalesce(sum(l.line_total_tzs), 0)::bigint as subtotal
      from public.order_lines l
     where l.order_id = p_order_id
  ),
  pct as (
    select o.discount_percent from public.orders o where o.id = p_order_id
  )
  select lines.subtotal,
         round(lines.subtotal * pct.discount_percent / 100)::bigint,
         (lines.subtotal - round(lines.subtotal * pct.discount_percent / 100))::bigint
    from lines, pct;
$$;

comment on function private.order_totals(uuid) is
  'Subtotal, discount and total for an order, calculated and never stored as a typed figure '
  '(product.md §5.2). Whole shillings, rounded half-up, in one place so a proforma and its invoice '
  'cannot disagree.';

alter function private.order_totals(uuid) owner to fv_definer_owner;
revoke execute on function private.order_totals(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.issue_proforma — one version, snapshotted
--
-- Called by creation and by revision, so a first proforma and a fourth are built the same way.
-- ---------------------------------------------------------------------------
-- `p_proforma_id` is supplied by the caller rather than generated here, and that is not a style
-- choice. A command has to CLAIM its idempotency key with the id of the thing it is about to
-- create, in one statement — the pattern migration 20260814000200 established, so that one
-- statement decides the winner and records the result and there is no second update to forget. A
-- function that minted its own id would force the caller to claim the key with a placeholder and
-- patch it afterwards, which is exactly the two-step this system has been bitten by before
-- (memory.md §6, "a two-step operation needs its proof stored with the step that matters").
create or replace function private.issue_proforma(
  p_order_id    uuid,
  p_issued_by   uuid,
  p_proforma_id uuid
)
returns public.proformas
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version  integer;
  v_totals   record;
  v_proforma public.proformas%rowtype;
begin
  select coalesce(max(pr.version), 0) + 1 into v_version
    from public.proformas pr where pr.order_id = p_order_id;

  -- Nothing is overwritten (§12.1 point 4): the previous version is marked superseded and stays
  -- retrievable exactly as it was issued.
  update public.proformas
     set superseded_at = now()
   where order_id = p_order_id and superseded_at is null;

  select * into v_totals from private.order_totals(p_order_id);

  insert into public.proformas (
    id, order_id, version, proforma_no, subtotal_tzs, discount_tzs, total_tzs, valid_until, issued_by
  )
  values (
    p_proforma_id,
    p_order_id, v_version, private.next_document_number('proforma', 'FV-PRO'),
    v_totals.subtotal_tzs, v_totals.discount_tzs, v_totals.total_tzs,
    -- 30 calendar days (design.md §14.8), counted on the business day rather than the server's.
    private.business_date() + 30,
    p_issued_by
  )
  returning * into v_proforma;

  -- The lines AS THEY READ NOW, including the counting unit and what one holds (product.md §6).
  insert into public.proforma_lines (
    proforma_id, product_id, product_name, product_specification, unit_code, unit_content,
    quantity, unit_price_tzs
  )
  select v_proforma.id, l.product_id, p.name, p.specification, p.unit_code, p.unit_content,
         l.quantity, l.unit_price_tzs
    from public.order_lines l
    join public.products p on p.id = l.product_id
   where l.order_id = p_order_id
   order by p.name;

  return v_proforma;
end;
$$;

comment on function private.issue_proforma(uuid, uuid, uuid) is
  'Issues the next proforma version for an order and supersedes the previous one (product.md '
  '§12.1). A quotation, not a bill: it creates no debt and reserves no stock.';

alter function private.issue_proforma(uuid, uuid, uuid) owner to fv_definer_owner;
revoke execute on function private.issue_proforma(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.parse_order_lines — the one validator for a submitted line set
--
-- Returns a refusal reason, or null when the lines are usable. Shared by creation and revision so
-- the two cannot drift apart about what a valid order looks like.
--
-- The price check is the one worth reading twice: a product with NO approved price cannot be sold.
-- product.md §4 makes a selling price a Director's decision, and quoting a customer a figure no
-- Director approved is precisely what Part B refused to seed a price to avoid.
-- ---------------------------------------------------------------------------
create or replace function private.check_order_lines(p_lines jsonb)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_line     jsonb;
  v_quantity numeric;
  v_distinct integer;
  v_total    integer;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return 'lines_required';
  end if;

  select count(distinct t.elem ->> 'product_id'), count(*)
    into v_distinct, v_total
    from jsonb_array_elements(p_lines) as t(elem);

  if v_distinct is distinct from v_total then
    return 'duplicate_product_line';
  end if;

  for v_line in select t.elem from jsonb_array_elements(p_lines) as t(elem) loop
    if jsonb_typeof(v_line -> 'product_id') <> 'string'
       or jsonb_typeof(v_line -> 'quantity') <> 'number' then
      return 'line_invalid';
    end if;

    if not exists (
      select 1 from public.products p
       where p.id = (v_line ->> 'product_id')::uuid and p.is_active
    ) then
      return 'no_product';
    end if;

    if not exists (
      select 1 from public.product_current_prices c
       where c.product_id = (v_line ->> 'product_id')::uuid
    ) then
      return 'product_has_no_price';
    end if;

    v_quantity := (v_line ->> 'quantity')::numeric;

    if v_quantity <> trunc(v_quantity) then
      return 'quantity_not_whole';
    end if;

    if v_quantity <= 0 or v_quantity > 10000000 then
      return 'quantity_invalid';
    end if;
  end loop;

  return null;
end;
$$;

comment on function private.check_order_lines(jsonb) is
  'Validates a submitted order line set, including that every product carries an approved selling '
  'price. Nothing may be quoted at a figure no Director approved (product.md §4).';

alter function private.check_order_lines(jsonb) owner to fv_definer_owner;
revoke execute on function private.check_order_lines(jsonb)
  from public, anon, authenticated, service_role;

commit;
