// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { fileTypeFromBuffer } from 'file-type';
import { PDFDocument } from 'pdf-lib';
const mocks = vi.hoisted(() => ({ after: vi.fn(), read: vi.fn(), save: vi.fn(), file: vi.fn(), allowed: vi.fn(), limit: vi.fn(), publish: vi.fn() }));
vi.mock('next/server', async original => ({ ...await original<typeof import('next/server')>(), after: mocks.after }));
vi.mock('@/lib/auth/request-guards', () => ({ requireSameOrigin: () => null, authenticateRequest: async () => ({ claims: { role: 'student', sub: 'student', sv: 7 } }) }));
vi.mock('@/lib/auth/distributed-rate-limit', () => ({ checkDistributedRateLimit: mocks.limit }));
vi.mock('@/lib/db/client', () => ({ isDatabaseConfigured: () => true, prisma: { fileAsset: { findUnique: mocks.file } } }));
vi.mock('@/lib/realtime/event-bus', () => ({ publishCourseEvent: mocks.publish }));
vi.mock('@/lib/showcase/recommendation-service', () => ({ enqueueShowcaseRecommendationForStudent: vi.fn() }));
vi.mock('@/lib/showcase/artifact-upload', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/showcase/artifact-upload')>()), readArtifactUploadReceipt: mocks.read, persistArtifactUpload: mocks.save, canReadArtifactCourse: mocks.allowed,
}));
import { enqueueShowcaseRecommendationForStudent } from '@/lib/showcase/recommendation-service';
import { ArtifactUploadError } from '@/lib/showcase/artifact-upload';
let POST: typeof import('./route').POST;
let directory: string;
const key = 'ab6f6561-c2fc-4639-a617-84958deaf4c1';
const response = { ok: true, versionId: 'version', sequence: 1, submittedAt: '2026-09-26T00:00:00Z', uploadId: 'upload', kind: 'file', mimeType: 'text/plain', requestId: key };
const context = { params: Promise.resolve({ courseId: 'course' }) };
function request(name = 'work.txt', bytes: BlobPart = 'retained work') {
  const body = new FormData(); body.set('file', new File([bytes], name)); body.set('requestId', key);
  return new Request('http://localhost/api/courses/course/showcase/artifacts/pdf', { method: 'POST', body });
}
function timedPhases(result: Response) {
  return result.headers.get('server-timing')!.split(', ').map(part => {
    const match = /^([a-z_]+);dur=(\d+\.\d+)$/.exec(part);
    expect(match, part).not.toBeNull();
    expect(Number(match![2])).toBeGreaterThanOrEqual(0);
    return match![1];
  });
}
describe('local artifact upload route', () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'openpbl-artifact-route-'));
    vi.stubEnv('UPLOAD_DIR', directory);
    ({ POST } = await import('./route'));
  });
  afterAll(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
  beforeEach(() => {
    vi.clearAllMocks(); mocks.read.mockResolvedValue(null); mocks.file.mockResolvedValue(null); mocks.allowed.mockResolvedValue(true);
    mocks.limit.mockResolvedValue({ allowed: true }); mocks.publish.mockResolvedValue(undefined);
    mocks.save.mockResolvedValue({ response, duplicate: false, courseVersion: 2, eventCursor: 'cursor' });
  });
  afterEach(async () => {
    for (const file of await readdir(directory)) await unlink(path.join(directory, file));
    vi.restoreAllMocks();
  });
  it('keeps strict authentication before POST and every automatic/unsupported method', async () => {
    const prior = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'artifact-boundary-secret-at-least-thirty-two-bytes';
    try {
      const routes = await import('./route');
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'] as const) {
        expect((await routes[method](new Request('http://localhost/api/courses/course/showcase/artifacts/pdf', { method }))).status).toBe(401);
      }
      expect((await POST(request(), context)).status).toBe(401);
      expect(mocks.allowed).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prior;
    }
  });
  it('keeps 201 for a new upload and 200 for an owned replay, with the complete original receipt', async () => {
    const first = await POST(request(), context);
    expect(first.status).toBe(201); expect(await first.json()).toEqual(response);
    expect(timedPhases(first)).toEqual(['authentication', 'authorization', 'form', 'file', 'validation', 'receipt', 'rate_limit', 'commit', 'notification']);
    mocks.read.mockResolvedValue(response);
    const replay = await POST(request(), context);
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(response);
    expect(timedPhases(replay)).toEqual(['authentication', 'authorization', 'form', 'file', 'validation', 'receipt']);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ sessionVersion: 7 });
    expect(mocks.read.mock.calls[0][0]).toMatchObject({ sessionVersion: 7 });
  });
  it('returns a conflict after checking the complete digest and cleans its unregistered staging file', async () => {
    mocks.read.mockRejectedValue(new ArtifactUploadError('ARTIFACT_REQUEST_CONFLICT', 'conflict', 409));
    const result = await POST(request(), context);
    expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ code: 'ARTIFACT_REQUEST_CONFLICT' });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it('checks current read authorization before replaying a committed receipt', async () => {
    mocks.allowed.mockResolvedValue(false); mocks.read.mockResolvedValue(response);
    expect((await POST(request(), context)).status).toBe(403);
    expect(mocks.allowed).toHaveBeenCalledWith('student', 'course');
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('returns retryable course contention without acknowledging an uncommitted upload', async () => {
    mocks.save.mockRejectedValue(new ArtifactUploadError('COURSE_BUSY', 'busy', 503));
    const result = await POST(request(), context);
    expect(result.status).toBe(503); expect(await result.json()).toMatchObject({ code: 'COURSE_BUSY' });
    const location = path.join(directory, mocks.save.mock.calls[0][0].storageKey);
    await expect(readFile(location)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a session revoked during parsing before returning an old receipt', async () => {
    mocks.read.mockRejectedValue(new ArtifactUploadError('FORBIDDEN', 'session revoked', 403));
    expect((await POST(request(), context)).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('removes only the new staged file when locked authorization observes a revoked session', async () => {
    mocks.save.mockRejectedValue(new ArtifactUploadError('FORBIDDEN', 'session revoked', 403));
    expect((await POST(request(), context)).status).toBe(403);
    const location = path.join(directory, mocks.save.mock.calls[0][0].storageKey);
    await expect(readFile(location)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves committed bytes when the database acknowledgement is lost', async () => {
    mocks.save.mockRejectedValue(new Error('lost commit acknowledgement')); mocks.file.mockResolvedValue({ id: 'committed' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await POST(request(), context)).status).toBe(500);
    const location = path.join(directory, mocks.save.mock.calls[0][0].storageKey);
    expect(await readFile(location, 'utf8')).toBe('retained work');
  });
  it('cleans only its own staged file when a concurrent request already committed', async () => {
    mocks.save.mockResolvedValue({ response, duplicate: true });
    const replay = await POST(request(), context);
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(response);
    expect(timedPhases(replay)).toEqual(['authentication', 'authorization', 'form', 'file', 'validation', 'receipt', 'rate_limit', 'commit', 'file_cleanup']);
    const location = path.join(directory, mocks.save.mock.calls[0][0].storageKey);
    await expect(readFile(location)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains the file whitelist and 100 MiB limit', async () => {
    expect((await POST(request('program.exe'), context)).status).toBe(415);
    const body = new FormData(); const oversized = new File(['small actual fixture'], 'work.txt');
    Object.defineProperty(oversized, 'size', { value: 100 * 1024 * 1024 + 1 });
    body.set('file', oversized);
    const large = request(); vi.spyOn(large, 'formData').mockResolvedValue(body);
    expect((await POST(large, context)).status).toBe(413);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('hashes the entire stream without invoking File.arrayBuffer and retains only the committed bytes', async () => {
    const bytes = new Uint8Array(180_001).fill(65); bytes[bytes.length - 1] = 66;
    const file = new File([bytes], 'work.txt');
    const materialize = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('no full materialization'));
    const body = new FormData(); body.set('file', file); body.set('requestId', key);
    const actual = request(); vi.spyOn(actual, 'formData').mockResolvedValue(body);
    expect((await POST(actual, context)).status).toBe(201);
    expect(materialize).not.toHaveBeenCalled();
    const saved = mocks.save.mock.calls[0][0];
    expect(saved.size).toBe(bytes.length); expect(saved.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await readFile(path.join(directory, saved.storageKey))).toEqual(Buffer.from(bytes));
    expect(await readdir(directory)).toEqual([saved.storageKey]);
  });

  it('rejects a NUL in the last chunk and mismatched binary signatures without registering or retaining files', async () => {
    const bytes = new Uint8Array(130_001).fill(65); bytes[bytes.length - 1] = 0;
    for (const input of [request('work.txt', bytes), request('work.pdf', 'this is not PDF')]) {
      const result = await POST(input, context);
      expect(result.status).toBe(415); expect(await result.json()).toMatchObject({ code: 'FILE_SIGNATURE_MISMATCH' });
      expect(await readdir(directory)).toEqual([]);
    }
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(['pdf', 'png', 'zip', 'docx', 'pptx', 'xlsx'])('preserves complete %s signature detection and uploaded-byte fingerprints', async extension => {
    let bytes: Uint8Array<ArrayBuffer>;
    if (extension === 'pdf') bytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
    else if (extension === 'png') bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    else {
      const zip = new JSZip(); zip.file('payload.txt', 'retained original content');
      if (extension !== 'zip') {
        const subtype = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
          pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' }[extension];
        zip.file('[Content_Types].xml', `<Types><Override ContentType="${subtype}"/></Types>`);
      }
      bytes = Uint8Array.from(await zip.generateAsync({ type: 'uint8array' }));
    }
    const oldDetection = await fileTypeFromBuffer(bytes);
    expect([extension, 'zip']).toContain(oldDetection?.ext);
    const result = await POST(request(`work.${extension}`, bytes), context);
    expect(result.status).toBe(201);
    const saved = mocks.save.mock.calls[0][0];
    expect(saved.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(saved.size).toBe(bytes.byteLength);
    expect(await readFile(path.join(directory, saved.storageKey))).toEqual(Buffer.from(bytes));
  });

  it('accepts a complete two-page PDF through the real staged-file detector', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([960, 540]); pdf.addPage([960, 540]);
    const bytes = await pdf.save();
    const result = await POST(request('two-page-evidence.pdf', new Uint8Array(bytes).buffer), context);
    expect(result.status).toBe(201);
    const saved = mocks.save.mock.calls[0][0];
    expect(saved.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const stored = await readFile(path.join(directory, saved.storageKey));
    expect(stored).toEqual(Buffer.from(bytes));
    expect((await PDFDocument.load(stored)).getPageCount()).toBe(2);
  });

  it.each(['failure', 'hang'])('returns a committed PDF before optional recommendation %s', async failure => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(enqueueShowcaseRecommendationForStudent).mockImplementationOnce(() => failure === 'failure'
      ? Promise.reject(new Error('optional queue unavailable')) : new Promise(() => {}));
    const result = await POST(request('report.pdf', new Uint8Array(await pdf.save()).buffer), context);
    expect(result.status).toBe(201); expect(await result.json()).toMatchObject({ ok: true });
    expect(enqueueShowcaseRecommendationForStudent).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalledOnce();
    const background = mocks.after.mock.calls[0][0]();
    if (failure === 'failure') await background;
    expect(mocks.file).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('preserves committed bytes when both commit acknowledgement and subsequent ownership lookup fail', async () => {
    mocks.save.mockRejectedValue(new Error('lost acknowledgement')); mocks.file.mockRejectedValue(new Error('database unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await POST(request(), context)).status).toBe(500);
    const saved = mocks.save.mock.calls[0][0];
    expect(await readFile(path.join(directory, saved.storageKey), 'utf8')).toBe('retained work');
  });

  it('removes unregistered files on rate-limit and invalid idempotency-header returns', async () => {
    mocks.limit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    expect((await POST(request(), context)).status).toBe(429);
    expect(await readdir(directory)).toEqual([]);
    const invalid = request(); invalid.headers.set('idempotency-key', 'not-a-uuid');
    expect((await POST(invalid, context)).status).toBe(400);
    expect(await readdir(directory)).toEqual([]);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('retains new committed bytes when realtime notification fails', async () => {
    mocks.publish.mockRejectedValue(new Error('notification offline'));
    expect((await POST(request(), context)).status).toBe(201);
    const saved = mocks.save.mock.calls[0][0];
    expect(await readFile(path.join(directory, saved.storageKey), 'utf8')).toBe('retained work');
    expect(mocks.file).not.toHaveBeenCalled();
  });

  it('rejects incomplete File streams before receipt lookup or database mutation', async () => {
    const file = new File(['short'], 'work.txt'); Object.defineProperty(file, 'size', { value: 6 });
    const body = new FormData(); body.set('file', file); body.set('requestId', key);
    const actual = request(); vi.spyOn(actual, 'formData').mockResolvedValue(body);
    const result = await POST(actual, context);
    expect(result.status).toBe(400); expect(await result.json()).toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
    expect(await readdir(directory)).toEqual([]);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it('treats changed tail bytes under the original request ID as different input and retains the first file', async () => {
    const bytes = new Uint8Array(130_001).fill(65);
    expect((await POST(request('work.txt', bytes), context)).status).toBe(201);
    const first = mocks.save.mock.calls[0][0];
    mocks.read.mockRejectedValue(new ArtifactUploadError('ARTIFACT_REQUEST_CONFLICT', 'changed input', 409));
    bytes[bytes.length - 1] = 66;
    expect((await POST(request('work.txt', bytes), context)).status).toBe(409);
    const retry = mocks.read.mock.calls.at(-1)![0];
    expect(retry.requestId).toBe(first.requestId); expect(retry.sha256).not.toBe(first.sha256);
    expect(await readdir(directory)).toEqual([first.storageKey]);
    expect((await readFile(path.join(directory, first.storageKey))).at(-1)).toBe(65);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});
