-- Stage 12 · The shared machinery every settlement command is built from
--
-- Row-level security, grants and policies are NOT here. Each payment, credit, storekeeper and
-- dispatch table carries its own in 20260822000800, the migration that creates it, exactly as
-- every sales table does in 20260822000500. A table is never exposed by one file and protected by
-- another, and no reader has to join two migrations to answer who may read or write it.
--
-- What is here is the machinery those commands share: the calculated settlement state of one
-- invoice, the Manager credit limit of §4, and the generated storekeeper code of §3.2. Each is
-- owned by `fv_definer_owner`, with an empty `search_path`, and executable by nobody outside the
-- commands in 20260822001000.

begin;

-- ---------------------------------------------------------------------------
-- private.settlement_of — the calculated state of one invoice (product.md §12.3)
--
-- The view is for reading. This is for the moment a command must decide something, and it is
-- separate so the caller has already taken the advisory lock that keeps the answer true a line
-- later.
-- ---------------------------------------------------------------------------
create or replace function private.settlement_of(p_invoice_id uuid)
returns table (
  total_tzs           bigint,
  amount_paid_tzs     bigint,
  approved_credit_tzs bigint,
  outstanding_tzs     bigint,
  status              text,
  releasable          boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.total_tzs, s.amount_paid_tzs, s.approved_credit_tzs, s.outstanding_tzs,
         s.status, s.releasable
    from public.invoice_settlement s
   where s.invoice_id = p_invoice_id;
$$;

comment on function private.settlement_of(uuid) is
  'What one invoice is settled by, calculated from money received and approved credit '
  '(product.md §12.3). Never a stored status: AC-14 says a user may not choose one.';

alter function private.settlement_of(uuid) owner to fv_definer_owner;
revoke execute on function private.settlement_of(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.credit_needs_director — product.md §4, as one function
--
-- "Manager approval of unpaid balance: maximum TZS 500,000 per invoice. Anything beyond these
-- limits requires Director approval." AC-17 says the same from the other side.
--
-- Written once because it is asked twice — when the request is raised, to decide whose decision it
-- is, and when it is approved, to check the person approving holds that authority. A second copy is
-- how a stale `required_role` becomes a way around the limit, which is exactly the failure the
-- discount version of this function exists to prevent.
-- ---------------------------------------------------------------------------
create or replace function private.credit_needs_director(p_amount bigint)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_amount > 500000;
$$;

comment on function private.credit_needs_director(bigint) is
  'Whether an unpaid balance is beyond a Manager''s authority: above TZS 500,000 on one invoice '
  '(product.md §4, AC-17).';

alter function private.credit_needs_director(bigint) owner to fv_definer_owner;
revoke execute on function private.credit_needs_director(bigint)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.next_storekeeper_code — the generated code of §3.2
--
-- The server owns it, so there is nothing for a Director to mistype and nothing to aim at an
-- existing record. `SK-0001` upward, never reused.
-- ---------------------------------------------------------------------------
create or replace function private.next_storekeeper_code()
returns text
language sql
security definer
set search_path = ''
as $$
  select 'SK-' || lpad((
    select coalesce(max(substring(s.storekeeper_code from 4)::integer), 0) + 1
      from public.storekeepers s
     where s.storekeeper_code ~ '^SK-\d+$'
  )::text, 4, '0');
$$;

comment on function private.next_storekeeper_code() is
  'The generated storekeeper code of product.md §3.2. Server-owned: the Director supplies a name '
  'and nothing that could collide.';

alter function private.next_storekeeper_code() owner to fv_definer_owner;
revoke execute on function private.next_storekeeper_code()
  from public, anon, authenticated, service_role;

commit;
