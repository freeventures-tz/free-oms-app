-- Issue #7 · One stock-availability rule for inventory, sales, production and release
--
-- THE DEFECT. Production consumption and negative stock corrections read the physical balance of
-- one location and nothing else. Stock a customer has already been promised is physically present,
-- so a batch could grind up goods that were sold, and the dispatch that followed found an empty
-- yard. product.md §8.1 says available stock is physical MINUS reserved and committed; until now
-- only the two sales commands obeyed it.
--
-- THE RULE, stated once here and reused everywhere below.
--
--   1. UNPROMISED STOCK. A command that takes stock OUT of the business must leave
--
--          available = physical − outstanding reserved − outstanding committed
--
--      at or above zero. Reservation, cash sale, production consumption and negative correction all
--      take stock out of the business, so all four ask the same question.
--
--   2. LOCATION STOCK. A command that names a location must ALSO find the quantity physically
--      there. This is a SEPARATE requirement with a separate refusal, because "the business owns
--      enough, but not here" and "the business does not own enough" are different problems and the
--      person reading the screen has to be told which one they have.
--
--   3. ONE LOCK ORDER. `stock:<product>` first, `<location>:<product>` second, products in
--      ascending id order. Both keys are the ones that were already in use, so a command that
--      adopts the helpers still serialises against one that has not.
--
--      What was missing was not the keys but the FIRST one: inventory and production took only
--      `<location>:<product>` while sales took only `stock:<product>`, so a reservation and a batch
--      approval never met. Production and corrections now take both, in that order.
--
--      AN ORDER, NOT A REQUIREMENT TO TAKE BOTH. Reservation and the walk-in sale take the product
--      key alone, because an order names no location. Release takes the location key alone. The
--      scope paragraph below says which command takes which, and why each of those is sufficient.
--
--   4. A REFUSAL IS RECORDED. A refusal returns rather than raises, so its transaction COMMITS —
--      which is what makes it auditable, and architecture.md §14.2 says it is audited. It was not.
--      Every inventory and production command now records one, from a single wrapper each, so a
--      refusal added next year is audited without anybody remembering to do it.
--
--   5. WHOLE COUNTING UNITS. Every quantity here is `bigint` and is a whole count of the product's
--      counting unit (product.md §6.1). Nothing in this file introduces a fractional quantity, and
--      the pgTAP suite asserts that no column in stock or production can hold one.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO. It does not touch invoice settlement, payment
-- reversal, order cancellation, imprest or reporting. It uses the existing sales availability
-- calculation — `public.product_availability` — as its input contract rather than replacing it.
--
-- SCOPE, BY OWNER DECISION. The commands re-issued in 20260823000200 are the inventory and
-- production ones this ticket owns. `api.staff_confirm_order`, `api.staff_take_cash_payment` and
-- `api.staff_confirm_release` make the same claims on the same stock and the helpers below are
-- written for them, but Stage 12B re-issues every sales and settlement command and two migrations
-- rewriting one function would leave whichever landed second silently reverting the other.
--
-- The wait costs nothing today, but be exact about WHY, because the loose version of this sentence
-- is wrong. The three do not take the same locks as each other:
--
--   · `staff_confirm_order` and `staff_take_cash_payment` take `stock:<product>` — the key
--     `lock_product_stock` reproduces — so they already serialise with production and corrections.
--
--   · `staff_confirm_release` takes ONLY `<location>:<product>`. It never took the product key.
--     That is sufficient, and not by luck: a release does not change available stock. The ledger
--     falls by what left and the claim that covered it falls with it, so the §8.1 figure is
--     unmoved and there is nothing for the product lock to protect. What release must not race is
--     another command emptying the same PLACE, and the location key it shares with transfers,
--     batches and corrections is exactly that guarantee.
--
-- So what Stage 12B gains by adopting the helpers is the richer refusal payload and one place to
-- read the rule. It is not a correctness fix for any of the three.

begin;

