# Free Ventures OMS

The office management system for **Free Ventures**, a construction-materials business in Tanzania.
It sells bricks, cement and sand, makes its own bricks, and moves stock between a store, a warehouse
and a yard.

Today that work runs on paper: order books, carbon-copy dispatch notes and a cash sheet. Paper means
nobody can say what stock is really there, money and goods can leave without a matching record, and
when something goes missing there is no reliable way to find out when or who agreed to it. This
system replaces those papers.

Built for **phones first**, because most staff use it in a yard rather than at a desk. It speaks
**English and everyday Tanzanian Swahili**.

---

## What `v0.0.1` actually does

This release is the **foundation**: who you are, what you may do, and a record of both. It is
deployed and in daily use by a Director.

- Sign in with a Tanzanian phone number and a password — no email, no SMS, no OTP.
- Replace a temporary password before anything else becomes reachable.
- Land on the home page for your role, decided by the server.
- Switch between English and Swahili, including before signing in.
- Install the app to a phone home screen and open it without browser chrome.
- **As a Director:** create a staff account, set a new password for someone, switch an account off
  and on, change a role, and change the phone number someone signs in with. Every one of those is
  recorded permanently.

## What is not built yet

**No business module exists.** There is no catalogue, no stock, no sales, no payments, no dispatch,
no brick production, no imprest cash and no reporting. `/orders`, `/payments` and `/dashboard` are
placeholders that say so on the screen.

Also absent, each deliberately: **no offline support** (see [`../docs/pwa.md`](../docs/pwa.md)), no
multi-factor authentication, and no public signup — the only way an account exists is that a
Director created it.

---

## Accounts and access

Four roles, **exactly one per person**: Director, Manager, Cashier, Sales Representative.

The phone number is the login identifier. Supabase Auth cannot do phone-and-password without an SMS
provider and the product forbids SMS, so the number is converted into a private, unroutable
identifier behind the scenes. Users never see it and never type anything but their phone number.

Two properties worth knowing when reading the code:

- **Permission is read from the database on every request, never from the token.** A role change or
  a deactivation takes effect immediately rather than at the next token refresh.
- **The sign-in screen never reveals whether an account exists.** One neutral failure message covers
  a wrong password, an unknown number, a deactivated account and a banned one. The first step of
  sign-in asks the server nothing at all, so the two-step flow cannot be used to probe for accounts.

Password recovery is Director-mediated. There is no self-service reset, and no delete control
anywhere — accounts are deactivated, never removed.

---

## Running it locally

Requires **Node 20+** and **Docker** (for the local Supabase stack).

```bash
npm install
npm run db:start          # starts local Supabase in Docker
npm run db:reset          # applies all migrations to a clean database
npm run dev
```

Then create the first Director, which is a one-time step per environment:

```bash
npm run bootstrap:director -- --name "Full Name" --phone "0712345678"
```

The temporary password prints **once** and is stored nowhere. See
[`../docs/runbooks/first-director-bootstrap.md`](../docs/runbooks/first-director-bootstrap.md).

### Environment variables

Copy `.env.example` to `.env.local` and fill it in there. `.env.local` is git-ignored.

| Name | Where it is used |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser and server |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser and server; row-level security still applies |
| `SUPABASE_SECRET_KEY` | **Server only.** Never give it a `NEXT_PUBLIC_` prefix |

`SUPABASE_SECRET_KEY` must be the `sb_secret_…` key. A legacy `service_role` JWT (starting `eyJ`) is
rejected at startup.

---

## Verifying a change

```bash
npm run verify            # lint · types · unit tests · production build
npm run test:db           # pgTAP, against a clean database reset
npm run db:lint           # schema linter
npm run db:advisors       # project-specific security rules
npm run test:integration  # real HTTP against the local Supabase stack
npm run test:e2e          # browser tests on phone, tablet and desktop
```

At `v0.0.1` these are **50 unit · 65 integration · 153 database assertions · 95 browser tests**
(one skipped by design: a 44px touch-target floor that does not apply to desktop).

CI runs the same commands against an ephemeral Supabase started per job, so a green run locally and
a green run in CI mean the same thing. **CI stores no Supabase key** — it reads them from the stack
it just started.

Integration and E2E tests **refuse to run** against anything but a local Supabase URL, because they
create users, reset passwords and deactivate accounts.

---

## How it is deployed

`main` deploys to Vercel automatically. Database changes are migrations applied with the Supabase
CLI; hosted Auth settings come from `supabase/config.toml` via `supabase config push`.

**`supabase/config.toml` is the single source of truth for hosted Auth settings.** Editing them in
the Supabase dashboard works until the next `config push` silently overwrites it. Change the file.

### Operational limits worth knowing

- **A merge is not authorized by green CI.** Branch protection is unavailable on this repository's
  plan, so the review gate is a manual rule — see [`../AGENTS.md`](../AGENTS.md).
- **The temporary password is shown exactly once**, at creation or reset, and is stored in no table,
  no job row and no log. If it is lost before the person signs in, a Director must issue a new one.
- **If both Directors are ever locked out there is no in-app escape hatch.** That is deliberate; an
  in-app recovery route would be an escalation path. Recovery is a project-owner procedure performed
  against Supabase directly.
- **A leaked `SUPABASE_SECRET_KEY` is still critical**, but its reach is narrowed: it holds no table
  privileges in `public`, so it cannot read profiles, cannot read the audit trail and cannot
  truncate a table. It can only call the named `api` functions, each of which checks live Director
  authority.

---

## Where the documentation lives

This repository holds only what the running application needs. Specifications, plans and design
decisions live in the workspace beside it:

| Subject | Document |
| --- | --- |
| Where the project stands, and what to do next | [`../docs/memory.md`](../docs/memory.md) |
| Product scope, users, workflows | [`../docs/product.md`](../docs/product.md) |
| Design language and UI rules | [`../docs/design.md`](../docs/design.md) |
| Architecture and integrations | [`../docs/architecture.md`](../docs/architecture.md) |
| Security controls that exist and are tested | [`../docs/security.md`](../docs/security.md) |
| Installing on a phone | [`../docs/pwa.md`](../docs/pwa.md) |
| Stage plans | [`../docs/plans/`](../docs/plans/) |

Release history is in [`CHANGELOG.md`](CHANGELOG.md).
