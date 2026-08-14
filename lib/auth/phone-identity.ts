/**
 * Tanzanian phone numbers as login identifiers.
 *
 * WHY A DERIVED IDENTIFIER EXISTS
 * -------------------------------
 * The product requires phone-and-password sign-in with no SMS, no OTP and no phone verification
 * (architecture.md §7.1). Supabase Auth cannot do that: phone logins require the phone provider,
 * the phone provider requires an SMS provider, and with none configured Auth answers a phone
 * password grant with
 *
 *     422 { "error_code": "phone_provider_disabled", "msg": "Phone logins are disabled" }
 *
 * — verified against the running stack, not assumed. Buying an SMS provider to satisfy a product
 * rule that forbids SMS would be the wrong trade.
 *
 * So the phone stays the identifier the user knows and types, and Auth is handed a DERIVED
 * identifier computed from it. The derivation is total and reversible: one phone number maps to
 * exactly one identifier, and `auth.users` enforces uniqueness on it just as `profiles.phone_e164`
 * does on the number itself. The domain is under RFC 2606's reserved `.invalid` TLD, so it can
 * never be a routable address, and nothing is ever sent to it.
 *
 * The user never sees it, never types it, and never has an email requirement.
 */

/** Reserved and unroutable by definition (RFC 2606). Changing this would strand every account. */
export const DERIVED_IDENTIFIER_DOMAIN = "phone.free-ventures.invalid";

export type PhoneNormalisation =
  | { ok: true; e164: string }
  | { ok: false; reason: "empty" | "not_tanzanian" | "wrong_length" | "invalid_characters" };

/**
 * Accepts the formats Tanzanian staff actually type — `0712 345 678`, `+255 712 345 678`,
 * `255712345678`, `712345678` — and produces the single stored form `+255XXXXXXXXX`.
 */
export function normaliseTanzanianPhone(input: string): PhoneNormalisation {
  const raw = (input ?? "").trim();
  if (raw.length === 0) return { ok: false, reason: "empty" };

  // Separators people use; anything else is a typo worth reporting rather than silently dropping.
  const cleaned = raw.replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(cleaned)) return { ok: false, reason: "invalid_characters" };

  let national: string;
  if (cleaned.startsWith("+255")) {
    national = cleaned.slice(4);
  } else if (cleaned.startsWith("255")) {
    national = cleaned.slice(3);
  } else if (cleaned.startsWith("0")) {
    national = cleaned.slice(1);
  } else if (cleaned.startsWith("+")) {
    return { ok: false, reason: "not_tanzanian" };
  } else {
    national = cleaned;
  }

  if (national.length !== 9) return { ok: false, reason: "wrong_length" };
  if (national.startsWith("0")) return { ok: false, reason: "wrong_length" };

  return { ok: true, e164: `+255${national}` };
}

/** The identifier handed to Supabase Auth. Never shown to a user. */
export function derivedAuthIdentifier(e164: string): string {
  if (!/^\+255\d{9}$/.test(e164)) {
    throw new Error("derivedAuthIdentifier requires a normalised +255 number");
  }
  return `${e164.slice(1)}@${DERIVED_IDENTIFIER_DOMAIN}`;
}

/** Formats a stored number the way it is read aloud locally: `+255 712 345 678`. */
export function formatPhoneForDisplay(e164: string): string {
  if (!/^\+255\d{9}$/.test(e164)) return e164;
  const n = e164.slice(4);
  return `+255 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
}

/**
 * Progressive normalisation for the sign-in field, which shows the stored form as the user types
 * (design.md §7C.1) without fighting them mid-entry.
 */
export function previewNormalisation(input: string): string {
  const result = normaliseTanzanianPhone(input);
  return result.ok ? formatPhoneForDisplay(result.e164) : "";
}
