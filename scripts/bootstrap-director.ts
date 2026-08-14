/**
 * One-time bootstrap of the FIRST Director.
 *
 * This is a runbook step, run deliberately by an operator — NOT a migration. A committed migration
 * that inserts a privileged account runs wherever migrations run, including every local and CI
 * database, and re-runs on every fresh one. That is the wrong shape for creating the most
 * privileged account in the system (architecture.md §7.8).
 *
 *   npm run bootstrap:director -- --name "Full Name" --phone "0712345678"
 *
 * Properties, all enforced by the database rather than by this script:
 *   · Single claimant   one bootstrap job row exists for the lifetime of the database
 *   · Guarded           refuses if any Director already exists
 *   · Resumable         a retry resumes the same job, adopting any Auth user already created
 *   · No second account a failed run never permits a second bootstrap job or Auth user
 *   · No secret stored  the temporary password is printed once and never persisted
 *
 * The first Director creates the second through the application; this script is needed exactly once
 * per environment.
 */
import { randomUUID } from "node:crypto";

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

import { normaliseTanzanianPhone } from "@/lib/auth/phone-identity";
import { directorExists, provisionBootstrapDirector } from "@/lib/admin/provisioning";

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const name = argument("--name") ?? process.env.BOOTSTRAP_DIRECTOR_NAME;
  const phoneInput = argument("--phone") ?? process.env.BOOTSTRAP_DIRECTOR_PHONE;

  if (!name || !phoneInput) {
    fail('Usage: npm run bootstrap:director -- --name "Full Name" --phone "0712345678"');
  }

  const phone = normaliseTanzanianPhone(phoneInput);
  if (!phone.ok) fail(`That phone number is not usable: ${phone.reason}`);

  const target = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(unset)";
  console.log(`\n  Bootstrapping the first Director on ${target}`);

  if (await directorExists()) {
    console.log("\n  A Director already exists. Nothing to do — this is a no-op, not a failure.\n");
    return;
  }

  // There is no Director yet to attribute this to, so it is audited as system activity — the one
  // operation in the system for which that is honest.
  const result = await provisionBootstrapDirector({
    fullName: name,
    phoneE164: phone.e164,
    idempotencyKey: randomUUID(),
  });

  if (!result.ok) {
    if (result.reason === "already_provisioned") {
      console.log("\n  Already bootstrapped. Nothing to do — this is a no-op, not a failure.\n");
      return;
    }
    const orphan = "orphanAuthUserId" in result ? result.orphanAuthUserId : undefined;
    fail(
      `Bootstrap did not complete: ${result.reason}. ` +
        "The job is durable — run this command again to resume it. " +
        (orphan ? `An orphaned Auth user (${orphan}) was disabled.` : ""),
    );
  }

  console.log(`
  ✓ Director created

    Name             ${name}
    Signs in with    ${phone.e164}
    Temporary password

        ${result.temporaryPassword}

  This password is shown ONCE and is stored nowhere. Give it to the Director directly.
  They must change it the first time they sign in, and nothing in the system is reachable
  until they do.

  Create the second Director from inside the application, not from this script.
`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
