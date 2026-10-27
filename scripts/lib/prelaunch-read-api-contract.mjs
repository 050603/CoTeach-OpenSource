/** Shared evidence contract: fixed paths/methods, never an authorization policy. */
export const READ_API_NATIVE_PROTOCOL_VERSION = 'proxy-json-apis-v3';
export const READ_API_NATIVE_PROTOCOL_CHECKS = Object.freeze([
  'all-five-real-GET-HEAD-OPTIONS-and-write-rejection-shapes',
  'strict-gate-and-selected-grace-role-with-dual-real-JWTs',
  'live-session-version-status-role-before-conditional-cache-hit',
  'fresh-enrollment-and-outsider-scope-denials-without-changing-history',
  'uncaught-error-keeps-framework500-and-static-CSP',
  'native-clock-is-genuine-and-absent-Proxy-clock-stays-unknown',
  'retired-and-page-Proxy-guards-retained',
  'expanded-nine-API-methods-scopes-and-rejected-inputs-preserve-owned-facts',
]);
export const READ_API_NATIVE_ROUTES = Object.freeze([
  ['/api/server-providers', ['GET']], ['/api/courses', ['GET']],
  ...['state', 'events', 'projection'].map(name => [`/api/courses/:courseId/${name}`, ['GET']]),
  ['/api/courses/:courseId/showcase/presentation', ['GET', 'POST']],
  ['/api/courses/:courseId/public-discussion', ['GET', 'POST']],
  ['/api/courses/:courseId/presence', ['GET', 'PUT', 'DELETE']],
  ['/api/openmaic/classroom', ['GET']], ['/api/openmaic/progress', ['GET', 'POST']],
  ['/api/learning-events', ['POST']],
  ['/api/ai-collaboration/code', ['GET', 'POST', 'DELETE']],
  ['/api/ai-collaboration/document', ['GET', 'POST', 'DELETE']],
  ['/api/ai-collaboration/memory', ['GET', 'PATCH', 'DELETE']],
].map(([route, implemented]) => Object.freeze({ route, implemented: Object.freeze(implemented),
  optionsAllow: [...new Set([...implemented, ...(implemented.includes('GET') ? ['HEAD'] : []), 'OPTIONS'])].sort().join(', ') })));
