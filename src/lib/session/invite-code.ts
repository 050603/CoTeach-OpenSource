// Generates a 6-character invite code using only visually distinct characters.
// Excludes 0/O/1/I/L to avoid confusion.
//
// Uses the Web Crypto API (`crypto.getRandomValues`) when available so the
// output is backed by a CSPRNG on both the browser and Node.js 18+. Falls
// back to `Math.random` only on very old runtimes that lack the API.

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateInviteCode(length = 6): string {
  const bytes = new Uint8Array(length);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export function isValidInviteCode(code: string): boolean {
  return /^[A-Z2-9]{6}$/.test(normalizeInviteCode(code));
}

export function normalizeInviteCode(code: string): string {
  // Printed and copied codes are commonly grouped as "ABC DEF". Remove all
  // Unicode whitespace so pasted codes behave consistently across platforms.
  return code.replace(/\s+/gu, "").toUpperCase();
}
