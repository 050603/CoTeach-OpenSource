import { describe, expect, it, vi } from 'vitest';

const { setGlobalDispatcher, EnvHttpProxyAgent } = vi.hoisted(() => ({
  setGlobalDispatcher: vi.fn(),
  EnvHttpProxyAgent: vi.fn(function MockEnvHttpProxyAgent(
    this: { options?: unknown },
    options: unknown,
  ) {
    this.options = options;
  }),
}));

vi.mock('undici', () => ({ EnvHttpProxyAgent, setGlobalDispatcher }));

import {
  installEnvironmentHttpProxy,
  resolveEnvironmentProxyOptions,
} from './environment-http-proxy';

describe('environment HTTP proxy', () => {
  it('does nothing when the runtime has no proxy configuration', () => {
    expect(resolveEnvironmentProxyOptions({})).toBeNull();
    expect(installEnvironmentHttpProxy({})).toBe(false);
    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it('preserves configured exclusions and always bypasses loopback services', () => {
    expect(resolveEnvironmentProxyOptions({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'postgres,redis',
    })).toEqual({
      httpProxy: undefined,
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: 'postgres,redis,localhost,127.0.0.1,::1',
    });
  });

  it('installs an Undici dispatcher when a proxy is configured', () => {
    expect(installEnvironmentHttpProxy({
      http_proxy: 'http://proxy.internal:8080',
      no_proxy: 'localhost',
    })).toBe(true);
    expect(EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://proxy.internal:8080',
      httpsProxy: undefined,
      noProxy: 'localhost,127.0.0.1,::1',
    });
    expect(setGlobalDispatcher).toHaveBeenCalledOnce();
  });
});