-- ---------------------------------------------------------------------------
-- The two lock keys, written once
--
-- BOTH KEYS ARE THE KEYS THAT WERE ALREADY THERE, character for character, and that is the point.
-- `stock:<product>` is what `api.staff_confirm_order` and `api.staff_take_cash_payment` take;
-- `<location>:<product>` is what transfers, corrections, batches and release took. Three of those
-- six commands are out of this ticket's scope and still hold their key inline, so a "tidier" key
-- here would mean the commands that adopted the helper stopped serialising against the commands
-- that had not — inventing the exact race this ticket exists to close.
--
-- `<location>:<product>` is a weak key: it is a location code and a uuid hashed together with
-- nothing to say what they mean. Renaming it is a change worth making ONCE, when the last inline
-- caller adopts the helper, and not before.
-- ---------------------------------------------------------------------------
create or replace function private.lock_product_stock(p_product_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(pg_catalog.hashtextextended('stock:' || p_product_id::text, 0));
$$;

comment on function private.lock_product_stock(uuid) is
  'Serialises every command that changes how much of one product the business can promise: a '
  'reservation, the walk-in sale, a batch and a downward correction. Taken BEFORE any location '
  'lock, and in ascending product order, so those cannot deadlock or overtake one another. A '
  'release does not take this key and does not need it: it moves no availability.';

alter function private.lock_product_stock(uuid) owner to fv_definer_owner;
revoke execute on function private.lock_product_stock(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.lock_location_stock(p_product_id uuid, p_location_code text)
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_location_code || ':' || p_product_id::text, 0));
$$;

comment on function private.lock_location_stock(uuid, text) is
  'Serialises every command that changes what one place physically holds. Taken AFTER '
  'private.lock_product_stock by any command that takes both keys; a release takes this key on its '
  'own. The key is unchanged from the one transfers, corrections, batches and release have always '
  'taken, because release still takes it inline.';

