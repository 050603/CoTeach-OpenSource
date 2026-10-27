import { RequestCookies } from "next/dist/compiled/@edge-runtime/cookies";
import { verifyProxyCookie } from "./proxy-claims";

// Keep equivalent to the static negative matcher; Next must see that matcher
// as a literal in proxy.ts. Encoded/adjacent aliases which still run Proxy must
// not receive a second strict gate at the route boundary.
const directReadApiPath = new RegExp("^/api/(?:server-providers|courses(?:/[^/]+/(?:state|events|projection|presence|public-discussion|showcase/(?:presentation|artifacts/pdf)))?|openmaic/(?:classroom|progress)|learning-events|ai-collaboration/(?:code|document|memory))/?$");
export function isDirectReadApiPath(pathname: string): boolean {
  return directReadApiPath.test(pathname);
}

/** Only the exact API route modules excluded by src/proxy.ts use this
 * boundary, for every implemented and framework-generated method. Preserve
 * the old zero-tolerance, either-role optimistic gate; existing handlers keep
 * their own selected-role five-second JWT, live SV/scope and write/CSRF checks.
 * This intentionally retains duplicate signature verification for parity.
 * These JSON/stream/empty APIs use next.config's static CSP, including framework
 * errors. HTML pages keep Proxy's request-specific CSP. Next's sendResponse
 * preserves an existing Node response header over a Route Response header.
 */
export function withReadApiBoundary<Args extends [Request, ...unknown[]]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const request = args[0];
    if (!isDirectReadApiPath(new URL(request.url).pathname)) return handler(...args);
    const raw = process.env.JWT_SECRET;
    let response: Response;
    if (raw && raw.length >= 32) {
      const secret = new TextEncoder().encode(raw);
      // Use the installed Next.js parser, shared with NextRequest/Proxy.
      // Duplicate/malformed-cookie regression tests protect this upgrade edge.
      const cookies = new RequestCookies(request.headers);
      const teacher = await verifyProxyCookie(cookies.get("openpbl_teacher")?.value, secret);
      const student = await verifyProxyCookie(cookies.get("openpbl_student")?.value, secret);
      response = teacher?.role === "teacher" || student?.role === "student"
        ? await handler(...args)
        : Response.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
    } else {
      // Same demo behavior as Proxy; each handler's existing auth remains.
      response = await handler(...args);
    }
    return response;
  };
}

// matcher cannot select HTTP methods. Keep the old optimistic gate for the
// automatic OPTIONS/405 paths too, without adding a live database query.
/** Match Next's automatic OPTIONS list before explicit 405 exports are added.
 * GET implies HEAD; POST-only modules do not acquire a supported HEAD method.
 */
export function readApiOptionsFor(methods: readonly string[]) {
  const allow = [...new Set(["OPTIONS", ...methods, ...(methods.includes("GET") ? ["HEAD"] : [])])]
    .sort().join(", ");
  return withReadApiBoundary<[Request]>(async () =>
    new Response(null, { status: 204, headers: { Allow: allow } }));
}
export const readApiOptions = readApiOptionsFor(["GET"]);
export const readApiMethodNotAllowed = withReadApiBoundary<[Request]>(async () =>
  new Response(null, { status: 405 }));
