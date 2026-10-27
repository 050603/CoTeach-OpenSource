import { afterEach, describe, expect, it, vi } from 'vitest';
import { testGrokImageConnectivity } from './grok-image-adapter';
import { testGrokVideoConnectivity } from './grok-video-adapter';
import { testHappyHorseConnectivity } from './happyhorse-adapter';
import { testKlingConnectivity } from './kling-adapter';
import { testLemonadeImageConnectivity } from './lemonade-image-adapter';
import { testMiniMaxImageConnectivity } from './minimax-image-adapter';
import { testMiniMaxVideoConnectivity } from './minimax-video-adapter';
import { testNanoBananaConnectivity } from './nano-banana-adapter';
import { testOpenAIImageConnectivity } from './openai-image-adapter';
import { testSeedanceConnectivity } from './seedance-adapter';
import { testSeedreamConnectivity } from './seedream-adapter';
import { testVeoConnectivity } from './veo-adapter';

type ConnectivityProbe = (config: never) => Promise<unknown>;

const probes: Array<[string, ConnectivityProbe, Record<string, string>]> = [
  ['Grok image', testGrokImageConnectivity, { providerId: 'grok-image', apiKey: 'test-key' }],
  ['Grok video', testGrokVideoConnectivity, { providerId: 'grok-video', apiKey: 'test-key' }],
  ['HappyHorse', testHappyHorseConnectivity, { providerId: 'happyhorse', apiKey: 'test-key' }],
  ['Kling', testKlingConnectivity, { providerId: 'kling', apiKey: 'access-key:secret-key' }],
  ['Lemonade', testLemonadeImageConnectivity, { providerId: 'lemonade', apiKey: 'test-key' }],
  ['MiniMax image', testMiniMaxImageConnectivity, { providerId: 'minimax-image', apiKey: 'test-key' }],
  ['MiniMax video', testMiniMaxVideoConnectivity, { providerId: 'minimax-video', apiKey: 'test-key' }],
  ['Nano Banana', testNanoBananaConnectivity, { providerId: 'nano-banana', apiKey: 'test-key' }],
  ['OpenAI image', testOpenAIImageConnectivity, { providerId: 'openai-image', apiKey: 'test-key' }],
  ['Seedance', testSeedanceConnectivity, { providerId: 'seedance', apiKey: 'test-key' }],
  ['Seedream', testSeedreamConnectivity, { providerId: 'seedream', apiKey: 'test-key' }],
  ['Veo', testVeoConnectivity, { providerId: 'veo', apiKey: 'test-key' }],
];

describe('provider connectivity redirect security', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(probes)('%s probe never automatically follows redirects', async (_name, probe, config) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302 }));
    vi.stubGlobal('fetch', fetchMock);

    await probe(config as never);

    expect(fetchMock).toHaveBeenCalled();
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ redirect: 'manual' }));
    }
  });
});
