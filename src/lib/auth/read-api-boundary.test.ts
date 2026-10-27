// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, type JWTPayload } from "jose";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ currentVersion: vi.fn() }));
vi.mock("@/lib/auth/session-version", () => ({ hasCurrentSessionVersion: mocks.currentVersion }));
import { authenticateRequest, requireSameOrigin } from "./request-guards";
import { readApiMethodNotAllowed, readApiOptions, readApiOptionsFor, withReadApiBoundary } from "./read-api-boundary";
import { proxy } from "@/proxy";

const initialSecret = process.env.JWT_SECRET;
const now = 1_800_000_000;
const secret = "read-boundary-test-secret-at-least-thirty-two-characters";
type Role = "teacher" | "student";
async function token(role: Role, changes: JWTPayload = {}) {
  return new SignJWT({ sub: `${role}-1`, role, sv: 1, iss: "openpbl", aud: "openpbl-app", exp: now + 60,
    ...(role === "teacher" ? { username: "teacher", displayName: "Teacher" }
      : { userId: "student-1", studentName: "Student" }), ...changes })
    .setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret));
}
async function request(input: { teacher?: JWTPayload | false; student?: JWTPayload | false; role?: Role; method?: string; pathname?: string } = {}) {
  const cookies: string[] = [];
  if (input.teacher) cookies.push(`openpbl_teacher=${await token("teacher", input.teacher)}`);
  if (input.student) cookies.push(`openpbl_student=${await token("student", input.student)}`);
  return new NextRequest(`http://127.0.0.1:3000${input.pathname ?? "/api/courses/course/state"}`, { method: input.method ?? "GET",
    headers: { cookie: cookies.join("; "), host: "127.0.0.1:3000", "x-request-id": "read-boundary-auth-parity", ...(input.role ? { "x-openpbl-role": input.role } : {}) } });
}
const business = vi.fn(async (incoming: Request) => {
  const auth = await authenticateRequest(incoming);
  if ("response" in auth) return auth.response;
  return Response.json({ subject: auth.claims.sub, role: auth.claims.role });
});
const moved = withReadApiBoundary(business);
async function previous(incoming: NextRequest, handler = business) {
  // Real old optimistic function, then the unchanged live handler. Calling it
  // explicitly is the oracle; matcher only decides whether this function runs.
  const admission = await proxy(incoming);
  if (admission.headers.get("x-middleware-next") !== "1") return admission;
  const response = await handler(incoming);
  response.headers.set("Content-Security-Policy", admission.headers.get("Content-Security-Policy")!);
  return response;
}

beforeEach(() => {
  process.env.JWT_SECRET = secret;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now * 1000);
  mocks.currentVersion.mockReset().mockImplementation(async (claims: { sv: number }) => claims.sv === 1);
  business.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  if (initialSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = initialSecret;
});

