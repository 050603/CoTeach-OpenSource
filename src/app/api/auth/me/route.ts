// Current user endpoint — returns the authenticated user's claims.

import { readAuthFromRequest, isAuthConfigured } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAuthConfigured()) {
    return Response.json(
      { user: null, configured: false },
      { status: 200 },
    );
  }
  const claims = await readAuthFromRequest(req);
  if (!claims) {
    return Response.json(
      { user: null, configured: true },
      { status: 200 },
    );
  }
  return Response.json(
    { user: claims, configured: true },
    { status: 200 },
  );
}
