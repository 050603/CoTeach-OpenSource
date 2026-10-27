import { getAuthCookieOptions } from "./session";

const COOKIE_NAME = "openpbl_password_reset";

export function readPasswordResetCookie(request: Request): string | undefined {
  return request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
}

export function passwordResetCookie(token: string, maxAge: number): string {
  const options = getAuthCookieOptions(maxAge);
  return `${COOKIE_NAME}=${token}; Path=/api/platform/auth; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${options.secure ? "; Secure" : ""}`;
}