describe("read API boundary preserves the composed authentication contract", () => {
  it.each(Array.from({ length: 13 }, (_, i) => i - 6))("preserves exp/nbf at offset %i seconds with a single cookie and both role selections", async offset => {
    for (const role of ["teacher", "student"] as const) {
      for (const field of ["exp", "nbf"] as const) {
        for (const otherValid of [false, true]) {
          const input = { role, [role]: { [field]: now + offset }, ...(otherValid ? { [role === "teacher" ? "student" : "teacher"]: {} } : {}) };
          const incoming = await request(input);
          const expected = await previous(incoming); const priorQueries = mocks.currentVersion.mock.calls.length;
          const response = await moved(incoming);
          expect(response.status).toBe(expected.status);
          const handlerTimeValid = field === "exp" ? offset > -5 : offset <= 5;
          const optimisticTimeValid = field === "exp" ? offset > 0 : offset <= 0;
          expect(response.status).toBe(handlerTimeValid && (optimisticTimeValid || otherValid) ? 200 : 401);
          expect(await response.json()).toEqual(await expected.json());
          // Framework-level static CSP is verified through native Next HTTP;
          // this standalone auth boundary must not override that policy.
          expect(response.headers.get("Content-Security-Policy")).toBeNull();
          expect(mocks.currentVersion.mock.calls.length - priorQueries).toBe(priorQueries);
          mocks.currentVersion.mockClear();
        }
      }
    }
  });

  it("retains the selected grace-period role when the other role passed the strict gate", async () => {
    const response = await moved(await request({ role: "teacher", teacher: { exp: now - 1 }, student: {} }));
    expect(await response.json()).toEqual({ subject: "teacher-1", role: "teacher" });
    expect(mocks.currentVersion).toHaveBeenCalledTimes(1);
  });

  it("uses current live session data each time without a new admission database query", async () => {
    const incoming = await request({ student: {}, role: "student" });
    expect((await moved(incoming)).status).toBe(200);
    mocks.currentVersion.mockResolvedValue(false);
    const revoked = await moved(incoming);
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("set-cookie")).toContain("openpbl_student=");
    expect(mocks.currentVersion).toHaveBeenCalledTimes(2);
  });

  it("never authorizes a preferred student through a teacher cookie", async () => {
    expect((await moved(await request({ teacher: {}, role: "student" }))).status).toBe(401);
    expect(mocks.currentVersion).not.toHaveBeenCalled();
  });

  it("retains malformed and duplicate-cookie rejection rather than picking a new identity", async () => {
    const valid = await token("student");
    for (const cookie of ["openpbl_student=invalid", "openpbl_student=%E0%A4%A",
      `openpbl_student=invalid; openpbl_student=${valid}`,
      `openpbl_student=${valid}; openpbl_student=invalid`]) {
      const incoming = new NextRequest("http://localhost/api/courses", { headers: { cookie, "x-openpbl-role": "student" } });
      expect((await previous(incoming)).status).toBe(401);
      expect((await moved(incoming)).status).toBe(401);
    }
    expect(mocks.currentVersion).not.toHaveBeenCalled();
  });

  it("retains database-free OPTIONS/405 admission and the original supported-method list", async () => {
    for (const hasCookie of [false, true]) {
      for (const method of ["OPTIONS", "POST", "PUT", "PATCH", "DELETE"]) {
        const incoming = await request({ method, teacher: hasCookie ? {} : false });
        const response = await (method === "OPTIONS" ? readApiOptions : readApiMethodNotAllowed)(incoming);
        expect(response.status).toBe(hasCookie ? method === "OPTIONS" ? 204 : 405 : 401);
        expect(response.headers.get("allow")).toBe(hasCookie && method === "OPTIONS" ? "GET, HEAD, OPTIONS" : null);
        expect(response.headers.get("Content-Security-Policy")).toBeNull();
      }
    }
    expect(mocks.currentVersion).not.toHaveBeenCalled(); expect(business).not.toHaveBeenCalled();
  });

  it("leaves the existing uncaught malformed duplicate-cookie error to Next", async () => {
    const valid = await token("student");
    const incoming = new NextRequest("http://localhost/api/courses", { headers: {
      cookie: `openpbl_student=%E0%A4%A; openpbl_student=${valid}`, "x-openpbl-role": "student",
    } });
    await expect(previous(incoming)).rejects.toBeInstanceOf(URIError);
    await expect(moved(incoming)).rejects.toBeInstanceOf(URIError);
    expect(mocks.currentVersion).not.toHaveBeenCalled();
  });

  it("does not weaken a business scope denial or alter its cache/ETag headers", async () => {
    const denial = withReadApiBoundary(async (incoming: Request) => {
      const auth = await authenticateRequest(incoming); if ("response" in auth) return auth.response;
      return new Response(null, { status: 403, headers: { "Cache-Control": "private, no-store", ETag: 'W/"denied-fixture"' } });
    });
    const response = await denial(await request({ student: {}, role: "student" }));
    expect(response.status).toBe(403); expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBe('W/"denied-fixture"');
    expect(mocks.currentVersion).toHaveBeenCalledTimes(1);
  });

  it("keeps demo GET authentication and OPTIONS behavior separate", async () => {
    delete process.env.JWT_SECRET;
    expect((await moved(await request())).status).toBe(401);
    expect((await readApiOptions(await request({ method: "OPTIONS" }))).status).toBe(204);
    expect(mocks.currentVersion).not.toHaveBeenCalled();
  });
});

const expandedModules = [
  { pathname: '/api/courses/course/showcase/artifacts/pdf', methods: ['POST'], allow: 'OPTIONS, POST' },
  { pathname: '/api/courses/course/showcase/presentation', methods: ['GET', 'POST', 'PATCH'], allow: 'GET, HEAD, OPTIONS, PATCH, POST' },
  { pathname: '/api/courses/course/public-discussion', methods: ['GET', 'POST'], allow: 'GET, HEAD, OPTIONS, POST' },
  { pathname: '/api/courses/course/presence', methods: ['GET', 'PUT', 'DELETE'], allow: 'DELETE, GET, HEAD, OPTIONS, PUT' },
  { pathname: '/api/openmaic/classroom', methods: ['GET'], allow: 'GET, HEAD, OPTIONS' },
  { pathname: '/api/openmaic/progress', methods: ['GET', 'POST'], allow: 'GET, HEAD, OPTIONS, POST' },
  { pathname: '/api/learning-events', methods: ['POST'], allow: 'OPTIONS, POST' },
  { pathname: '/api/ai-collaboration/code', methods: ['GET', 'POST', 'DELETE'], allow: 'DELETE, GET, HEAD, OPTIONS, POST' },
  { pathname: '/api/ai-collaboration/document', methods: ['GET', 'POST', 'DELETE'], allow: 'DELETE, GET, HEAD, OPTIONS, POST' },
  { pathname: '/api/ai-collaboration/memory', methods: ['GET', 'PATCH', 'DELETE'], allow: 'DELETE, GET, HEAD, OPTIONS, PATCH' },
];

