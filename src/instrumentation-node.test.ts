// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ ws: vi.fn(), audit: vi.fn(), eventBus: vi.fn(), archive: vi.fn(), shutdown: vi.fn(), ingressStart: vi.fn(), ingressStop: vi.fn(),
  edgeInitialize: vi.fn(), edgeClose: vi.fn(), warmup: vi.fn(), review: vi.fn(), recommendations: vi.fn(), stopRecommendations: vi.fn() }));
vi.mock('@/lib/config/env', () => ({ assertProductionEnvironment: () => {} }));
vi.mock('@/lib/network/environment-http-proxy', () => ({ installEnvironmentHttpProxy: () => {} }));
vi.mock('@/lib/openmaic/server/provider-config', () => ({ initializeServerProviderConfig: async () => {} }));
vi.mock('@/lib/project-practice/document-archive', () => ({ initializeProjectDocumentArchive: mocks.archive }));
vi.mock('@/lib/project-practice/document-conversion-pool', () => ({ stopDocumentConversionPool: async () => {} }));
vi.mock('@/lib/courses/course-read-worker-pool', () => ({ initializeCourseReadWorkers: async () => {}, stopCourseReadWorkers: async () => {} }));
vi.mock('@/lib/runtime/lifecycle', () => ({ registerShutdownHook: mocks.shutdown, SHUTDOWN_TIMEOUT_MS: 10000, beginShutdown: async () => {} }));
vi.mock('@/lib/observability/metrics', () => ({}));
vi.mock('@/lib/observability/nginx-edge-metrics', () => ({ initializeNginxEdgeMetrics: mocks.edgeInitialize, closeNginxEdgeMetrics: mocks.edgeClose }));
vi.mock('@/lib/observability/node-http-ingress', () => ({ startNodeHttpIngressClock: mocks.ingressStart, stopNodeHttpIngressClock: mocks.ingressStop }));
vi.mock('@/lib/course-generation/capability', () => ({ isBackgroundCourseGenerationEnabled: () => false }));
vi.mock('@/lib/realtime/event-bus', () => ({ initializeEventBus: mocks.eventBus }));
vi.mock('@/lib/realtime/websocket-server', () => ({ startWebSocketServer: mocks.ws }));
vi.mock('@/lib/courses/knowledge-explanation-warmup', () => ({ startKnowledgeExplanationWorker: mocks.warmup, stopKnowledgeExplanationWorker: vi.fn() }));
vi.mock('@/lib/ai-collaboration/document-review-worker', () => ({ startDocumentReviewWorker: mocks.review, stopDocumentReviewWorker: vi.fn() }));
vi.mock('@/lib/showcase/recommendation-worker', () => ({ startShowcaseRecommendationWorker: mocks.recommendations, stopShowcaseRecommendationWorker: mocks.stopRecommendations }));
vi.mock('@/lib/evaluation/process-worker', () => ({ startProcessEvaluationWorker: vi.fn(), stopProcessEvaluationWorker: vi.fn() }));
vi.mock('@/lib/project-practice/content-monitor-worker', () => ({ startContentMonitorWorker: vi.fn(), stopContentMonitorWorker: vi.fn() }));
vi.mock('@/lib/ai-collaboration/audit-outbox', () => ({ startAiAuditOutbox: mocks.audit }));
vi.mock('@/lib/observability/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.ws.mockReset();
  mocks.ingressStart.mockReset().mockReturnValueOnce(true).mockReturnValue(false);
  mocks.edgeInitialize.mockReset().mockResolvedValue(undefined); mocks.edgeClose.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('ENABLE_WEBSOCKET', 'true'); vi.stubEnv('ENABLE_TLDRAW_SYNC', 'false');
  vi.spyOn(process, 'on').mockReturnValue(process);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('awaits WS listening before registration finishes and shares concurrent registration', async () => {
  let ready!: () => void;
  mocks.ws.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
  const { register } = await import('./instrumentation-node');
  const startup = register(); expect(register()).toBe(startup);
  await vi.waitFor(() => expect(mocks.ws).toHaveBeenCalledOnce());
  expect(mocks.audit).not.toHaveBeenCalled();
  ready(); await startup;
  expect(mocks.audit).toHaveBeenCalledOnce();
  await register(); expect(mocks.ws).toHaveBeenCalledOnce();
});
it('propagates bind errors instead of marking registration complete and permits retry', async () => {
  mocks.ws.mockRejectedValueOnce(Error('EADDRINUSE')).mockResolvedValueOnce({});
  const { register } = await import('./instrumentation-node');
  await expect(register()).rejects.toThrow('EADDRINUSE'); expect(mocks.audit).not.toHaveBeenCalled();
  await register(); expect(mocks.ws).toHaveBeenCalledTimes(2); expect(mocks.audit).toHaveBeenCalledOnce();
});
it('does not start a websocket listener when disabled', async () => {
  vi.stubEnv('ENABLE_WEBSOCKET', 'false');
  const { register } = await import('./instrumentation-node'); await register();
  expect(mocks.ws).not.toHaveBeenCalled(); expect(mocks.audit).toHaveBeenCalledOnce();
});

it('rejects the retired whiteboard prototype setting before starting services', async () => {
  vi.stubEnv('ENABLE_TLDRAW_SYNC', 'true');
  const { register } = await import('./instrumentation-node');
  await expect(register()).rejects.toThrow('ENABLE_TLDRAW_SYNC is no longer supported');
  expect(mocks.ws).not.toHaveBeenCalled();
  expect(mocks.ingressStart).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
});

it('starts and stops durable showcase recommendations through the existing worker lifecycle', async () => {
  const { register } = await import('./instrumentation-node'); await register(); await register();
  expect(mocks.recommendations).toHaveBeenCalledOnce();
  const hooks = mocks.shutdown.mock.calls.filter(call => call[0] === 'showcase-recommendation-worker');
  expect(hooks).toHaveLength(1);
  await (hooks[0][1] as () => Promise<void>)(); expect(mocks.stopRecommendations).toHaveBeenCalledOnce();
});

it('starts the native HTTP clock before serving and unregisters it through the existing shutdown lifecycle', async () => {
  const { register } = await import('./instrumentation-node'); await register(); await register();
  expect(mocks.ingressStart).toHaveBeenCalledOnce();
  const hooks = mocks.shutdown.mock.calls.filter(call => call[0] === 'node-http-ingress');
  expect(hooks).toHaveLength(1);
  await (hooks[0][1] as () => Promise<void>)(); expect(mocks.ingressStop).toHaveBeenCalledOnce();
});
it('establishes the edge EOF baseline before startup readiness and shares concurrent registration', async () => {
  let ready!: () => void;
  mocks.edgeInitialize.mockReturnValueOnce(new Promise<void>(resolve => { ready = resolve; }));
  const { register } = await import('./instrumentation-node');
  const startup = register(); expect(register()).toBe(startup);
  await vi.waitFor(() => expect(mocks.edgeInitialize).toHaveBeenCalledOnce());
  expect(mocks.ws).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  ready(); await startup; await register();
  expect(mocks.edgeInitialize).toHaveBeenCalledOnce(); expect(mocks.ws).toHaveBeenCalledOnce();
  expect(mocks.audit).toHaveBeenCalledOnce();
});
it('closes the edge reader through the existing shutdown lifecycle exactly once', async () => {
  const { register } = await import('./instrumentation-node'); await register(); await register();
  const hooks = mocks.shutdown.mock.calls.filter(call => call[0] === 'nginx-edge-log');
  expect(hooks).toHaveLength(1); expect(hooks[0][1]).toBe(mocks.edgeClose);
  await (hooks[0][1] as () => Promise<void>)(); expect(mocks.edgeClose).toHaveBeenCalledOnce();
});
it('does not block the websocket or existing workers when optional edge initialization fails', async () => {
  mocks.edgeInitialize.mockRejectedValueOnce(Error('EACCES'));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { register } = await import('./instrumentation-node'); await expect(register()).resolves.toBeUndefined();
  expect(warning).toHaveBeenCalled(); expect(mocks.ws).toHaveBeenCalledOnce(); expect(mocks.audit).toHaveBeenCalledOnce();
  expect(mocks.warmup).toHaveBeenCalledOnce(); expect(mocks.review).toHaveBeenCalledOnce();
  expect(mocks.shutdown.mock.calls.filter(call => call[0] === 'nginx-edge-log')).toHaveLength(1);
});
