import { createHash, timingSafeEqual } from "node:crypto";

export function authorizeLoadTestRequest(request: Request): Response | null {
  if (
    process.env.ENABLE_LOAD_TEST_API !== "true" ||
    process.env.NODE_ENV !== "production"
  ) {
    return Response.json({ code: "NOT_FOUND", message: "Not found." }, { status: 404 });
  }

  const expected = process.env.LOAD_TEST_ADMIN_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || expected.length < 32 || !supplied) {
    return Response.json({ code: "UNAUTHORIZED", message: "Unauthorized." }, { status: 401 });
  }
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  if (!timingSafeEqual(expectedDigest, suppliedDigest)) {
    return Response.json({ code: "UNAUTHORIZED", message: "Unauthorized." }, { status: 401 });
  }
  return null;
}
