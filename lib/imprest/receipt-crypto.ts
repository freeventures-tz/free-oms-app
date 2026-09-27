/**
 * Receipt encryption (issue #62). Safe to import from the browser, the server and tests.
 *
 * WHY RECEIPTS ARE ENCRYPTED. A Supabase secret key bypasses every storage policy, and the
 * privilege that would stop it cannot be revoked from a migration (the storage schema belongs to
 * Supabase). So the phone encrypts each receipt before it leaves, with a key the database made for
 * that one receipt and hands only to somebody allowed to see it. What sits in the bucket is useless
 * without that key.
 *
 * The format is AES-256-GCM: a random 12-byte nonce, then the ciphertext with its 16-byte tag.
 * GCM authenticates the bytes, so a file changed in storage fails to open instead of showing
 * something else.
 */

export const NONCE_BYTES = 12;
/** What encryption adds to a file: the nonce in front and the tag behind. */
export const ENCRYPTION_OVERHEAD = NONCE_BYTES + 16;

function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(keyBase64: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const raw = bytesFromBase64(keyBase64);
  if (raw.length !== 32) throw new Error("A receipt key is 32 bytes.");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
}

/** The file as it is stored: nonce, then ciphertext and tag. */
export async function encryptReceipt(plain: ArrayBuffer, keyBase64: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await importKey(keyBase64, "encrypt");
  const nonce = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(NONCE_BYTES)));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const out = new Uint8Array(new ArrayBuffer(NONCE_BYTES + sealed.length));
  out.set(nonce, 0);
  out.set(sealed, NONCE_BYTES);
  return out;
}

/** The original file. Throws when the key is wrong or the stored bytes were changed. */
export async function decryptReceipt(stored: ArrayBuffer, keyBase64: string): Promise<ArrayBuffer> {
  if (stored.byteLength < ENCRYPTION_OVERHEAD) throw new Error("This is not an encrypted receipt.");
  const key = await importKey(keyBase64, "decrypt");
  const nonce = new Uint8Array(stored, 0, NONCE_BYTES);
  const sealed = new Uint8Array(stored, NONCE_BYTES);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed);
}
