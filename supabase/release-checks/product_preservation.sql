-- Stage 10 Part C · The preservation query the release gate runs before and after migration 22
--
-- ONE source, run in three places and written out only here:
--
--   · the runbook copies this file into the hosted SQL Editor, before the migration and again
--     after it (`docs/runbooks/stage-10c-migration-first-release.md`, steps 2 and 4a);
--   · `npm run test:migration-chain` executes this same file against a local Part B database
--     before and after applying migration 22, in a fixture with prices and in one without.
--
-- A second, handwritten copy of this query in the runbook is how a release gate quietly stops
-- checking what it claims to check, so there is not one.
--
-- WHAT IT COMPARES, and what it deliberately leaves out.
--
-- `unit_code` and `unit_content` are EXCLUDED. The unit is the thing migration 22 rewrites;
-- comparing it would report every migrated product as a failure. Everything that remains must come
-- through the migration byte-identical:
--
--   · products      — id, name, specification. Price history and audit rows point at these ids.
--   · price rows    — id and the product each one was written for. A price a Director handed to a
--                     customer must still be readable, still attached to the same product.
--
-- `specification` is carried as JSON, so a product with no specification stays distinct from one
-- specified as the empty string. Folding them together with `coalesce(specification, '')` would let
-- a null become '' during a migration without changing the digest.
--
-- The digests hash an ORDERED JSONB ARRAY rather than concatenated text. Joining fields with a
-- delimiter lets 'a|b' and 'a' || '|b' collide, which is a way for two different databases to
-- produce one digest. An empty table aggregates to `[]`, which still hashes: with no prices at all,
-- `price_count` is 0 and `price_reference_digest` is the 32-character md5 of `[]`, not null.
-- A null digest compares equal to nothing, including itself, and would make the gate unreadable
-- exactly when the catalogue is empty.
--
-- Read-only. It selects and hashes; it writes nothing, locks nothing, and is safe against
-- production at any time.

with products_snapshot as (
  select
    count(*) as row_count,
    coalesce(
      jsonb_agg(
        jsonb_build_object('id', id, 'name', name, 'specification', specification)
        order by id
      ),
      '[]'::jsonb
    ) as rows
  from public.products
),
prices_snapshot as (
  select
    count(*) as row_count,
    coalesce(
      jsonb_agg(
        jsonb_build_object('id', id, 'product_id', product_id)
        order by id
      ),
      '[]'::jsonb
    ) as rows
  from public.product_prices
)
select
  (select row_count from products_snapshot)          as product_count,
  (select row_count from prices_snapshot)            as price_count,
  md5((select rows from products_snapshot)::text)    as product_identity_digest,
  md5((select rows from prices_snapshot)::text)      as price_reference_digest,
  (select rows from products_snapshot)::text         as product_rows,
  (select rows from prices_snapshot)::text           as price_rows;
