# Changelog

Notable changes to Free Ventures OMS, written for the people who use it. Contributor and
infrastructure detail is kept in the second half of each release.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release milestones

| Version | What it means |
| --- | --- |
| **`0.0.1`** | The foundation is deployed: signing in, roles, account administration, a permanent record of who did what, and an installable phone app. **No business module.** |
| `0.1.0` | A complete, usable daily operating system — the V1 business workflows built and taken through an operational pilot. |
| `1.0.0` | Stable and comfortable in daily use, after measured improvements to usability, performance, reliability, training and pilot feedback. |

---

## [Unreleased]

Nothing yet. Stage 10 — catalogue, suppliers and inventory — is next.

---

## [0.0.1] — 2026-08-14

The first deployed release. Free Ventures can sign in and manage who has access; the business
workflows themselves are not built yet.

### What you can do now

- **Sign in with your phone number and a password.** No email address, no SMS, no one-time codes.
  The number is typed the way it is spoken locally — `0712 345 678`, `+255 712 345 678` or
  `255712345678` — and the screen shows the form it will be saved as while you type.
- **Choose your language before signing in.** English and Kiswahili throughout, and the choice
  follows you between devices.
- **Replace a temporary password on first use.** Until that is done, nothing else in the system is
  reachable. The rules are shown before you type and tick off as you meet them.
- **Land on your own home page.** Where you arrive after signing in depends on your role, and is
  decided by the server rather than the browser.
- **Install it on a phone.** Add it to the home screen and it opens without browser chrome, with the
  Free Ventures mark in the app drawer.

### What a Director can do

- Create a staff account and hand over a temporary password shown **exactly once**.
- Set a new password for someone who has lost theirs.
- Switch an account off, and back on again.
- Change someone's role, or the phone number they sign in with.
- Every one of those actions is recorded permanently, and the screen says so.

### What is not here yet

No products, stock, sales, payments, dispatch, brick production, imprest cash or reports.
`Orders`, `Payments & dispatch` and `Dashboard` are placeholders that say so.

There is also no offline mode, no multi-factor authentication and no public signup — each a
deliberate decision rather than an omission.

---

### For contributors

**Foundation** ([PR #1](https://github.com/freeventures-tz/free-oms-app/pull/1), `d874032`)

- 18 migrations · 9 tables, row-level security on every one, 16 policies · 20 `api` functions behind
  a restricted `NOLOGIN` definer owner.
- The Supabase secret key holds **no table privileges** in `public`. A leaked key cannot read
  profiles, cannot read the audit trail and cannot truncate a table.
- Phone-and-password sign-in via a derived, unroutable identifier, because Supabase Auth cannot do
  phone logins without an SMS provider and the product forbids SMS.
- Two-step sign-in whose first step makes no server call, so it cannot be used to discover whether a
  phone number has an account.
- Authentication screens rebuilt on the brand palette and lockup, with distinct typing, working,
  refusal and satisfied states. Motion is CSS and Tailwind only; no animation library ships.
- Installable as a PWA. The service worker **caches nothing** — staff share phones and a
  service-worker cache outlives sign-out.
- Cross-system operations carry an id, a single claim and an end state, so a repeated click resumes
  one job instead of issuing a second credential.
- Tests: 50 unit · 65 integration over real HTTP · 153 database assertions · 95 browser tests across
  phone, tablet and desktop.

**Stage 9 follow-ups** ([PR #2](https://github.com/freeventures-tz/free-oms-app/pull/2), `7b176bc`)

- The name shown beside a temporary password is now read from the database instead of being supplied
  by the browser. On the recovery path it was previously blank; sending the typed name would have
  been worse, because that path is reached when the number already belongs to **someone else**.
- `site_url` points at the deployed origin instead of `localhost`. Nothing uses it today — the
  application has no email, reset-link, magic-link, OTP or OAuth flow — but it would have become a
  defect the moment one was enabled.

**Deployment**

- Production: `https://free-oms.vercel.app`, deployed from `main`.
- All 18 migrations applied to the hosted Supabase project; Auth configuration pushed from
  `supabase/config.toml`, which is the single source of truth for it.
- Verified in production: public signup refused, the email provider left enabled, the first-login
  gate blocking, role routing correct, the secret key absent from the browser bundle, and a
  service-key read of `public.profiles` refused.

[Unreleased]: https://github.com/freeventures-tz/free-oms-app/compare/main...HEAD
