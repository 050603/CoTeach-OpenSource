import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateTTS: vi.fn(),
  resolveTTSModel: vi.fn(),
  resolveTTSVoice: vi.fn(),
  interactive: vi.fn(),
}));

vi.mock('@openmaic/lib/audio/tts-providers', () => ({
  generateTTS: mocks.generateTTS,
  TTSRateLimitError: class TTSRateLimitError extends Error {},
}));
vi.mock('@openmaic/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => true,
  isServerTTSProviderDisabled: () => false,
  resolveTTSApiKey: () => 'server-key',
  resolveTTSBaseUrl: () => 'https://dashscope.aliyuncs.com/api/v1',
  resolveTTSModel: mocks.resolveTTSModel,
  resolveTTSVoice: mocks.resolveTTSVoice,
}));
vi.mock('@/lib/auth/session', () => ({ isAuthConfigured: () => false }));
vi.mock('@openmaic/lib/server/tts-result-cache', () => ({
  cachedTtsResult: (_config: unknown, _text: string, generate: () => Promise<unknown>) => generate(),
}));
vi.mock('@openmaic/lib/server/interactive-tts', () => ({
  generateInteractiveTts: (config: unknown, text: string, signal: AbortSignal) => mocks.interactive(config, text, signal),
}));

import { POST } from './route';
import { TTSRateLimitError } from '@openmaic/lib/audio/tts-providers';

function request(ttsScenario: string, ttsVoice: string) {
  return new Request('http://localhost/api/openmaic/generate/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '测试语音',
      audioId: 'audio-1',
      ttsProviderId: 'qwen-tts',
      ttsModelId: 'client-model',
      ttsVoice,
      ttsScenario,
    }),
  }) as never;
}

describe('POST /api/openmaic/generate/tts scenario routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateTTS.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'wav' });
    mocks.interactive.mockImplementation((config, text) => mocks.generateTTS(config, text));
    mocks.resolveTTSModel.mockImplementation((_provider, _client, scenario) =>
      scenario === 'course-generation'
        ? 'qwen-audio-3.0-tts-plus'
        : 'qwen-audio-3.0-tts-flash');
    mocks.resolveTTSVoice.mockImplementation((_provider, _client, scenario) =>
      scenario === 'course-generation' ? 'longanlingxin' : 'longanfengyue');
  });

  it('uses the quality model and compatible configured voice for course generation', async () => {
    const response = await POST(request('course-generation', 'longanfengyue'));

    expect(response.status).toBe(200);
    expect(mocks.resolveTTSModel).toHaveBeenCalledWith(
      'qwen-tts',
      'client-model',
      'course-generation',
    );
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'qwen-audio-3.0-tts-plus',
        voice: 'longanlingxin',
      }),
      '测试语音',
    );
  });

  it('keeps a compatible agent voice in the realtime model', async () => {
    await POST(request('realtime-interaction', 'longanlingxi'));

    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'qwen-audio-3.0-tts-flash',
        voice: 'longanlingxi',
      }),
      '测试语音',
    );
  });

  it('forwards the request cancellation signal to shared synthesis', async () => {
    const req = request('realtime-interaction', 'longanfengyue');
    await POST(req);
    expect(mocks.interactive.mock.calls[0][2]).toBe((req as Request).signal);
  });

  it('preserves the actual upstream retry delay and diagnostic identity', async () => {
    mocks.interactive.mockRejectedValue(Object.assign(new TTSRateLimitError('Qwen', 'Limited'), {
      retryAfterMs: 12500, upstreamCode: 'Throttling.RateQuota', upstreamRequestId: 'safe-request-id',
    }));
    const response = await POST(request('realtime-interaction', 'longanfengyue'));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('13');
    expect(JSON.parse((await response.json()).details)).toEqual({ upstreamCode: 'Throttling.RateQuota', upstreamRequestId: 'safe-request-id' });
  });

  it('does not invent an upstream retry delay when the header was absent', async () => {
    mocks.interactive.mockRejectedValue(new TTSRateLimitError('Qwen', 'Limited'));
    const response = await POST(request('realtime-interaction', 'longanfengyue'));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBeNull();
  });
});
