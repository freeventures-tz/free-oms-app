"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { LOCALE_COOKIE, SUPPORTED_LOCALES, type SupportedLocale } from "@/i18n/request";
import { getViewer } from "@/lib/auth/viewer";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Switching language never signs the user out and never loses form data (design.md §8.1).
 *
 * The device cookie is always written, so the choice applies on the sign-in screen too. When there
 * IS a user, the profile is updated as well and becomes the preference that follows them between
 * devices — through the ONLY column `authenticated` may write on `profiles`.
 */
export async function setLocale(locale: string): Promise<void> {
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) return;
  const chosen = locale as SupportedLocale;

  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, chosen, {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 365,
  });

  const viewer = await getViewer();
  if (viewer.state === "active" || viewer.state === "gated") {
    const supabase = await createServerSupabase();
    await supabase.from("profiles").update({ locale: chosen }).eq("id", viewer.userId);
  }

  revalidatePath("/", "layout");
}
