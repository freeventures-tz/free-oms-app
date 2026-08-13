import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

export const LOCALE_COOKIE = "fv-locale";
export const SUPPORTED_LOCALES = ["en", "sw"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Locale resolution: `profiles.locale` → device cookie → `en` (architecture.md §5.10).
 *
 * The profile is the source of truth, and it is written into this cookie at sign-in and whenever the
 * user switches language, so this runs without a database read on every request. An unauthenticated
 * visitor gets the device choice, which is why the language switcher works on the sign-in screen.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const requested = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale: SupportedLocale =
    requested && (SUPPORTED_LOCALES as readonly string[]).includes(requested)
      ? (requested as SupportedLocale)
      : "en";

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    // English is the fallback so a user never sees a raw key. Gaps are caught before release by
    // the dictionary parity test, not by users.
    onError() {},
  };
});
