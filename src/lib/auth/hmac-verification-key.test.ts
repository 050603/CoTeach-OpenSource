// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, jwtVerify } from "jose";
import { getHs256VerificationKey } from "./hmac-verification-key";
import { verifyToken, signStudentToken, signTeacherToken } from "./session";
import { verifyProxyCookie } from "./proxy-claims";

const STATE = Symbol.for("openpbl.auth.hs256-verification-key.v1");
const scope = globalThis as typeof globalThis & { [STATE]?: unknown };
const secretA = "isolated-key-A-no-real-credentials-1234567890";
const secretB = "isolated-key-B-no-real-credentials-1234567890";
const encode = (value: string) => new TextEncoder().encode(value);
const originalSecret = process.env.JWT_SECRET;
const valid = { role: "student", userId: "student-1", studentName: "Student", sv: 1 };
async function token(payload = valid, secret = secretA, options: { issuer?: string; audience?: string; alg?: string; expires?: number } = {}) {
  return new SignJWT(payload).setProtectedHeader({ alg: options.alg ?? "HS256" }).setSubject("student-1")
    .setIssuer(options.issuer ?? "openpbl").setAudience(options.audience ?? "openpbl-app")
    .setExpirationTime(options.expires ?? Math.floor(Date.now() / 1000) + 60).sign(encode(secret));
}
beforeEach(() => { delete scope[STATE]; process.env.JWT_SECRET = secretA; });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete scope[STATE];
  if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
});

