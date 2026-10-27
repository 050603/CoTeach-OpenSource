import { Agent } from 'node:http';

// Idle HTTP connection policy shared by the launcher and isolated acceptance.
// This caps retained idle sockets, not active work or model execution time.
export const HTTP_UPSTREAM_POLICY = Object.freeze({
  serverKeepAliveMs: 65000,
  upstreamIdleMs: 60000,
  maxIdleSockets: 256,
});

export function createHttpUpstreamAgent() {
  return new Agent({ keepAlive: true, timeout: HTTP_UPSTREAM_POLICY.upstreamIdleMs,
    maxFreeSockets: HTTP_UPSTREAM_POLICY.maxIdleSockets });
}