describe('expanded API method admission', () => {
  it.each(expandedModules)('preserves zero-tolerance and dual-cookie selected-role behavior on $pathname', async entry => {
    for (const method of entry.methods) {
      for (const field of ['exp', 'nbf'] as const) {
        for (const offset of [-1, 0, 1]) {
          for (const otherValid of [false, true]) {
            const incoming = await request({ pathname: entry.pathname, method, role: 'student',
              student: { [field]: now + offset }, teacher: otherValid ? {} : false });
            const expected = await previous(incoming);
            const actual = await moved(incoming);
            expect(actual.status).toBe(expected.status);
            expect(await actual.json()).toEqual(await expected.json());
          }
        }
      }
    }
  });

  it.each(expandedModules)('keeps exact automatic Allow and strict unsupported-method gate on $pathname', async entry => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const supported = entry.methods.includes(method) || (method === 'HEAD' && entry.methods.includes('GET'));
      const endpoint = method === 'OPTIONS' ? readApiOptionsFor(entry.methods) : supported ? moved : readApiMethodNotAllowed;
      for (const valid of [false, true]) {
        const incoming = await request({ pathname: entry.pathname, method, student: valid ? {} : false, role: 'student' });
        const response = await endpoint(incoming);
        expect(response.status).toBe(!valid ? 401 : method === 'OPTIONS' ? 204 : supported ? 200 : 405);
        expect(response.headers.get('Allow')).toBe(valid && method === 'OPTIONS' ? entry.allow : null);
      }
    }
    // In particular, explicit 405 exports must not expand the OPTIONS list.
    expect(entry.allow.includes('HEAD')).toBe(entry.methods.includes('GET'));
  });

  it.each(expandedModules)('keeps malformed/duplicate-cookie behavior and a live session denial on $pathname', async entry => {
    const valid = await token('student');
    const method = entry.methods[0];
    for (const cookie of ['openpbl_student=invalid', 'openpbl_student=%E0%A4%A',
      `openpbl_student=invalid; openpbl_student=${valid}`, `openpbl_student=${valid}; openpbl_student=invalid`]) {
      const incoming = new NextRequest(`http://localhost${entry.pathname}`, { method, headers: { cookie } });
      const expected = await previous(incoming);
      expect((await moved(incoming)).status).toBe(expected.status);
    }
    const malformed = new NextRequest(`http://localhost${entry.pathname}`, { method,
      headers: { cookie: `openpbl_student=%E0%A4%A; openpbl_student=${valid}` } });
    await expect(previous(malformed)).rejects.toBeInstanceOf(URIError);
    await expect(moved(malformed)).rejects.toBeInstanceOf(URIError);
    const incoming = await request({ pathname: entry.pathname, method, student: {}, role: 'student' });
    expect((await moved(incoming)).status).toBe(200);
    mocks.currentVersion.mockResolvedValue(false);
    expect((await moved(incoming)).status).toBe(401);
  });

  it('passes the exact write request, body, context and streaming response through without replay or buffering', async () => {
    const body = JSON.stringify({ requestId: 'immutable-business-request', content: '完整正文' });
    const incoming = await request({ pathname: '/api/ai-collaboration/document', method: 'POST', student: {}, role: 'student' });
    const headers = new Headers(incoming.headers);
    headers.set('Origin', 'http://127.0.0.1:3000');
    headers.set('Content-Type', 'application/json');
    headers.set('X-Request-Id', 'immutable-business-request');
    const write = new Request(incoming.url, { method: 'POST', headers, body });
    const context = { marker: 'unchanged' };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let businessResponse!: Response;
    const handler = vi.fn(async (req: Request, ctx: typeof context) => {
      expect(req).toBe(write); expect(ctx).toBe(context);
      expect(requireSameOrigin(req)).toBeNull();
      expect(req.headers.get('x-request-id')).toBe('immutable-business-request');
      expect(await req.text()).toBe(body);
      businessResponse = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }),
        { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store' } });
      return businessResponse;
    });
    const response = await withReadApiBoundary(handler)(write, context);
    expect(response).toBe(businessResponse);
    expect(response.bodyUsed).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    const reader = response.body!.getReader();
    controller.enqueue(new TextEncoder().encode('data: first\n\n'));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
    controller.close();
    expect((await reader.read()).done).toBe(true);
  });

  it('preserves a write handler CSRF rejection after strict admission', async () => {
    const req = await request({ pathname: '/api/learning-events', method: 'POST', student: {}, role: 'student' });
    req.headers.set('Origin', 'https://unrelated.example');
    const write = withReadApiBoundary(async (incoming: Request) => requireSameOrigin(incoming) ?? new Response(null));
    expect((await write(req)).status).toBe(403);
  });
});
