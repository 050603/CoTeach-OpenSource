// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ websocket: vi.fn(), review: vi.fn(() => ({ ok: true })), query: vi.fn().mockResolvedValue([]), providers: vi.fn(), baseUrl: vi.fn(), fetch: vi.fn(), storageOpen: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { $queryRaw: mocks.query }, isDatabaseConfigured: () => true }));
vi.mock('@/lib/redis/client', () => ({ getRedisClient: async () => ({ ping: async () => 'PONG' }) }));
vi.mock('@/lib/project-practice/document-conversion-pool', () => ({ documentConversionHealth: () => ({ ok: true }) }));
vi.mock('@/lib/ai-collaboration/document-review-worker', () => ({ documentReviewWorkerHealth: mocks.review }));
vi.mock('@/lib/realtime/websocket-lifecycle', () => ({ webSocketReadiness: mocks.websocket }));
vi.mock('@openmaic/lib/server/provider-config', () => ({ getServerProviders: mocks.providers, resolveBaseUrl: mocks.baseUrl }));
vi.mock('node:fs/promises', () => ({ open: mocks.storageOpen, unlink: async () => {} }));
import { DEPENDENCY_TIMEOUT_MS, runReadinessChecks } from './health-checks';
beforeEach(() => {
  vi.clearAllMocks(); mocks.review.mockReturnValue({ ok: true }); mocks.websocket.mockReturnValue({ ok: true });
  mocks.providers.mockReset().mockReturnValue({ test: {} }); mocks.baseUrl.mockReset().mockReturnValue(null); mocks.fetch.mockReset();
  mocks.storageOpen.mockReset().mockResolvedValue({ writeFile: async () => {}, sync: async () => {}, close: async () => {} });
  vi.stubGlobal('fetch', mocks.fetch); vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('ENABLE_WEBSOCKET', 'true');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('does not report ready while enabled websocket is still binding or failed', async () => {
  mocks.websocket.mockReturnValue({ ok: false, error: 'websocket_not_listening' });
  expect(await runReadinessChecks()).toMatchObject({ ok: false, dependencies: { db: { ok: true }, websocket: { ok: false } } });
});
it('requires actual websocket listening in addition to the other dependencies', async () => {
  mocks.websocket.mockReturnValue({ ok: true });
  expect(await runReadinessChecks()).toMatchObject({ ok: true, dependencies: { websocket: { ok: true } } });
});

it('does not require the retired board snapshot directory while checking current classroom storage', async () => {
  vi.stubEnv('UPLOAD_DIR', '/fixture/uploads');
  vi.stubEnv('CLASSROOM_DATA_DIR', '/fixture/classrooms');
  vi.stubEnv('WHITEBOARD_DATA_DIR', '/fixture/retired-boards');
  mocks.storageOpen.mockImplementation(async (file: string) => {
    if (file.startsWith('/fixture/retired-boards/')) throw new Error('ENOENT');
    return { writeFile: async () => {}, sync: async () => {}, close: async () => {} };
  });
  expect(await runReadinessChecks()).toMatchObject({ ok: true, dependencies: { fs: { ok: true } } });
  expect(mocks.storageOpen).toHaveBeenCalledTimes(2);
  expect(mocks.storageOpen.mock.calls.map(([file]) => file)).toEqual([
    expect.stringMatching(/^\/fixture\/uploads\/\.health-/),
    expect.stringMatching(/^\/fixture\/classrooms\/\.health-/),
  ]);
});

it.each(['uploads', 'classrooms'])('still fails readiness when current %s storage is unwritable', async directory => {
  vi.stubEnv('UPLOAD_DIR', '/fixture/uploads');
  vi.stubEnv('CLASSROOM_DATA_DIR', '/fixture/classrooms');
  mocks.storageOpen.mockImplementation(async (file: string) => {
    if (file.startsWith(`/fixture/${directory}/`)) throw new Error('EACCES');
    return { writeFile: async () => {}, sync: async () => {}, close: async () => {} };
  });
  expect(await runReadinessChecks()).toMatchObject({ ok: false, dependencies: { fs: { ok: false, error: 'persistent_storage_unwritable' } } });
});
it('does not require a websocket listener when the feature is disabled', async () => {
  vi.stubEnv('ENABLE_WEBSOCKET', 'false');
  const result = await runReadinessChecks();
  expect(result.ok).toBe(true); expect(result.dependencies).not.toHaveProperty('websocket'); expect(mocks.websocket).not.toHaveBeenCalled();
});
it('reports optional review worker failure while keeping the classroom ready', async () => {
  mocks.websocket.mockReturnValue({ ok: true });
  mocks.review.mockReturnValue({ ok: false, error: 'DOCUMENT_REVIEW_WORKER_UNAVAILABLE' } as { ok: boolean });
  expect(await runReadinessChecks()).toMatchObject({ ok: true, dependencies: { documentReview: { ok: false } } });
});
it('keeps diagnosing the shared worker after document reviews retire', async () => {
  vi.stubEnv('DOCUMENT_AI_PROACTIVE_REVIEW_ENABLED', 'false'); mocks.websocket.mockReturnValue({ ok: true });
  expect(await runReadinessChecks()).toMatchObject({ ok: true, dependencies: { documentReview: { ok: true } } });
  mocks.review.mockReturnValue({ ok: false, error: 'DOCUMENT_REVIEW_WORKER_UNAVAILABLE' } as { ok: boolean });
  expect(await runReadinessChecks()).toMatchObject({ ok: true, dependencies: { documentReview: { ok: false } } });
  expect(mocks.review).toHaveBeenCalledTimes(2);
});
it('still fails readiness for a real database outage alongside optional review failure', async () => {
  mocks.review.mockReturnValue({ ok: false, error: 'DOCUMENT_REVIEW_WORKER_UNAVAILABLE' } as { ok: boolean });
  mocks.query.mockRejectedValueOnce(new Error('database unavailable'));
  expect(await runReadinessChecks()).toMatchObject({ ok: false, dependencies: { db: { ok: false }, documentReview: { ok: false } } });
});
it('keeps configured readiness separate from unknown network and unchecked model execution', async () => {
  const result = await runReadinessChecks();
  expect(result).toMatchObject({ ok: true, dependencies: { llm: {
    ok: true, okScope: 'configuration', networkReachability: 'unknown', modelExecution: 'not_checked',
  } } });
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it('still fails readiness for missing configuration without probing', async () => {
  mocks.providers.mockReturnValue({});
  expect(await runReadinessChecks()).toMatchObject({ ok: false, dependencies: { llm: {
    ok: false, error: 'no_llm_provider_configured', networkReachability: 'unknown', modelExecution: 'not_checked',
  } } });
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it.each([200, 401, 404])('labels HEAD %s as network reachable only', async (status) => {
  mocks.baseUrl.mockReturnValue('https://provider.invalid/private');
  mocks.fetch.mockResolvedValue(new Response(null, { status }));
  const result = await runReadinessChecks();
  expect(result.dependencies.llm).toMatchObject({ ok: true, networkReachability: 'reachable', modelExecution: 'not_checked' });
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('https://provider.invalid/private', expect.objectContaining({ method: 'HEAD', signal: expect.any(AbortSignal) }));
});

it('reports all completed HEAD failures as unreachable without failing configured readiness or exposing secrets', async () => {
  mocks.providers.mockReturnValue({ first: {}, second: {} });
  mocks.baseUrl.mockReturnValue('https://private.invalid/secret');
  mocks.fetch.mockRejectedValueOnce(new Error('private.invalid secret key')).mockResolvedValueOnce(new Response(null, { status: 503 }));
  const result = await runReadinessChecks();
  expect(result).toMatchObject({ ok: true, dependencies: { llm: { ok: true, networkReachability: 'unreachable', modelExecution: 'not_checked' } } });
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toMatch(/private|secret|key/);
});

it('does not report an unobserved provider as unreachable when another fails', async () => {
  mocks.providers.mockReturnValue({ first: {}, second: {} });
  mocks.baseUrl.mockReturnValueOnce('https://provider.invalid').mockReturnValueOnce(null);
  mocks.fetch.mockResolvedValue(new Response(null, { status: 500 }));
  expect((await runReadinessChecks()).dependencies.llm.networkReachability).toBe('unknown');
});

it.each([true, false])('shares one budget, aborts the active HEAD, and sends no later HEAD (transport honors abort: %s)', async (honorsAbort) => {
  vi.useFakeTimers();
  mocks.providers.mockReturnValue({ first: {}, second: {}, third: {} });
  mocks.baseUrl.mockReturnValue('https://provider.invalid');
  let activeSignal: AbortSignal | undefined;
  mocks.fetch.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(new Response(null, { status: 503 })), 1500)))
    .mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      activeSignal = init.signal!;
      if (honorsAbort) activeSignal.addEventListener('abort', () => reject(new Error('secret transport error')), { once: true });
    }));
  const pending = runReadinessChecks();
  await vi.advanceTimersByTimeAsync(1500);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(activeSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(DEPENDENCY_TIMEOUT_MS - 1500);
  expect(await pending).toMatchObject({ ok: true, dependencies: { llm: { ok: true, latencyMs: DEPENDENCY_TIMEOUT_MS, networkReachability: 'unknown', modelExecution: 'not_checked' } } });
  expect(activeSignal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('sanitizes configuration errors without attempting a model call', async () => {
  mocks.providers.mockImplementation(() => { throw new Error('secret provider config'); });
  const result = await runReadinessChecks();
  expect(result.dependencies.llm).toMatchObject({ ok: false, error: 'llm_configuration_unavailable', networkReachability: 'unknown', modelExecution: 'not_checked' });
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(mocks.fetch).not.toHaveBeenCalled();
});