describe("HS256 verification key material only", () => {
  it("singleflights across isolated module copies and retains one nonextractable verify-only key", async () => {
    const imported = vi.spyOn(crypto.subtle, "importKey");
    const first = getHs256VerificationKey(encode(secretA));
    vi.resetModules(); const secondCopy = await import("./hmac-verification-key");
    expect(secondCopy.getHs256VerificationKey(encode(secretA))).toBe(first);
    const keys = await Promise.all(Array.from({ length: 30 }, () => secondCopy.getHs256VerificationKey(encode(secretA))));
    expect(imported).toHaveBeenCalledTimes(1);
    expect(keys.every(key => key === keys[0])).toBe(true);
    expect(keys[0].extractable).toBe(false); expect(keys[0].usages).toEqual(["verify"]);
    expect(keys[0].algorithm).toMatchObject({ name: "HMAC", hash: { name: "SHA-256" } });
  });

  it("copies mutable views before import and compares all bytes rather than object identity/prefix", async () => {
    const signed = await token(); const bytes = encode(secretA); const snapshot = getHs256VerificationKey(bytes);
    bytes[bytes.length - 1] ^= 1; const changed = getHs256VerificationKey(bytes);
    await expect(jwtVerify(signed, await snapshot)).resolves.toHaveProperty("payload.sub", "student-1");
    await expect(jwtVerify(signed, await changed)).rejects.toThrow();
    const second = encode(secretA); const key = await getHs256VerificationKey(second); second.fill(0);
    expect(await getHs256VerificationKey(encode(secretA))).toBe(key);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("A-B-A rotation changes accepted signatures immediately without keeping an old-key cache", async () => {
    const a = await token(); const b = await token(valid, secretB); const imported = vi.spyOn(crypto.subtle, "importKey");
    for (const [secret, accepted, rejected] of [[secretA, a, b], [secretB, b, a], [secretA, a, b]]) {
      process.env.JWT_SECRET = secret;
      expect(await verifyToken(accepted)).toMatchObject(valid); expect(await verifyToken(rejected)).toBeNull();
      expect(await verifyProxyCookie(accepted, encode(secret))).toMatchObject(valid);
      expect(await verifyProxyCookie(rejected, encode(secret))).toBeNull();
    }
    expect(imported).toHaveBeenCalledTimes(3);
  });

  it("retries failed imports and fences a late old failure from evicting the new key", async () => {
    const imported = vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(new Error("isolated import failure"));
    await expect(getHs256VerificationKey(encode(secretA))).rejects.toThrow("isolated import failure");
    const recovered = await getHs256VerificationKey(encode(secretA)); expect(recovered.type).toBe("secret");
    let rejectOld!: (reason: Error) => void;
    imported.mockImplementationOnce(() => new Promise<CryptoKey>((_resolve, reject) => { rejectOld = reject; }));
    const old = getHs256VerificationKey(encode(secretB)); const rejection = expect(old).rejects.toThrow("late old failure");
    await Promise.resolve(); const newer = await getHs256VerificationKey(encode(secretA));
    rejectOld(new Error("late old failure")); await rejection;
    expect(await getHs256VerificationKey(encode(secretA))).toBe(newer);
    expect(imported).toHaveBeenCalledTimes(4);
  });

  it("does not cache valid JWT results or change the distinct session/proxy clock tolerances", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
    const expires = Math.floor(Date.now() / 1000) + 1; const signed = await token(valid, secretA, { expires });
    expect(await verifyToken(signed)).toMatchObject(valid); expect(await verifyProxyCookie(signed, encode(secretA))).toMatchObject(valid);
    vi.setSystemTime(new Date("2026-10-17T00:00:02Z"));
    expect(await verifyToken(signed)).toMatchObject(valid); expect(await verifyProxyCookie(signed, encode(secretA))).toBeNull();
    vi.setSystemTime(new Date("2026-10-17T00:00:07Z"));
    expect(await verifyToken(signed)).toBeNull(); expect(await verifyProxyCookie(signed, encode(secretA))).toBeNull();
  });

  it("checks signatures, issuer, audience, algorithm and every existing claim guard for every token", async () => {
    const signed = await token(); expect(await verifyToken(signed)).toMatchObject(valid);
    const malformed = ["not-a-jwt", signed.slice(0, signed.lastIndexOf(".") + 1) + "AAAA",
      await token(valid, secretA, { issuer: "wrong" }), await token(valid, secretA, { audience: "wrong" }),
      await token(valid, secretA, { alg: "HS384" }), await token(valid, secretA, { expires: Math.floor(Date.now() / 1000) - 10 }),
      await token({ ...valid, nbf: Math.floor(Date.now() / 1000) + 60 } as typeof valid),
      await new SignJWT(valid).setProtectedHeader({ alg: "HS256" }).setIssuer("openpbl")
        .setAudience("openpbl-app").setExpirationTime("1m").sign(encode(secretA))];
    const badClaims = [{ ...valid, role: "admin" }, { ...valid, sv: 0 }, { ...valid, sv: 1.5 },
      { ...valid, userId: "other-student" }, { ...valid, studentName: undefined }, { ...valid, sv: undefined },
      { role: "teacher", sv: 1, username: "Teacher" }, { role: "teacher", sv: 1, displayName: "Teacher" }];
    for (const payload of badClaims) malformed.push(await token(payload as typeof valid));
    for (const value of malformed) {
      expect(await verifyToken(value)).toBeNull(); expect(await verifyProxyCookie(value, encode(secretA))).toBeNull();
    }
    expect(await verifyProxyCookie(undefined, encode(secretA))).toBeNull();
  });

  it("leaves the raw signing path and live claim changes independent of the verification cache", async () => {
    const imported = vi.spyOn(crypto.subtle, "importKey");
    const a = await signStudentToken({ userId: "student-1", studentName: "Student", sessionVersion: 1 });
    const b = await signStudentToken({ userId: "student-1", studentName: "Student", sessionVersion: 2 });
    const teacher = await signTeacherToken({ teacherId: "teacher-1", username: "Teacher", displayName: "Teacher", sessionVersion: 3 });
    expect((await verifyToken(a.token))?.sv).toBe(1); expect((await verifyToken(b.token))?.sv).toBe(2);
    expect(await verifyToken(teacher.token)).toMatchObject({ role: "teacher", sv: 3 });
    expect(imported.mock.calls.filter(call => Array.from(call[4]).includes("sign"))).toHaveLength(3);
    expect(imported.mock.calls.filter(call => Array.from(call[4]).includes("verify"))).toHaveLength(1);
  });
});
