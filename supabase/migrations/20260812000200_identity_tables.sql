-- Stage 8A · Identity: profiles, user_roles, provisioning jobs
--
-- profiles.is_active defaults FALSE and must_change_password defaults TRUE, so a
-- half-provisioned account is inert: it satisfies neither gate in private.authorize().

begin;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                     uuid primary key references auth.users (id) on delete restrict,
  full_name              text        not null check (length(btrim(full_name)) > 0),
  phone_e164             text        not null unique check (phone_e164 ~ '^\+255[0-9]{9}$'),
  locale                 text        not null default 'en' check (locale in ('en','sw')),
  is_active              boolean     not null default false,

  -- First-login gate (architecture.md §7.9a). Cleared ONLY by
  -- private.clear_first_login_gate, which is granted to service_role alone and
  -- called by the server after Supabase Auth confirms the password change.
  -- `authenticated` holds no grant on this column and no RPC that touches it.
  must_change_password   boolean     not null default true,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Exactly the predicate private.authorize() evaluates, so it can be index-assisted.
create index profiles_authorizable_idx
  on public.profiles (id)
  where is_active and not must_change_password;

create index profiles_active_idx on public.profiles (is_active);

-- ---------------------------------------------------------------------------
-- user_roles — exactly one active role per user (product.md §3.1)
-- ---------------------------------------------------------------------------
create table public.user_roles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references public.profiles (id) on delete restrict,
  role        public.app_role not null,
  assigned_by uuid references public.profiles (id),
  assigned_at timestamptz not null default now()
);

-- Covers the authorize() join and its role filter.
create index user_roles_user_role_idx on public.user_roles (user_id, role);
create index user_roles_role_idx      on public.user_roles (role);

-- ---------------------------------------------------------------------------
-- account_provisioning_jobs — idempotent, resumable cross-system creation
-- ---------------------------------------------------------------------------
create table public.account_provisioning_jobs (
  id                 uuid primary key default gen_random_uuid(),
  idempotency_key    text not null unique,
  requested_by       uuid references public.profiles (id),
  target_phone_e164  text not null check (target_phone_e164 ~ '^\+255[0-9]{9}$'),
  target_role        public.app_role not null,
  stage              public.provisioning_stage not null default 'pending',
  auth_user_id       uuid,
  profile_id         uuid references public.profiles (id),
  is_bootstrap       boolean not null default false,
  error_detail       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Resumability: once Auth succeeded we must retain the id to finish or disable it.
  constraint provisioning_stage_requires_auth_user
    check (stage in ('pending','failed') or auth_user_id is not null)
);

comment on table public.account_provisioning_jobs is
  'Cross-system account creation state. No password, temporary or otherwise, is ever stored here.';

-- At most one bootstrap job may be in flight or complete: the single-holder claim
-- for Director bootstrap (architecture.md §7.8).
create unique index provisioning_single_bootstrap_idx
  on public.account_provisioning_jobs ((true))
  where is_bootstrap and stage <> 'failed';

commit;
