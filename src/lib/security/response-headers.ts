import { contentSecurityPolicy } from './content-security-policy';

/** The default static security envelope applied by Next.
 * HTML-specific CSP and the resource-player framing override stay in Next.
 */
export function defaultHttpResponseHeaders(development = process.env.NODE_ENV === 'development') {
  return [
    { key: 'X-Request-Id', value: 'unset' },
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(undefined, development) },
  ];
}
