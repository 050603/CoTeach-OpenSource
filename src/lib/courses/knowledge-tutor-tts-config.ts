import { getKnowledgeLectureTutorSettings, type KnowledgeLectureTutorSettings } from '@/lib/knowledge-lecture-settings';
import { getServerTTSProviders, isServerTTSProviderDisabled, resolveTTSApiKey, resolveTTSBaseUrl, resolveTTSModel, resolveTTSVoice } from '@openmaic/lib/server/provider-config';
import { DEFAULT_TTS_VOICES } from '@openmaic/lib/audio/constants';
import { qwenAudioTtsModelForVoice } from '@openmaic/lib/audio/qwen-audio-tts-catalog';
import type { TTSModelConfig, TTSProviderId } from '@openmaic/lib/audio/types';

/** Shared by prepared narration and live tutor speech. Null means no API TTS. */
export async function resolveExplanationTtsConfig(settings?: KnowledgeLectureTutorSettings): Promise<TTSModelConfig | null> {
  settings ??= await getKnowledgeLectureTutorSettings();
  if (settings.ttsProviderId === 'browser-native-tts') return null;
  const providerId = (settings.ttsProviderId || Object.entries(getServerTTSProviders()).find(([id, info]) => id !== 'browser-native-tts' && !info.disabled)?.[0]) as TTSProviderId | undefined;
  if (!providerId) return null;
  if (isServerTTSProviderDisabled(providerId)) throw new Error('EXPLANATION_TTS_PROVIDER_DISABLED');
  const modelId = resolveTTSModel(providerId, settings.ttsModelId, 'realtime-interaction');
  const preferredVoice = settings.ttsVoice;
  const scenarioVoice = resolveTTSVoice(providerId, preferredVoice, 'realtime-interaction');
  const voice = providerId === 'qwen-tts' && preferredVoice && qwenAudioTtsModelForVoice(preferredVoice) !== modelId
    ? scenarioVoice : preferredVoice || scenarioVoice || DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES];
  if (!voice) throw new Error('EXPLANATION_TTS_VOICE_MISSING');
  return { providerId, modelId, voice, speed: settings.ttsSpeed ?? 1,
    apiKey: resolveTTSApiKey(providerId), baseUrl: resolveTTSBaseUrl(providerId) };
}
