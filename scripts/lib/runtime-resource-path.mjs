// Only the immutable, build-verified browser runtime. This grants no access
// and must never expand observation/caching to private course resources.
export const MONACO_STATIC_DIAGNOSTIC_ROUTE = '/_next/static/openpbl-runtime/monaco/:version/:fingerprint/:path';

export function isMonacoStaticResourcePath(pathname) {
  if (typeof pathname !== 'string') return false;
  const match = /^\/_next\/static\/openpbl-runtime\/monaco\/\d+\.\d+\.\d+\/[a-f0-9]{64}\/vs\/(.+)$/.exec(pathname);
  return Boolean(match && match[1].split('/').every(segment =>
    /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== '.' && segment !== '..'));
}
