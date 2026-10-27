/** Reuse only imported key material; signatures, claims and live authorization
 * are still evaluated on every request. One entry bounds retained secret bytes. */
const STATE = Symbol.for("openpbl.auth.hs256-verification-key.v1");
type Entry = { bytes: Uint8Array; promise: Promise<CryptoKey> };
type State = { current?: Entry };

function state(): State {
  const scope = globalThis as typeof globalThis & { [STATE]?: State };
  return scope[STATE] ??= {};
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function getHs256VerificationKey(secret: Uint8Array): Promise<CryptoKey> {
  const cache = state();
  if (cache.current && sameBytes(cache.current.bytes, secret)) return cache.current.promise;
  // Snapshot before the asynchronous import: callers may reuse/mutate a view.
  const bytes = new Uint8Array(secret);
  const entry: Entry = {
    bytes,
    promise: Promise.resolve().then(() => crypto.subtle.importKey(
      "raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    )).catch(error => {
      // A failed old import must not evict a newer secret's successful entry.
      if (cache.current === entry) cache.current = undefined;
      throw error;
    }),
  };
  cache.current = entry;
  return entry.promise;
}
