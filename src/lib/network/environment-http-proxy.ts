import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

type ProxyEnvironment = Record<string, string | undefined>;

const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1'];

export type EnvironmentProxyOptions = {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy: string;
};

function firstDefined(
  environment: ProxyEnvironment,
  lowercaseName: string,
  uppercaseName: string,
): string | undefined {
  return environment[lowercaseName]?.trim() || environment[uppercaseName]?.trim() || undefined;
}

export function resolveEnvironmentProxyOptions(
  environment: ProxyEnvironment = process.env,
): EnvironmentProxyOptions | null {
  const httpProxy = firstDefined(environment, 'http_proxy', 'HTTP_PROXY');
  const httpsProxy = firstDefined(environment, 'https_proxy', 'HTTPS_PROXY');
  if (!httpProxy && !httpsProxy) return null;

  const configuredNoProxy = firstDefined(environment, 'no_proxy', 'NO_PROXY')
    ?.split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
  const noProxy = Array.from(new Set([...configuredNoProxy, ...LOOPBACK_NO_PROXY])).join(',');

  return { httpProxy, httpsProxy, noProxy };
}

/**
 * Make Node/Undici fetch calls honour the deployment's standard proxy
 * environment. This is intentionally a no-op on local machines without a
 * configured proxy. Loopback services always remain direct.
 */
export function installEnvironmentHttpProxy(
  environment: ProxyEnvironment = process.env,
): boolean {
  const options = resolveEnvironmentProxyOptions(environment);
  if (!options) return false;

  setGlobalDispatcher(new EnvHttpProxyAgent(options));
  return true;
}
