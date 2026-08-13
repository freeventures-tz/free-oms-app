import { randomInt, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "dotenv";

config({ path: ".env.test.local", quiet: true });
config({ path: ".env.local", quiet: true });

import { provisionBootstrapDirector } from "@/lib/admin/provisioning";
import { generateTemporaryPassword } from "@/lib/auth/temporary-password";
import { adminApi, createAdminClient } from "@/lib/supabase/admin";

export const DIRECTOR_FIXTURE_PATH = join(process.cwd(), "tests", ".director.json");

/**
 * The bootstrap Director is created ONCE for the whole integration run, because the system permits
 * exactly one bootstrap for the lifetime of a database — which is the property under test. Each
 * test file then signs in as that Director rather than trying to create another one.
 *
 * `npm run test:integration` resets the database first, so this always starts from nothing.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
    throw new Error(`Integration tests refuse to run against ${url || "(unset)"}.`);
  }

  let digits = "7";
  for (let i = 0; i < 8; i++) digits += String(randomInt(0, 10));
  const phoneE164 = `+255${digits}`;

  const bootstrapped = await provisionBootstrapDirector({
    fullName: "Bootstrap Director",
    phoneE164,
    idempotencyKey: randomUUID(),
  });

  if (!bootstrapped.ok) {
    throw new Error(
      `bootstrap failed: ${bootstrapped.reason}. Integration tests need a clean database — ` +
        "run them through `npm run test:integration`, which resets it first.",
    );
  }

  // The same three steps the server takes: change at Auth, record it, then clear the gate. The
  // database will not clear a gate without that recorded evidence, fixture or not.
  const password = generateTemporaryPassword();
  const admin = createAdminClient();
  const service = adminApi(admin);

  const { data: begun } = await service.rpc("service_begin_first_login", {
    p_user_id: bootstrapped.userId,
  });
  const operationId = begun?.operation?.id as string;

  const token = randomUUID();
  await admin.auth.admin.updateUserById(bootstrapped.userId, {
    password,
    app_metadata: {
      fv_first_login: { operation_id: operationId, token, changed_at: new Date().toISOString() },
    },
  });
  await service.rpc("service_record_first_login_password_changed", {
    p_operation_id: operationId,
    p_user_id: bootstrapped.userId,
    p_auth_evidence: token,
  });
  await service.rpc("service_complete_first_login", {
    p_user_id: bootstrapped.userId,
    p_operation_id: operationId,
  });

  writeFileSync(
    DIRECTOR_FIXTURE_PATH,
    JSON.stringify({ userId: bootstrapped.userId, phoneE164, password }, null, 2),
  );
}
