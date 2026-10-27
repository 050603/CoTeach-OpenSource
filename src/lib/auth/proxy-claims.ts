import { jwtVerify, type JWTPayload } from "jose";
import { getHs256VerificationKey } from "./hmac-verification-key";

type ProxyAuthClaims = JWTPayload & {
  role: "teacher" | "student";
  sv: number;
};

/**
 * Proxy performs an optimistic JWT-shape check before protected pages load.
 * Database-backed session-version validation remains in Route Handlers, but
 * legacy tokens without the session-version claim must be rejected here so a
 * page cannot render successfully while all of its APIs return 401.
 */
export function hasValidProxyAuthClaims(
  payload: JWTPayload,
): payload is ProxyAuthClaims {
  if (
    (payload.role !== "teacher" && payload.role !== "student") ||
    typeof payload.sub !== "string" ||
    !Number.isSafeInteger(payload.sv) ||
    Number(payload.sv) < 1
  ) {
    return false;
  }
  if (payload.role === "teacher") {
    return (
      typeof payload.username === "string" &&
      typeof payload.displayName === "string"
    );
  }
  return typeof payload.userId === "string" && payload.userId === payload.sub && typeof payload.studentName === "string";
}

/** The existing optimistic gate; never substitutes for live Route Handler authorization. */
export async function verifyProxyCookie(
  token: string | undefined,
  secret: Uint8Array,
): Promise<ProxyAuthClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, await getHs256VerificationKey(secret), {
      algorithms: ["HS256"],
      issuer: "openpbl",
      audience: "openpbl-app",
    });
    return hasValidProxyAuthClaims(payload) ? payload : null;
  } catch {
    return null;
  }
}
