import { readFileSync } from "node:fs";

import { expect, type Page, type TestInfo } from "@playwright/test";

import { randomUUID } from "node:crypto";

import { adminApi, createAdminClient } from "@/lib/supabase/admin";
import {
  FIXTURES_PATH,
  type E2EFixtures,
  type GatedCredentials,
} from "./global-setup";

export function fixtures(): E2EFixtures {
  return JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as E2EFixtures;
}

/** The gated account belonging to THIS device project, because completing the gate consumes it. */
export function gatedFor(testInfo: TestInfo): GatedCredentials {
  const tier = testInfo.project.name as keyof E2EFixtures["gated"];
  return fixtures().gated[tier];
}

/** A separate gated account for the crash-recovery journey, for the same one-way reason. */
export function gatedCrashFor(testInfo: TestInfo): GatedCredentials {
  const tier = testInfo.project.name as keyof E2EFixtures["gatedCrash"];
  return fixtures().gatedCrash[tier];
}

/**
 * Signs in the way a member of staff does: phone number, then password, and nothing else.
 *
 * Two steps since Stage 9. `enterPhone` stops at the password step, which is where every test about
 * the password itself belongs.
 */
export async function signIn(page: Page, phone: string, password: string): Promise<void> {
  await page.goto("/sign-in");
  await enterPhone(page, phone);
  await submitPassword(page, password);
}

/** Step one only: type the number and advance. Never asks the server whether the account exists. */
export async function enterPhone(page: Page, phone: string): Promise<void> {
  await page.getByLabel(/phone number/i).fill(phone);
  await page.getByRole("button", { name: /^continue$/i }).click();
}

/** Step two: the password, and the one request that decides the outcome. */
export async function submitPassword(page: Page, password: string): Promise<void> {
  await page.getByLabel(/enter your password/i).fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
}

export async function expectLandsOn(page: Page, path: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`));
}

/**
 * The region that carries navigation on this device tier: a drawer on a phone, the rail or sidebar
 * everywhere else. Scoping to it keeps "is this destination offered?" separate from "does this word
 * appear somewhere on the page?".
 */
export async function openNavigation(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: /^menu$/i }).click();
    return page.locator("#fv-drawer");
  }
  return page.locator("aside");
}

/**
 * Reproduces a crash between Supabase Auth and the database: the password really is changed and the
 * marker really is written, and then nothing else happens. This is the state the browser must be
 * able to recover from without the user choosing another password.
 */
export async function changePasswordOutOfBand(
  userId: string,
  password: string,
): Promise<void> {
  const admin = createAdminClient();
  const service = adminApi(admin);

  const { data: begun } = await service.rpc("service_begin_first_login", { p_user_id: userId });
  const operationId = begun?.operation?.id as string;

  await admin.auth.admin.updateUserById(userId, {
    password,
    app_metadata: {
      fv_first_login: {
        operation_id: operationId,
        token: randomUUID(),
        changed_at: new Date().toISOString(),
      },
    },
  });
}

/** A number no other account holds, so a test can own the account it creates. */
export function freshPhone(): string {
  let digits = "7";
  for (let i = 0; i < 8; i++) digits += String(Math.floor(Math.random() * 10));
  return `0${digits}`;
}
