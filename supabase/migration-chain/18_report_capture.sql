-- What a report IS, in one line, computed identically on either side of the retry migration.
--
-- Run after the integrated success migration and again after the retry migration, and compared
-- character for character. Every column is something the approved key change did NOT cover —
-- content, its digest, its schema version, the integrity finding a Director reads, who the report
-- reached and how many reports are served — so a difference in any of them is the migration having
-- done something it was not permitted to do.
--
-- IT NAMES NO RETRY COLUMN. `attempt_ordinal` does not exist on the before side, so a capture that
-- mentioned it could only ever run afterwards and would compare nothing. What the retry migration
-- adds is asserted separately, in `20_report_after.sql`.
--
-- `md5(content::text)` BESIDE the stored digest, because the two answer different questions. The
-- stored `content_sha256` proves the trigger's stamp is unchanged; the md5 of the content itself
-- proves the CONTENT is unchanged, and a migration that rewrote both consistently would pass the
-- first check alone.
--
-- `xmin` AND `ctid` ARE THE PROOF THAT NO ROW WAS UPDATED (issue #51). The backfill must reach the
-- existing snapshot through the catalogue default and never through an UPDATE. An UPDATE — even one
-- that somehow got past the immutability trigger, or that ran with the trigger disabled — writes a
-- new tuple version with a new `xmin`, and a table rewrite moves `ctid`. Identical values on both
-- sides mean the stored row is the very tuple issue #18 wrote.
--
-- `integrity_ok` comes from `public.daily_reports`, which recomputes the digest from the content on
-- every read. That is the finding on the screen, so it is the one worth preserving.
select r.content_sha256
       || '|' || md5(r.content::text)
       || '|' || r.schema_version
       || '|' || v.integrity_ok
       || '|' || r.xmin::text
       || '|' || r.ctid::text
       || '|' || (select count(*) from public.report_deliveries d where d.snapshot_id = r.id)
       || '|' || (select coalesce(md5(string_agg(d.recipient_id::text || ':' || d.recipient_role::text
                                                 || ':' || d.delivered_at::text,
                                                 ',' order by d.recipient_id)), '-')
                    from public.report_deliveries d where d.snapshot_id = r.id)
       || '|' || (select count(*) from public.daily_reports)
       || '|' || (select count(*) from public.report_runs)
  from public.report_snapshots r
  join public.daily_reports v on v.snapshot_id = r.id
 order by r.business_date;
