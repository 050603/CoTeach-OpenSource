import type { TTSModelConfig } from '../audio/types';
import { generateTTS } from '../audio/tts-providers';
import { withGenerationRetry } from '../generation/generation-retry';
import { createLogger } from '../logger';
import { cachedTtsResult } from './tts-result-cache';
import { getTtsConcurrencyLimit } from './provider-config';
import { runWithGlobalTtsProviderSlot } from './tts-provider-limiter';

const log = createLogger('InteractiveTTS');
export const INTERACTIVE_TTS_TIMEOUT_MS = 120_000;

/** Exact-text cache, shared provider capacity, and one bounded execution budget.
 * Qwen documents 180 RPM and may enforce RPM/60 per second. Space local starts
 * by 350ms as well as using its existing configured concurrency. Other hosts
 * using the same account still share the upstream quota; errors stay visible.
 * https://help.aliyun.com/zh/model-studio/rate-limit
 */
export function generateInteractiveTts(config: TTSModelConfig, text: string, signal?: AbortSignal) {
  const listenerSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(INTERACTIVE_TTS_TIMEOUT_MS)]);
  return cachedTtsResult(config, text, async sharedSignal => {
    const executionSignal = AbortSignal.any([sharedSignal, AbortSignal.timeout(INTERACTIVE_TTS_TIMEOUT_MS)]);
    try { return await withGenerationRetry(async attempt => {
      try {
        return await runWithGlobalTtsProviderSlot(config.providerId, getTtsConcurrencyLimit(config.providerId),
          () => generateTTS({ ...config, signal: executionSignal }, text), executionSignal,
          { minStartIntervalMs: config.providerId === 'qwen-tts' ? 350 : 0 });
      } catch (error) {
        if (!executionSignal.aborted) {
          const detail = error as { statusCode?: number; upstreamCode?: string; upstreamRequestId?: string; retryAfterMs?: number };
          log.warn('Synthesis attempt failed', { provider: config.providerId, model: config.modelId, attempt,
            status: detail?.statusCode, upstreamCode: detail?.upstreamCode, upstreamRequestId: detail?.upstreamRequestId,
            retryAfterMs: detail?.retryAfterMs });
        }
        throw error;
      }
    }, { label: 'interactive TTS', maxRetries: 2, signal: executionSignal });
    } catch (error) {
      executionSignal.throwIfAborted();
      throw error;
    }
  }, { signal: listenerSignal });
}
