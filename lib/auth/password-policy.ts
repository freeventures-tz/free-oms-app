/**
 * The password rules, shown to the user BEFORE they type rather than discovered through rejection
 * (design.md §7C.2). Kept free of `node:crypto` so the same constants can be stated in the browser.
 *
 * These match `[auth] minimum_password_length` and `password_requirements` in
 * `supabase/config.toml`. If one changes, the other must change with it, or the interface will
 * promise something Supabase Auth then refuses.
 */
export const PASSWORD_POLICY = {
  minLength: 12,
  requiresUpper: true,
  requiresLower: true,
  requiresDigit: true,
} as const;

export function passwordMeetsPolicy(password: string): boolean {
  return (
    password.length >= PASSWORD_POLICY.minLength &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password)
  );
}
