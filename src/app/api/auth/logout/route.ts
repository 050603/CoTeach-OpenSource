// Logout endpoint — clears auth cookies.

import {
  clearAuthCookies,
  getRequestedAuthRole,
} from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/auth/request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  // Keep the other role signed in when teacher and student tabs coexist.
  // Omitting the role header remains an explicit full logout.
  const cookies = clearAuthCookies(getRequestedAuthRole(request));
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  for (const cookie of cookies) {
    headers.append(
      "Set-Cookie",
      `${cookie.name}=${cookie.value}; Path=${cookie.path}; Max-Age=${cookie.maxAge}; HttpOnly; SameSite=${cookie.sameSite}${cookie.secure ? "; Secure" : ""}`,
    );
  }
  return Response.json(
    { ok: true },
    {
      status: 200,
      headers,
    },
  );
}
