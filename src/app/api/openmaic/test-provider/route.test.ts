// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signStudentToken, signTeacherToken } from '@/lib/auth/session';
import { MINERU_CLOUD_DEFAULT_BASE } from '@openmaic/lib/pdf/constants';

const mocks = vi.hoisted(() => ({ get: vi.fn(), currentVersion: vi.fn(), media: vi.fn(), ssrf: vi.fn(), pdf: vi.fn() }));
vi.mock('@/lib/auth/session-version', () => ({ hasCurrentSessionVersion: mocks.currentVersion }));
vi.mock('@/lib/openmaic-bridge/provider-config-editor', () => ({ getProviderEntry: mocks.get }));
vi.mock('@openmaic/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: mocks.ssrf }));
vi.mock('@openmaic/lib/pdf/pdf-providers', () => ({ parsePDF: mocks.pdf }));
vi.mock('@openmaic/lib/media/media-request', () => ({
  fetchMediaRequest: mocks.media,
  mediaGenerationFailure: (message: string) => new Error(message),
}));
import { POST } from './route';

const stored = { apiKey: 'retained-synthetic-image-key', baseUrl: 'https://provider.example/v1', models: ['image-model'] };
let teacherCookie: string;
let studentCookie: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('JWT_SECRET', 'provider-route-test-secret-'.repeat(3));
  vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost');
  vi.stubEnv('NODE_ENV', 'production');
  mocks.currentVersion.mockResolvedValue(true);
  mocks.get.mockResolvedValue(stored);
  mocks.ssrf.mockResolvedValue(null);
  mocks.media.mockImplementation(async () => Response.json({ data: [{ b64_json: 'synthetic-image' }] }));
  mocks.pdf.mockResolvedValue({ text: 'Synthetic PDF parsing result', metadata: { pageCount: 1 } });
  const teacher = await signTeacherToken({ teacherId: 'teacher', username: 'teacher', displayName: 'Teacher', sessionVersion: 1 });
  const student = await signStudentToken({ userId: 'student', studentName: 'Student', sessionVersion: 1 });
  teacherCookie = `${teacher.cookieName}=${teacher.token}`;
  studentCookie = `${student.cookieName}=${student.token}`;
});
afterEach(() => vi.unstubAllEnvs());

function request(body: Record<string, unknown> = {}, cookie = teacherCookie, origin = 'http://localhost') {
  return new NextRequest('http://localhost/api/openmaic/test-provider', {
    method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ section: 'image', providerId: 'openai-image', ...body }),
  });
}

describe('teacher provider diagnostics credential boundary', () => {
  it.each(['anonymous', 'student', 'revoked teacher'])('rejects %s before reading shared credentials or calling a provider', async (actor) => {
    if (actor === 'revoked teacher') mocks.currentVersion.mockResolvedValue(false);
    const cookie = actor === 'anonymous' ? '' : actor === 'student' ? studentCookie : teacherCookie;
    expect((await POST(request({}, cookie))).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.media).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin teacher request before reading credentials', async () => {
    expect((await POST(request({}, teacherCookie, 'https://other.example'))).status).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.media).not.toHaveBeenCalled();
  });

  it('does not forward a retained shared key to a different public endpoint', async () => {
    const response = await POST(request({ baseUrl: 'https://different.example/v1' }));
    expect(response.status).toBe(400);
    expect(mocks.media).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(stored.apiKey);
  });

  it('still generates the teacher diagnostic using a retained key at its saved endpoint', async () => {
    const response = await POST(request({ baseUrl: `${stored.baseUrl}/`, model: 'selected-image' }));
    expect(response.status).toBe(200);
    expect(mocks.media).toHaveBeenCalledWith(`${stored.baseUrl}/images/generations`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${stored.apiKey}` }),
      body: expect.stringContaining('selected-image'),
    }));
    expect(JSON.stringify(await response.json())).not.toContain(stored.apiKey);
  });

  it('accepts the provider catalog endpoint when the saved key uses its default URL', async () => {
    mocks.get.mockResolvedValue({ apiKey: stored.apiKey, models: stored.models });
    expect((await POST(request({ baseUrl: 'https://api.openai.com/v1' }))).status).toBe(200);
    expect(mocks.media).toHaveBeenCalledWith('https://api.openai.com/v1/images/generations', expect.anything());
  });

  it('permits a teacher to explicitly test a new endpoint with a newly supplied key', async () => {
    expect((await POST(request({ baseUrl: 'https://different.example/v1', apiKey: 'new-synthetic-key' }))).status).toBe(200);
    expect(mocks.media).toHaveBeenCalledWith('https://different.example/v1/images/generations', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer new-synthetic-key' }),
    }));
  });

  it('binds a retained MinerU Cloud key to its shared default endpoint without making a PDF network request', async () => {
    mocks.get.mockResolvedValue({ apiKey: 'synthetic-pdf-key' });
    const config = { section: 'pdf', providerId: 'mineru-cloud' };
    expect((await POST(request({ ...config, baseUrl: 'https://different.example/api/v4' }))).status).toBe(400);
    expect(mocks.pdf).not.toHaveBeenCalled();
    expect((await POST(request({ ...config, baseUrl: MINERU_CLOUD_DEFAULT_BASE }))).status).toBe(200);
    expect(mocks.pdf).toHaveBeenCalledWith({ providerId: 'mineru-cloud', apiKey: 'synthetic-pdf-key',
      baseUrl: MINERU_CLOUD_DEFAULT_BASE }, expect.any(Buffer));
  });

  it('retains SSRF validation before a teacher diagnostic reaches the network', async () => {
    mocks.ssrf.mockResolvedValue('Local/private network URLs are not allowed');
    expect((await POST(request({ baseUrl: 'http://127.0.0.1', apiKey: 'new-synthetic-key' }))).status).toBe(403);
    expect(mocks.media).not.toHaveBeenCalled();
  });
});
