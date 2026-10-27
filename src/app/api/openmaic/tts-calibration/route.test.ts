// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signStudentToken, signTeacherToken } from '@/lib/auth/session';

const mocks = vi.hoisted(() => ({ get: vi.fn(), merge: vi.fn(), save: vi.fn(), currentVersion: vi.fn() }));
vi.mock('@/lib/auth/session-version', () => ({ hasCurrentSessionVersion: mocks.currentVersion }));
vi.mock('@/lib/openmaic-bridge/provider-config-editor', () => ({
  getProviderEntry: mocks.get, mergeProviderTtsTimingCalibration: mocks.merge, saveProviderEntry: mocks.save,
}));
import { POST } from './route';

let teacherCookie: string;
let studentCookie: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('JWT_SECRET', 'calibration-route-test-secret-'.repeat(3));
  vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost');
  mocks.currentVersion.mockResolvedValue(true);
  mocks.get.mockResolvedValue({ apiKey: 'synthetic-retained-key', baseUrl: 'https://speech.example' });
  mocks.merge.mockImplementation(async (_providerId, sample) => ({ ...sample, sampleCount: 2 }));
  const teacher = await signTeacherToken({ teacherId: 'teacher', username: 'teacher', displayName: 'Teacher', sessionVersion: 1 });
  const student = await signStudentToken({ userId: 'student', studentName: 'Student', sessionVersion: 1 });
  teacherCookie = `${teacher.cookieName}=${teacher.token}`;
  studentCookie = `${student.cookieName}=${student.token}`;
});
afterEach(() => vi.unstubAllEnvs());

function request(body: Record<string, unknown> = {}, cookie = teacherCookie, origin = 'http://localhost') {
  return new NextRequest('http://localhost/api/openmaic/tts-calibration', {
    method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'openai-tts', modelId: 'tts-model', voiceId: 'alloy',
      text: '这是一段用于课程语速测量的合成讲稿。', measuredDurationSec: 8, ...body }),
  });
}

describe('teacher TTS calibration boundary', () => {
  it.each(['anonymous', 'student', 'revoked teacher'])('rejects %s before reading or changing shared configuration', async (actor) => {
    if (actor === 'revoked teacher') mocks.currentVersion.mockResolvedValue(false);
    const cookie = actor === 'anonymous' ? '' : actor === 'student' ? studentCookie : teacherCookie;
    expect((await POST(request({}, cookie))).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('rejects cross-origin writes even with a current teacher cookie', async () => {
    expect((await POST(request({}, teacherCookie, 'https://other.example'))).status).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('stores measured timing without overwriting the already saved connection or scenario defaults', async () => {
    const response = await POST(request({ apiKey: 'untrusted-replacement', baseUrl: 'https://different.example', models: ['other-model'] }));
    expect(response.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith('tts', 'openai-tts');
    expect(mocks.merge).toHaveBeenCalledWith('openai-tts', expect.objectContaining({
      providerId: 'openai-tts', modelId: 'tts-model', voiceId: 'alloy', measuredDurationSec: 8,
    }));
    expect(mocks.merge.mock.calls[0][1]).not.toHaveProperty('apiKey');
    expect(mocks.merge.mock.calls[0][1]).not.toHaveProperty('baseUrl');
    expect(mocks.save).not.toHaveBeenCalled();
    expect((await response.json()).calibration.sampleCount).toBe(2);
  });

  it('requires the connection save used by the settings audio test to have completed', async () => {
    mocks.get.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(400);
    expect(mocks.merge).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([{ providerId: '__proto__' }, { measuredDurationSec: -1 }])('rejects malformed calibration without touching configuration: %j', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
  });
});
