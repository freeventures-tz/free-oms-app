"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { LOCALE_COOKIE, SUPPORTED_LOCALES } from "@/i18n/request";
import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { createServerSupabase } from "@/lib/supabase/server";
import { fieldErrors, signInSchema } from "@/lib/validation/auth";

export type SignInState = {
  formError?: string;
  fieldErrors?: Record<string, string>;
  /**
   * How many attempts have been refused. It exists so the form can replay its rejection animation
   * on a SECOND identical failure, which an unchanged message could not trigger on its own. It is a
   * counter of this browser's own submissions and says nothing about the account.
   */
  attempt?: number;
};

/**
 * Phone-and-password sign-in.
 *
 * The failure message is ALWAYS the same one, whatever went wrong (design.md §7C.1): a wrong
 * password, an unknown number, a banned account and a deactivated account are indistinguishable
 * from outside. Format problems with what the user typed are shown, because they describe the
 * user's own input and reveal nothing about who has an account.
 */
export async function signInAction(
  previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const attempt = (previous.attempt ?? 0) + 1;

  const parsed = signInSchema.safeParse({
    phone: formData.get("phone"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { fieldErrors: fieldErrors(parsed.error), attempt };
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: derivedAuthIdentifier(parsed.data.phone),
    password: parsed.data.password,
  });

  if (error || !data.user) {
    return { formError: "auth.signIn.failed", attempt };
  }

  await adoptLocale(data.user.id);

  // `startsWith("/")` was not enough: `//evil.example` satisfies it and is a protocol-relative URL
  // that browsers resolve to another origin. Anything not provably same-origin falls back to "/",
  // which resolves the role landing server-side.
  redirect(safeNextPath(formData.get("next")) ?? "/");
}

/**
 * The profile is the source of truth for language and is copied into the device cookie at sign-in,
 * so the preference follows the user between devices. On a genuine first sign-in — the account is
 * still gated and the profile is still at the default — the device choice they made on the sign-in
 * screen is adopted instead, which is the only moment that choice can be theirs rather than the
 * previous user's of that phone (architecture.md §5.10).
 */
async function adoptLocale(userId: string): Promise<void> {
  const supabase = await createServerSupabase();
  const { data: profile } = await supabase
    .from("profiles")
    .select("locale, must_change_password")
    .eq("id", userId)
    .maybeSingle();

  if (!profile) return;

  const cookieStore = await cookies();
  const deviceLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  const deviceIsSupported =
    deviceLocale !== undefined && (SUPPORTED_LOCALES as readonly string[]).includes(deviceLocale);

  const adoptDeviceChoice =
    profile.must_change_password === true &&
    profile.locale === "en" &&
    deviceIsSupported &&
    deviceLocale !== "en";

  if (adoptDeviceChoice) {
    await supabase.from("profiles").update({ locale: deviceLocale }).eq("id", userId);
    return;
  }

  cookieStore.set(LOCALE_COOKIE, profile.locale, {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 365,
  });
}
