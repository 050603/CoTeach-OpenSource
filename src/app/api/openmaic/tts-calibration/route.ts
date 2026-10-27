import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@openmaic/lib/server/api-response';
import { createTtsVoiceTimingCalibration } from '@openmaic/lib/audio/tts-timing';
import {
  getProviderEntry,
  mergeProviderTtsTimingCalibration,
} from '@/lib/openmaic-bridge/provider-config-editor';
import { authenticateRequest, requireSameOrigin } from '@/lib/auth/request-guards';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CalibrationSchema = z.object({
  providerId: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  modelId: z.string().trim().max(200).optional(),
  voiceId: z.string().trim().min(1).max(200),
  language: z.string().trim().max(40).optional(),
  speed: z.number().finite().positive().optional(),
  text: z.string().min(1).max(20_000),
  measuredDurationSec: z.number().finite().positive(),
});

export async function POST(request: NextRequest) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request, 'teacher');
  if ('response' in auth) return auth.response;
  try {
    const parsed = CalibrationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError('INVALID_REQUEST', 400, 'TTS calibration is invalid');
    const body = parsed.data;
    if (!await getProviderEntry('tts', body.providerId)) {
      return apiError('INVALID_REQUEST', 400, '请先保存语音配置，再提交课程语速建模。');
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
    // Settings saves the connection before synthesizing the measured audio.
    // Calibration only adds timing evidence; it must not rewrite credentials,
    // endpoints, default models, or voices from a second request body.
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
