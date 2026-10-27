import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@openmaic/lib/server/api-response';
import { createTtsVoiceTimingCalibration } from '@openmaic/lib/audio/tts-timing';
import {
  mergeProviderTtsTimingCalibration,
  saveProviderEntry,
} from '@/lib/openmaic-bridge/provider-config-editor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      providerId?: string;
      modelId?: string;
      voiceId?: string;
      language?: string;
      speed?: number;
      text?: string;
      measuredDurationSec?: number;
      apiKey?: string;
      baseUrl?: string;
      models?: string[];
    };
    if (!body.providerId || !body.voiceId || !body.text) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'providerId, voiceId and text are required');
    }
    if (!Number.isFinite(body.measuredDurationSec) || Number(body.measuredDurationSec) <= 0) {
      return apiError('INVALID_REQUEST', 400, 'measuredDurationSec must be a positive number');
    }
    const sample = createTtsVoiceTimingCalibration({
      providerId: body.providerId,
      modelId: body.modelId,
      voiceId: body.voiceId,
      language: body.language || 'zh-CN',
      speed: body.speed ?? 1,
      text: body.text,
      measuredDurationSec: Number(body.measuredDurationSec),
    });
    await saveProviderEntry('tts', body.providerId, {
      apiKey: body.apiKey || '',
      baseUrl: body.baseUrl,
      models: body.models,
      enabled: true,
      defaultModel: body.modelId,
      defaultVoice: body.voiceId,
    });
    const aggregate = await mergeProviderTtsTimingCalibration(body.providerId, sample);
    return apiSuccess({ calibration: aggregate });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