alter function private.lock_location_stock(uuid, text) owner to fv_definer_owner;
revoke execute on function private.lock_location_stock(uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.stock_position — the three numbers a refusal has to be able to quote
--
-- Read from `public.product_availability`, which is product.md §8.1 as a view and is already what
-- sales decides on. One calculation, not a second one that could drift from it.
-- ---------------------------------------------------------------------------
create or replace function private.stock_position(p_product_id uuid)
returns table (physical bigint, promised bigint, available bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(a.physical_quantity, 0)::bigint,
         (coalesce(a.reserved_quantity, 0) + coalesce(a.committed_quantity, 0))::bigint,
         coalesce(a.available_quantity, 0)::bigint
    from public.product_availability a
   where a.product_id = p_product_id
   union all
  select 0::bigint, 0::bigint, 0::bigint
   where not exists (select 1 from public.product_availability a
                      where a.product_id = p_product_id)
   limit 1;
$$;

comment on function private.stock_position(uuid) is
  'Physical, promised and available for one product, from the §8.1 view. A refusal that quotes all '
  'three can be explained to a person; one that quotes only "not enough" cannot.';

alter function private.stock_position(uuid) owner to fv_definer_owner;
revoke execute on function private.stock_position(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The three claims a command can make on stock
--
-- Each takes the lock or locks ITS OWN question needs — the product key, the location key, or both
-- in the documented order — and then answers that question. They return NULL when the quantity may
-- be taken and a refusal object when it may not, so the caller writes
--
--     v_refusal := private.claim_stock_for_withdrawal(...);
--     if v_refusal is not null then return v_refusal; end if;
--
-- and cannot check the balance without also holding the lock that keeps the answer true.
-- ---------------------------------------------------------------------------

-- The business-wide question. No location, because an order names a product and the place it leaves
-- from is decided at dispatch (§14).
--
-- Called today by `private.claim_stock_for_withdrawal` below, which is how production and negative
-- corrections ask it. It is also exactly what `api.staff_confirm_order` and
-- `api.staff_take_cash_payment` do inline, on this same lock key — Stage 12B replaces their inline
-- copy with this call when it re-issues them.
create or replace function private.claim_unpromised_stock(
  p_product_id uuid,
  p_quantity   bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pos record;
begin
  perform private.lock_product_stock(p_product_id);

  select * into v_pos from private.stock_position(p_product_id);

  if v_pos.available >= p_quantity then
    return null;
  end if;

  return jsonb_build_object(
    'ok', false, 'reason', 'insufficient_stock',
    'product_id', p_product_id,
    'physical', v_pos.physical, 'promised', v_pos.promised,
    'available', v_pos.available, 'requested', p_quantity);
end;
$$;

comment on function private.claim_unpromised_stock(uuid, bigint) is
  'May this much of the product be promised or consumed? Physical minus reserved and committed '
  '(product.md §8.1). Returns NULL when it may, and the refusal object when it may not.';

alter function private.claim_unpromised_stock(uuid, bigint) owner to fv_definer_owner;
revoke execute on function private.claim_unpromised_stock(uuid, bigint)
  from public, anon, authenticated, service_role;

-- Production consumption and negative corrections. BOTH questions, in this order: the business
-- first, because "these bags are sold" is the more important answer, then the place.
create or replace function private.claim_stock_for_withdrawal(
  p_product_id    uuid,
  p_location_code text,
  p_quantity      bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refusal jsonb;
  v_here    bigint;
begin
  v_refusal := private.claim_unpromised_stock(p_product_id, p_quantity);
  if v_refusal is not null then
    return v_refusal;
  end if;

  perform private.lock_location_stock(p_product_id, p_location_code);

  v_here := private.stock_on_hand(p_product_id, p_location_code, 'available');

  if v_here >= p_quantity then
    return null;
  end if;

  return jsonb_build_object(
    'ok', false, 'reason', 'insufficient_stock_at_location',
    'product_id', p_product_id, 'location', p_location_code,
    'available', v_here, 'requested', p_quantity);
end;
$$;

comment on function private.claim_stock_for_withdrawal(uuid, text, bigint) is
  'May this much be taken out of the business FROM this place? Two separate requirements with two '
  'separate refusals: the business must still own it unpromised, and the place must physically '
  'hold it. Used by production consumption and by negative stock corrections.';

alter function private.claim_stock_for_withdrawal(uuid, text, bigint) owner to fv_definer_owner;
revoke execute on function private.claim_stock_for_withdrawal(uuid, text, bigint)
  from public, anon, authenticated, service_role;

-- Internal transfers, and the release of goods already claimed. Neither reduces what the business
-- owns unpromised — a transfer moves it, and a release discharges a claim that was already
-- subtracted — so the location question is the only one there is. This HELPER still takes the
-- product lock first, so a transfer serialises with production and corrections rather than racing
-- them.
--
-- Called today by `api.staff_approve_stock_transfer`, and by nothing else.
-- `api.staff_confirm_release` asks the same question with its own inline copy, and while it does so
-- it takes ONLY `<location>:<product>`. That is sufficient: a release moves no availability,
-- because the ledger falls by what left and the claim that covered it falls with it. Adopting this
-- call in Stage 12B would ADD the product lock to release; it would not correct it.
create or replace function private.claim_location_stock(
  p_product_id    uuid,
  p_location_code text,
  p_quantity      bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_here bigint;
begin
  perform private.lock_product_stock(p_product_id);
  perform private.lock_location_stock(p_product_id, p_location_code);

  v_here := private.stock_on_hand(p_product_id, p_location_code, 'available');

  if v_here >= p_quantity then
    return null;
  end if;

  return jsonb_build_object(
    'ok', false, 'reason', 'insufficient_stock_at_location',
    'product_id', p_product_id, 'location', p_location_code,
    'available', v_here, 'requested', p_quantity);
end;
$$;

comment on function private.claim_location_stock(uuid, text, bigint) is
  'Does this place physically hold the quantity? For movements that do not reduce what the business '
  'owns unpromised: an internal transfer, and the release of goods already committed to a customer.';

alter function private.claim_location_stock(uuid, text, bigint) owner to fv_definer_owner;
revoke execute on function private.claim_location_stock(uuid, text, bigint)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.refuse — architecture.md §14.2, finally implemented
--
-- "The function returns a typed failure rather than raising, so the transaction COMMITS the refusal
-- audit row." The returning was built; the row was not. A refused attempt to consume eighty bags
-- that somebody had been promised is exactly the event an owner would want to find later, and it
-- left no trace at all.
--
-- IT RETURNS ITS ARGUMENT, which is what makes instrumenting a refusal a one-line change:
--
--     return private.refuse('inventory.approve_transfer', 'stock_transfer', p_id, v_result);
--
-- SHARED WITH STAGE 12B, deliberately and byte-for-byte in behaviour. That ticket instruments the
-- sales and settlement commands the same way, and two helpers doing one job would give the audit
-- trail two shapes. Both migrations define this function identically, so neither depends on the
-- other's merge order: whichever applies second replaces it with the same behaviour. If the two
-- ever have to differ, they must stop sharing the name in the same change.
--
-- A REPLAY IS NOT A REFUSAL and is not recorded: it carries `ok: true`, and the operation it
-- replays was audited when it committed. An authority failure is not one either — those RAISE, the
-- transaction rolls back, and nothing may claim to have audited it (§14.2, second row).
-- ---------------------------------------------------------------------------
create or replace function private.refuse(
  p_operation   text,
  p_entity_type text,
  p_entity_id   uuid,
  p_result      jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.request_uid();
  v_role  public.app_role;
begin
  -- Defensive, and unreachable through the api surface: every command resolves its actor through
  -- `acting_staff` or `acting_director` first, and both RAISE without a session, so a soft refusal
  -- with no actor cannot arise. If one ever did, there would be nobody to attribute it to, and
  -- inventing a system actor would be a lie about who tried.
  if v_actor is null then
    return p_result;
  end if;

  v_role := private.live_role_of(v_actor);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'command_refused', p_entity_type, p_entity_id,
    null,
    jsonb_build_object('outcome', 'refused',
                       'reason', coalesce(p_result ->> 'reason', 'generic'))
      -- The numbers travel with the reason, so the trail says "twenty available, eighty promised,
      -- fifty asked for" rather than merely "refused".
      || (p_result - 'ok' - 'reason'),
    -- A FRESH correlation id, which looks wrong and is not.
    --
    -- A correlation id threads the rows of one operation together. A refused command wrote nothing
    -- else — it returned before its ledger movement, its approval decision and its success audit
    -- row — so this row is the whole of what there is to thread, and the command's own internal
    -- `v_corr` never reached anything either. Taking it would join this row to nothing more than a
    -- fresh id does, and the api functions accept no caller-supplied correlation id to inherit.
    --
    -- If the trail ever needs a refused attempt joined to the retry that succeeded, the thing to
    -- carry is the IDEMPOTENCY KEY, not this. That is a change to a contract Stage 12B has already
    -- adopted, so it belongs to the owner rather than to this migration.
    gen_random_uuid(), p_operation
  );

  return p_result;
end;
$$;

comment on function private.refuse(text, text, uuid, jsonb) is
  'Records the committed refusal architecture.md §14.2 requires — actor, live role, operation, '
  'reason, entity, timestamp and correlation id — and returns the refusal unchanged. Shared with '
  'Stage 12B so the audit trail has one shape for every refused command.';

alter function private.refuse(text, text, uuid, jsonb) owner to fv_definer_owner;
revoke execute on function private.refuse(text, text, uuid, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Availability cannot go below zero, and this is where that is decided
--
-- `private.refuse_negative_stock` already stops a LOCATION holding less than nothing. It cannot see
-- a promise, so it would happily let a batch consume goods that were sold. This is its twin for
-- product.md §8.1, and it exists for the same stated reason: the checks above are checks each
-- command has to REMEMBER, and there will be more commands.
--
-- Deferred to commit, so a movement that is only sound as a whole — a release writes a negative
-- ledger row AND discharges the claim that covered it — is judged by its whole effect.
--
-- WHAT IT IS NOT. It is not a substitute for the advisory locks, and it must not be described as
-- one. It reads committed rows under READ COMMITTED, so two transactions running at the same moment
-- can each compute availability without seeing the other's uncommitted effect, and both can pass.
-- What it does catch is a command that takes the locks and then forgets to ask — a new one written
-- next year, or an arithmetic slip in an old one — and any single-transaction mistake. Serialising
-- the callers is the locks' job and only the locks' job.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER, and that is not decoration.
--
-- A DEFERRED constraint trigger fires at COMMIT, which is outside the `security definer` command
-- that queued it. By then `current_user` is back to `authenticated` — the signed-in person — and
-- `inventory_ledger` grants SELECT to a Director or a Manager and nobody else
-- (inventory_ledger_select_oversight). A Sales Representative confirming an order therefore saw an
-- EMPTY ledger: physical summed to zero, availability came out as minus the order, and a perfectly
-- good order was refused. The first integration run over real HTTP found it; no pgTAP test could
-- have, because pgTAP runs as the table owner and the owner bypasses RLS.
--
-- As definer the function runs as `fv_definer_owner`, which holds the `..._definer_owner_read`
-- policies on both tables and sees the whole picture. `public.product_availability` is
-- `security_invoker`, so it too resolves against that role — which is why this reads the §8.1 view
-- rather than keeping a second copy of the subtraction that could drift from it.
create or replace function private.refuse_negative_availability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_available bigint;
begin
  select a.available_quantity into v_available
    from public.product_availability a
   where a.product_id = new.product_id;

  if coalesce(v_available, 0) < 0 then
    raise exception
      'product % would have % available, and the business cannot promise stock it does not have',
      new.product_id, v_available
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

comment on function private.refuse_negative_availability() is
  'product.md §8.1 as a constraint: physical minus reserved and committed can never be negative. '
  'Refuses for every role including the definer owner, so no future command can consume promised '
  'stock by forgetting to ask.';

alter function private.refuse_negative_availability() owner to fv_definer_owner;

-- Not optional, and not covered by the loops in 20260823000200: a function created without an
-- explicit REVOKE keeps PostgreSQL's default, in which PUBLIC holds EXECUTE. pgTAP 003 asserts that
-- no function in `api` or `private` does, and this one is a trigger function nobody should be able
-- to call directly whatever else is true.
revoke execute on function private.refuse_negative_availability()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The SAME hole, in the guard Stage 10D already shipped
--
-- `private.refuse_negative_stock` is deferred and was not `security definer` either, so at commit it
-- reads `inventory_ledger` as `authenticated` and sees only what that person may see. For a Director
-- or a Manager that is everything and the guard works; for a Cashier or a Sales Representative it is
-- nothing, the balance sums to zero, and "a location cannot hold less than nothing" silently passes.
--
-- Latent rather than live today: every command that writes a ledger row is a Manager's or a
-- Director's, so the guard has always run with sight of the table. It is one word to close and the
-- next command written for a Cashier would have inherited a guard that does nothing.
--
-- The body below is Stage 10D's, unchanged. `security definer` is the whole of the difference.
create or replace function private.refuse_negative_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
begin
  select coalesce(sum(l.quantity_delta), 0) into v_balance
    from public.inventory_ledger l
   where l.product_id    = new.product_id
     and l.location_code = new.location_code
     and l.stock_state   = new.stock_state;

  if v_balance < 0 then
    raise exception
      'stock at % for product % in state % would fall to %, and a location cannot hold less than '
      'nothing', new.location_code, new.product_id, new.stock_state, v_balance
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

alter function private.refuse_negative_stock() owner to fv_definer_owner;
revoke execute on function private.refuse_negative_stock()
  from public, anon, authenticated, service_role;

create constraint trigger inventory_ledger_no_negative_availability
  after insert on public.inventory_ledger
  deferrable initially deferred
  for each row execute function private.refuse_negative_availability();

create constraint trigger stock_allocations_no_negative_availability
  after insert or update on public.stock_allocations
  deferrable initially deferred
  for each row execute function private.refuse_negative_availability();

commit;
