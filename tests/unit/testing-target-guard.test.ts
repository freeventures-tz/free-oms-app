import { describe, expect, it } from "vitest";

import { readStackConfig, targetRefusals } from "@/scripts/testing/target-guard.mjs";

/**
 * The check that stands between a destructive test and a database that is not this checkout's own.
 *
 * The old checks accepted any URL that CONTAINED "127.0.0.1" or "localhost". These cases are the
 * hostile and the accidental ways around that, and each must be refused before a reset or a
 * bootstrap runs. Nothing here contacts a host.
 */

const CONFIG = `
project_id = "free-oms-app"

[api]
enabled = true
port = 54321

[db]
# The port used for the database URL.
port = 54322
shadow_port = 54320

[db.pooler]
port = 54329
`;

const stack = readStackConfig(CONFIG);
const local = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" };

describe("test target guard", () => {
  it("reads project_id and the api and db ports, not the pooler's", () => {
    expect(stack).toEqual({ projectId: "free-oms-app", apiPort: 54321, dbPort: 54322 });
  });

  it("accepts this checkout's own local stack on every loopback spelling", () => {
    expect(targetRefusals(local, stack)).toEqual([]);
    expect(targetRefusals({ NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321/" }, stack)).toEqual([]);
    expect(targetRefusals({ NEXT_PUBLIC_SUPABASE_URL: "http://[::1]:54321" }, stack)).toEqual([]);
  });

  it.each([
    ["a hosted project", "https://owwvdzvduoijioutgbfl.supabase.co"],
    ["a hostname that only starts with the loopback address", "http://127.0.0.1.attacker.example:54321"],
    ["a hostile host that mentions localhost in its path", "http://db.example:54321/localhost"],
    ["credentials smuggled before a loopback-looking host", "http://127.0.0.1:54321@db.example"],
    ["https to a loopback host", "https://127.0.0.1:54321"],
    ["a path on the right host", "http://127.0.0.1:54321/rest/v1"],
    ["another stack's port", "http://127.0.0.1:56321"],
    ["an unset URL", ""],
    ["not a URL at all", "localhost"],
  ])("refuses %s", (_label, url) => {
    expect(targetRefusals({ NEXT_PUBLIC_SUPABASE_URL: url }, stack)).not.toEqual([]);
  });

  it("refuses a database URL that is remote or another stack's", () => {
    expect(targetRefusals({ ...local, SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" }, stack)).toEqual([]);
    expect(targetRefusals({ ...local, SUPABASE_DB_URL: "postgresql://postgres:x@db.owwvdzvduoijioutgbfl.supabase.co:5432/postgres" }, stack))
      .toContain("SUPABASE_DB_URL host db.owwvdzvduoijioutgbfl.supabase.co is not loopback");
    expect(targetRefusals({ ...local, SUPABASE_SUPERUSER_DB_URL: "postgresql://postgres:postgres@127.0.0.1:56322/postgres" }, stack))
      .toContain("SUPABASE_SUPERUSER_DB_URL port 56322 is not this checkout's database port 54322");
    expect(targetRefusals({ ...local, SUPABASE_DB_URL: "mysql://127.0.0.1:54322/x" }, stack)).toContain("SUPABASE_DB_URL is not a postgres URL");
  });

  it("refuses an API and database pair from different stacks", () => {
    // The API is this checkout's; the database URL is left over from another worktree's stack.
    const mixed = { ...local, SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:56322/postgres" };
    expect(targetRefusals(mixed, stack)).toHaveLength(1);
  });

  it("refuses a database container that is not this checkout's", () => {
    expect(targetRefusals({ ...local, SUPABASE_DB_CONTAINER: "supabase_db_free-oms-app" }, stack)).toEqual([]);
    expect(targetRefusals({ ...local, SUPABASE_DB_CONTAINER: "supabase_db_free-oms-83" }, stack)).toEqual([
      "SUPABASE_DB_CONTAINER supabase_db_free-oms-83 is not this checkout's container supabase_db_free-oms-app",
    ]);
  });

  it("refuses an E2E app that is not on a loopback host", () => {
    expect(targetRefusals({ ...local, E2E_BASE_URL: "http://127.0.0.1:3000" }, stack)).toEqual([]);
    expect(targetRefusals({ ...local, E2E_BASE_URL: "https://free-oms.vercel.app" }, stack)).not.toEqual([]);
  });

  it("refuses when the stack's own config cannot name its ports", () => {
    expect(targetRefusals(local, readStackConfig('project_id = "x"'))[0]).toMatch(/does not declare/);
  });

  it("does not require an API URL for database-only steps, but still checks one that is set", () => {
    expect(targetRefusals({}, stack, { require: [] })).toEqual([]);
    expect(targetRefusals({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" }, stack, { require: [] })).not.toEqual([]);
  });
});
