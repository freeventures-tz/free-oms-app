-- Stage 8B corrective · A claimed stage for cross-system commands
--
-- Deliberately alone in its own migration and NOT wrapped in an explicit transaction: PostgreSQL
-- refuses to use a new enum value in the same transaction that adds it, and the migration that
-- follows uses this one immediately.
--
-- `auth_pending` is the missing state. Without it a command sat in `db_applied` while a worker was
-- part-way through the Supabase Auth call, so a second worker — or a replay of the same idempotency
-- key — saw it as untouched work and did the whole thing again.

alter type public.admin_command_stage add value if not exists 'auth_pending' after 'db_applied';
