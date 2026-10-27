// @vitest-environment node
import type { ProviderCredential } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { authenticateRequest } from '@/lib/auth/request-guards';

type CredentialUpdate = {
  where: { id: string };
  data: Pick<ProviderCredential, 'secret' | 'config' | 'status'>;
};

const mocks = vi.hoisted(() => ({
  rows: [] as ProviderCredential[],
  findMany: vi.fn<() => Promise<ProviderCredential[]>>(),
  authenticate: vi.fn<typeof authenticateRequest>(),
  update: vi.fn<(input: CredentialUpdate) => Promise<ProviderCredential>>(),
}));

vi.mock('@/lib/db/client', () => {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    providerCredential: {
      findFirst: async () => mocks.rows[0] ?? null,
      update: mocks.update,
    },
  };
  return {
    isProviderDatabaseConfigured: () => true,
    providerPrisma: {
      providerCredential: { findMany: mocks.findMany },
      $transaction: async <T>(action: (tx: typeof transaction) => Promise<T>) => action(transaction),
    },
  };
});
vi.mock('@/lib/security/provider-secret', () => ({
  decodeProviderSecret: (value: string) => value,
  encodeProviderSecret: (value: string) => value,
}));
vi.mock('@openmaic/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/auth/request-guards', () => ({ authenticateRequest: mocks.authenticate }));

import {
  ensureServerProviderConfigInitialized,
  getServerProviders,
  initializeServerProviderConfig,
} from '@openmaic/lib/server/provider-config';
import { saveProviderEntry } from '@/lib/openmaic-bridge/provider-config-editor';
import { GET } from '@/app/api/server-providers/route';
import { GET as getOpenMaicProviders } from '@/app/api/openmaic/server-providers/route';

const providerConfigStateKey = Symbol.for('openpbl.server-provider-config');
const runtime = globalThis as typeof globalThis & {
  [providerConfigStateKey]?: { refreshTimer?: ReturnType<typeof setInterval> };
};

function resetProviderRuntime() {
  const timer = runtime[providerConfigStateKey]?.refreshTimer;
  if (timer) clearInterval(timer);
  delete runtime[providerConfigStateKey];
}

function credential(model: string): ProviderCredential {
  return {
    id: 'synthetic-credential',
    ownerId: null,
    name: 'providers',
    provider: 'openai',
    secret: 'synthetic-key',
    config: { models: [model], defaultModel: model },
    status: 'ACTIVE',
    createdAt: new Date('2026-10-16T00:00:00.000Z'),
    updatedAt: new Date('2026-10-16T00:00:00.000Z'),
    rotatedAt: null,
  };
}

function updateCredential({ where, data }: CredentialUpdate): ProviderCredential {
  const index = mocks.rows.findIndex(row => row.id === where.id);
  if (index < 0) throw new Error('Unknown synthetic credential');
  const updated = { ...mocks.rows[index], ...data };
  mocks.rows[index] = updated;
  return updated;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(release => { resolve = release; });
  return { promise, resolve };
}

beforeEach(() => {
  resetProviderRuntime();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENAI_MODELS', '');
  mocks.rows = [credential('first-model')];
  mocks.findMany.mockImplementation(async () => structuredClone(mocks.rows));
  mocks.authenticate.mockResolvedValue({
    claims: { role: 'student', sub: 'synthetic-student', studentName: '验收学生', sv: 1 },
  });
  mocks.update.mockImplementation(async input => updateCredential(input));
});

afterEach(() => {
  resetProviderRuntime();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('global capability snapshot reuse without access caching', () => {
  it('coalesces 30 cold reads and does not reread for 30 warm requests', async () => {
    await Promise.all(Array.from({ length: 30 }, () => ensureServerProviderConfigInitialized()));
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { ownerId: null, status: 'ACTIVE' },
      orderBy: { updatedAt: 'asc' },
    });

    await Promise.all(Array.from({ length: 30 }, () => ensureServerProviderConfigInitialized()));
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(getServerProviders().openai.defaultModel).toBe('first-model');
  });

  it('sees external configuration changes through the existing five-second refresh', async () => {
    await ensureServerProviderConfigInitialized();
    mocks.rows = [credential('external-model')];

    await vi.advanceTimersByTimeAsync(4999);
    expect(getServerProviders().openai.defaultModel).toBe('first-model');
    await vi.advanceTimersByTimeAsync(1);
    expect(getServerProviders().openai.defaultModel).toBe('external-model');
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
  });

  it('does not mark failed cold initialization ready and retries the next reader', async () => {
    mocks.findMany.mockRejectedValueOnce(new Error('temporary database outage'));
    await expect(ensureServerProviderConfigInitialized()).rejects.toThrow('outage');

    await ensureServerProviderConfigInitialized();
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
    expect(getServerProviders().openai.defaultModel).toBe('first-model');
  });

  it('retains the last valid snapshot when periodic refresh fails, then recovers', async () => {
    await ensureServerProviderConfigInitialized();
    mocks.findMany.mockRejectedValueOnce(new Error('temporary database outage'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(getServerProviders().openai.defaultModel).toBe('first-model');

    mocks.rows = [credential('recovered-model')];
    await vi.advanceTimersByTimeAsync(5000);
    expect(getServerProviders().openai.defaultModel).toBe('recovered-model');
  });

  it('refreshes an actual save after an older refresh in flight has settled', async () => {
    await ensureServerProviderConfigInitialized();
    const oldSnapshot = structuredClone(mocks.rows);
    const oldRead = deferred<ProviderCredential[]>();
    const written = deferred<void>();
    mocks.findMany.mockImplementationOnce(() => oldRead.promise);
    mocks.update.mockImplementationOnce(async input => {
      const updated = updateCredential(input);
      written.resolve();
      return updated;
    });

    const priorRefresh = initializeServerProviderConfig();
    const saving = saveProviderEntry('providers', 'openai', {
      apiKey: '', models: ['saved-model'], defaultModel: 'saved-model',
    });
    await written.promise;
    expect(getServerProviders().openai.defaultModel).toBe('first-model');

    oldRead.resolve(oldSnapshot);
    await Promise.all([priorRefresh, saving]);
    expect(mocks.findMany).toHaveBeenCalledTimes(3);
    expect(getServerProviders().openai.defaultModel).toBe('saved-model');
  });

  it('rechecks authentication for every request, including revocation after cache warmup', async () => {
    const routes = [
      { path: '/api/server-providers', get: GET },
      { path: '/api/openmaic/server-providers', get: getOpenMaicProviders },
    ];
    for (const route of routes) {
      const request = new Request(`http://localhost${route.path}`);
      const initial = await route.get(request);
      expect(initial.status).toBe(200);
      expect(JSON.stringify(await initial.json())).not.toContain('synthetic-key');

      mocks.authenticate.mockResolvedValueOnce({
        response: Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }),
      });
      expect((await route.get(request)).status).toBe(401);
    }
    expect(mocks.authenticate).toHaveBeenCalledTimes(4);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });
});
