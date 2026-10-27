import { encodeEventCursor } from '@/lib/realtime/event-cursor';
const receiptCursor = encodeEventCursor({ createdAt: new Date('2026-10-16T00:00:00.000Z'), id: '11111111-1111-4111-8111-111111111111' });
import { useEffect, useState } from "react";
import { useCodeDraft } from "@/components/views/student/use-code-draft";
import { documentDraftKey, readDocumentDrafts, writeDocumentDraft } from "@/lib/browser/document-draft";
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { SessionProvider, useSession } from './store';
import { readSubmissionSaves, retainSubmissionSave, type SubmissionAction } from '@/lib/browser/submission-save-outbox';
import type { ClassroomSubmission } from './types';
import type { ActionEnvelope } from '@/lib/courses/contracts';
import { getStagesForSystemMode } from '@/lib/system-mode';
const navigation = vi.hoisted(() => ({ pathname: '/student/ai-collaboration/course' }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
let api: ReturnType<typeof useSession>;
function Probe() { const session = useSession(); useEffect(() => { api = session; }, [session]); return <span data-testid="save">{session.saveState}</span>; }
const course = { id: 'course', name: '课堂', status: 'teaching', version: 1, updatedAt: '2026-10-16T00:00:00Z', students: [], stages: [], currentStageIndex: 0, resources: [], groups: [], submissions: [], activityLog: [], uiState: {}, content: { lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } } };
const submission: ClassroomSubmission = { id: 'draft', courseId: 'course', studentId: 'student', studentName: '学生', stageKey: 'make', type: 'document', title: '成果', content: 'hello', status: 'draft', version: 1, createdAt: 'now', updatedAt: 'now' };
type Envelope = { requestId: string; action: SubmissionAction };
const action: SubmissionAction = { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course', expectedSubmissionVersion: 0, submission } };
function mockServer(send: (body: Envelope) => Promise<Response> | Response, studentId = 'student', role: 'student' | 'teacher' = 'student') {
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.endsWith('/actions')) return Promise.resolve(send(JSON.parse(String(options?.body))));
    if (url.startsWith('/api/courses?')) return Promise.resolve(Response.json({ courses: [course], user: { role, name: role === 'student' ? '学生' : '教师' }, studentId, joinedCourseId: 'course', updatedAt: course.updatedAt }));
    throw new Error(`Unexpected ${url}`);
  }));
}
async function mount() { const view = render(<SessionProvider><Probe /></SessionProvider>); await waitFor(() => expect(api.hydrated).toBe(true)); return view; }
const input = (content = 'hello') => ({ ...submission, content, expectedVersion: 0, draftKey: 'editor' });
const ack = (body: Envelope, version = 1) => Response.json({ requestId: body.requestId, courseVersion: version + 1, submissionVersion: version, eventCursor: receiptCursor });
beforeEach(() => { localStorage.clear(); navigation.pathname = '/student/ai-collaboration/course'; window.history.replaceState({}, '', navigation.pathname); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
it('recovers a failed teacher activity after projection succeeds and permits a saved classroom finish', async () => {
  navigation.pathname = '/teacher/teach/course/classroom';
  window.history.replaceState({}, '', navigation.pathname);
  const projection = { classroomId: 'lecture', sceneId: 'scene', stageKey: 'ai-learning', title: '能量守恒', sceneType: 'slide' as const, startedAt: course.updatedAt };
  const sent: ActionEnvelope[] = [];
  let rejectActivity = true;
  let version = 1;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith('/api/courses?')) return Response.json({ courses: [{ ...course, stages: getStagesForSystemMode(), currentStageIndex: 1, stageVersion: 7 }], user: { role: 'teacher', name: '教师' }, updatedAt: course.updatedAt });
    if (url.endsWith('/actions')) {
      const envelope = JSON.parse(String(options?.body)) as ActionEnvelope;
      sent.push(envelope);
      if (envelope.action.type === 'ADD_ACTIVITY' && rejectActivity) return Response.json({ code: 'FORBIDDEN_ACTION', message: '无权执行此操作' }, { status: 403 });
      version++;
      return Response.json({ requestId: envelope.requestId, courseVersion: version, eventCursor: receiptCursor,
        ...(envelope.action.type === 'SET_UI_STATE' ? { projection: {
          courseId: course.id, courseVersion: version, projectionVersion: 1, projectionUpdatedAt: course.updatedAt,
          serverTime: course.updatedAt, resourceProjection: null, teacherResourceProjection: projection,
        } } : {}),
      });
    }
    throw new Error(`Unexpected ${url}`);
  }));
  await mount();
  act(() => api.setUiState(course.id, { teacherResourceProjection: projection }));
  await waitFor(() => expect(api.getCourse(course.id)?.uiState?.projectionVersion).toBe(1));
  expect(sent[0].action).toMatchObject({ type: 'SET_UI_STATE', payload: { projectionControl: { baseStageVersion: 7, stageKey: 'ai-learning' } } });
  act(() => api.addActivity(course.id, '投屏知识讲授历史页面', projection.title));
  await waitFor(() => expect(api.saveState).toBe('error'));
  expect(await api.flushSaves()).toBe(false);
  expect(api.getCourse(course.id)?.uiState?.teacherResourceProjection?.sceneId).toBe('scene');
  expect(api.saveError).toBe('无权执行此操作');
  const failed = sent.find(item => item.action.type === 'ADD_ACTIVITY')!;
  rejectActivity = false;
  await act(async () => { await api.retrySave(); });
  expect(sent.filter(item => item.action.type === 'ADD_ACTIVITY')).toEqual([failed, failed]);
  expect(api.saveState).toBe('saved');
  expect(api.saveError).toBeUndefined();
  expect(await api.flushSaves()).toBe(true);
  expect(api.getCourse(course.id)?.activityLog?.filter(item => item.id === (failed.action as Extract<ActionEnvelope['action'], { type: 'ADD_ACTIVITY' }>).payload.activity.id)).toHaveLength(1);
  await act(async () => { api.endTeaching(course.id); await api.flushSaves(); });
  expect(sent.at(-1)?.action.type).toBe('END_TEACHING');
  expect(api.getCourse(course.id)?.status).toBe('finished');
  expect(api.saveState).toBe('saved');
  expect(await api.flushSaves()).toBe(true);
});
it('keeps the original projection stage token when a transport retry arrives after a stage change', async () => {
  navigation.pathname = '/teacher/teach/course/classroom';
  window.history.replaceState({}, '', navigation.pathname);
  const sent: ActionEnvelope[] = [];
  let stageIndex = 0;
  let stageVersion = 7;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith('/api/courses?') || url.endsWith('/state')) return Response.json({ courses: [{ ...course, stages: getStagesForSystemMode(), currentStageIndex: stageIndex, stageVersion }], user: { role: 'teacher', name: '教师' }, updatedAt: course.updatedAt });
    if (url.endsWith('/actions')) {
      const envelope = JSON.parse(String(options?.body)) as ActionEnvelope;
      sent.push(envelope);
      if (envelope.action.type === 'SET_UI_STATE') {
        if (sent.filter(item => item.action.type === 'SET_UI_STATE').length === 1) throw new Error('network unavailable');
        return Response.json({ code: 'CLASSROOM_STAGE_CONFLICT', message: '课堂阶段已变化' }, { status: 409 });
      }
      stageIndex = 3; stageVersion = 8;
      return Response.json({ requestId: envelope.requestId, courseVersion: 2, stageVersion, eventCursor: receiptCursor });
    }
    throw new Error(`Unexpected ${url}`);
  }));
  await mount();
  act(() => api.setUiState(course.id, { resourceProjection: { resourceId: 'video', stageKey: 'launch', title: '项目视频', startedAt: course.updatedAt } }));
  await waitFor(() => expect(sent.filter(item => item.action.type === 'SET_UI_STATE')).toHaveLength(1));
  await act(async () => { api.setStage(course.id, 3); await api.flushSaves(); });
  await waitFor(() => expect(sent.filter(item => item.action.type === 'SET_UI_STATE')).toHaveLength(2));
  const attempts = sent.filter(item => item.action.type === 'SET_UI_STATE');
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[1].action).toMatchObject({ payload: { projectionControl: { baseStageVersion: 7, stageKey: 'launch' } } });
  expect(api.getCourse(course.id)?.currentStageIndex).toBe(3);
});
it.each(['code', 'document'] as const)('keeps %s save diagnostics and retry without an overlapping workspace toast', async (type) => {
  vi.mocked(toast.error).mockClear();
  const sent: Envelope[] = [];
  let failing = true;
  const reason = '服务器暂时无法保存，草稿仍保留在本机。';
  mockServer(body => { sent.push(body); return failing
    ? Response.json({ code: 'SAVE_UNAVAILABLE', message: reason }, { status: 400 }) : ack(body); });
  await mount();
  await act(async () => { expect(await api.persistSubmission({ ...input(), type })).toBeUndefined(); });
  expect(api.saveState).toBe('error');
  expect(api.saveError).toBe(reason);
  expect(readSubmissionSaves('student', 'course')).toHaveLength(1);
  await act(async () => { await api.retrySave(); });
  expect(api.saveState).toBe('error');
  expect(api.saveError).toBe(reason);
  expect(toast.error).not.toHaveBeenCalledWith('课堂数据尚未保存', expect.anything());
  failing = false;
  await act(async () => { await api.retrySave(); });
  expect(sent).toHaveLength(3);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[2]).toEqual(sent[0]);
  expect(api.saveState).toBe('saved');
  expect(api.saveError).toBeUndefined();
  expect(readSubmissionSaves('student', 'course')).toHaveLength(0);
});
it.each([
  ['student', '/student/classroom/course'],
  ['teacher', '/teacher/teach/course/classroom'],
] as const)('retains the save failure toast on other %s pages', async (role, pathname) => {
  vi.mocked(toast.error).mockClear();
  navigation.pathname = pathname;
  window.history.replaceState({}, '', pathname);
  const reason = '保存服务暂时不可用';
  mockServer(() => Response.json({ code: 'SAVE_UNAVAILABLE', message: reason }, { status: 400 }), 'student', role);
  await mount();
  act(() => api.updateCourse('course', { name: '待保存的课程名称' }));
  await waitFor(() => expect(api.saveState).toBe('error'));
  expect(api.saveError).toBe(reason);
  expect(toast.error).toHaveBeenCalledWith('课堂数据尚未保存', { id: 'session-write-error', description: reason });
});
it('replays a committed request after a lost response and remount using the identical request and action', async () => {
  const sent: Envelope[] = [];
  mockServer(body => { sent.push(body); return Response.json({ code: 'RESPONSE_LOST', message: 'response lost' }, { status: 400 }); });
  const view = await mount();
  await act(async () => { expect(await api.persistSubmission(input())).toBeUndefined(); });
  const pending = readSubmissionSaves('student', 'course');
  expect(pending).toHaveLength(1);
  view.unmount();
  mockServer(body => { sent.push(body); return ack(body); });
  await mount();
  await waitFor(() => expect(readSubmissionSaves('student', 'course')).toHaveLength(0));
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(screen.getByTestId('save').textContent).toBe('saved');
});
it('reconciles an identical server revision without overwriting it and returns its canonical identity', async () => {
  const remote = { ...submission, id: 'server-id', version: 1 };
  const send = vi.fn(() => Response.json({ code: 'DRAFT_VERSION_CONFLICT', details: { currentVersion: 1, currentSubmission: remote } }, { status: 409 }));
  mockServer(send); await mount();
  await act(async () => { expect(await api.persistSubmission(input())).toEqual(remote); });
  expect(send).toHaveBeenCalledTimes(1);
  expect(api.submissionSaveConflicts).toHaveLength(0);
  expect(readSubmissionSaves('student', 'course')).toHaveLength(0);
});
it('retains both conflicting versions and only adopts local content with a new request and explicit current baseline', async () => {
  const sent: Envelope[] = [];
  const remote = { ...submission, content: 'other window', version: 2 };
  mockServer(body => { sent.push(body); return sent.length === 1
    ? Response.json({ code: 'DRAFT_VERSION_CONFLICT', details: { currentVersion: 2, currentSubmission: remote } }, { status: 409 }) : ack(body, 3); });
  await mount(); await act(async () => { await api.persistSubmission(input()); });
  expect(api.submissionSaveConflicts).toHaveLength(1);
  await act(async () => { await api.retrySave(); });
  expect(sent).toHaveLength(1);
  await act(async () => { expect(await api.resolveSubmissionSaveConflict(sent[0].requestId, 'local', 'latest local edit')).toMatchObject({ content: 'latest local edit', version: 3 }); });
  expect(sent[1].requestId).not.toBe(sent[0].requestId);
  expect(sent[1].action.payload.expectedSubmissionVersion).toBe(2);
  expect(readSubmissionSaves('student', 'course')).toMatchObject([{ state: 'resolved', remote: { content: 'other window' }, action: { payload: { submission: { content: 'hello' } } } }]);
});
it('does not erase an earlier failure when another operation succeeds; retry shares the serial queue', async () => {
  const sent: Envelope[] = [];
  let release!: (value: Response) => void;
  let fail = true;
  mockServer(body => { sent.push(body); if (body.action.payload.submission.content === 'hello' && fail) return Response.json({ code: 'INVALID_ACTION' }, { status: 400 });
    if (body.action.payload.submission.content === 'second') return new Promise(resolve => { release = resolve; });
    return ack(body); });
  await mount(); await act(async () => { await api.persistSubmission(input()); });
  let second!: Promise<ClassroomSubmission | undefined>;
  act(() => { second = api.persistSubmission({ ...input('second'), id: 'another', stageKey: 'proposal' }); });
  await waitFor(() => expect(sent).toHaveLength(2));
  fail = false;
  let retry!: Promise<void>;
  act(() => { retry = api.retrySave(); });
  expect(sent).toHaveLength(2);
  await act(async () => { release(ack(sent[1])); await second; await retry; });
  expect(sent).toHaveLength(3);
  expect(sent[2].requestId).toBe(sent[0].requestId);
  expect(await api.flushSaves()).toBe(true);
});
it('keeps aggregate error after unrelated success until the failed action is recovered', async () => {
  mockServer(body => body.action.payload.submission.content === 'hello' ? Response.json({ code: 'INVALID_ACTION' }, { status: 400 }) : ack(body));
  await mount(); await act(async () => { await api.persistSubmission(input()); await api.persistSubmission({ ...input('second'), id: 'other', stageKey: 'proposal' }); });
  expect(api.saveState).toBe('error'); expect(await api.flushSaves()).toBe(false);
});
it('does not send a draft when durable storage fails', async () => {
  const send = vi.fn(ack); mockServer(send); await mount();
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key.startsWith('openpbl:submission-save:')) throw new DOMException('Quota exceeded'); original.call(this, key, value); });
  await act(async () => { await api.persistSubmission(input()); });
  expect(send).not.toHaveBeenCalled(); expect(api.saveError).toContain('浏览器无法保存');
});
it('does not replay another student or classroom records after authentication', async () => {
  retainSubmissionSave({ requestId: 'old-request', actorId: 'student', action, createdAt: 1, state: 'pending' });
  const send = vi.fn(ack); mockServer(send, 'other-student'); await mount();
  expect(send).not.toHaveBeenCalled(); expect(readSubmissionSaves('student', 'course')).toHaveLength(1);
});
it('replays the old receipt before submitting a newer edit based on that pending draft', async () => {
  retainSubmissionSave({ requestId: 'original-request', actorId: 'student', draftKey: 'editor', action, createdAt: 1, state: 'pending' });
  const sent: Envelope[] = [];
  let release!: (response: Response) => void;
  mockServer(body => { sent.push(body); return body.requestId === 'original-request'
    ? new Promise(resolve => { release = resolve; }) : ack(body, 2); });
  await mount(); await waitFor(() => expect(sent).toHaveLength(1));
  let saved!: Promise<ClassroomSubmission | undefined>;
  act(() => { saved = api.persistSubmission(input('newer edit')); });
  expect(sent).toHaveLength(1);
  await act(async () => { release(ack(sent[0])); expect(await saved).toMatchObject({ content: 'newer edit', version: 2 }); });
  expect(sent).toHaveLength(2);
  expect(sent[1].action.payload.expectedSubmissionVersion).toBe(1);
});
it('adopts the remote revision without writing and retains the local conflict copy', async () => {
  const remote = { ...submission, content: 'server', version: 4 };
  const send = vi.fn(() => Response.json({ code: 'DRAFT_VERSION_CONFLICT', details: { currentVersion: 4, currentSubmission: remote } }, { status: 409 }));
  mockServer(send); await mount(); await act(async () => { await api.persistSubmission(input()); });
  await act(async () => { expect(await api.resolveSubmissionSaveConflict(api.submissionSaveConflicts[0].requestId, 'remote')).toEqual(remote); });
  expect(send).toHaveBeenCalledTimes(1); expect(api.saveState).toBe('saved');
  expect(readSubmissionSaves('student', 'course')).toMatchObject([{ state: 'resolved', action: { payload: { submission: { content: 'hello' } } } }]);
});
it('a late receipt cannot overwrite a newer optimistic edit already queued for the same submission', async () => {
  const sent: Envelope[] = [];
  const releases: Array<(response: Response) => void> = [];
  mockServer(body => { sent.push(body); return new Promise(resolve => releases.push(resolve)); });
  await mount();
  act(() => { api.upsertSubmission(input()); });
  await waitFor(() => expect(sent).toHaveLength(1));
  act(() => { api.upsertSubmission(input('newest')); });
  await act(async () => { releases[0](ack(sent[0])); });
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(api.courses[0].submissions?.find(item => item.id === 'draft')?.content).toBe('newest');
  await act(async () => { releases[1](ack(sent[1], 2)); await api.flushSaves(); });
});
it('advances the recovered editor baseline even when receipt replay finished before the next edit', async () => {
  retainSubmissionSave({ requestId: 'original-request', actorId: 'student', draftKey: 'editor', action, createdAt: 1, state: 'pending' });
  const sent: Envelope[] = [];
  mockServer(body => { sent.push(body); return ack(body, sent.length); });
  await mount(); await waitFor(() => expect(readSubmissionSaves('student', 'course')).toHaveLength(0));
  await act(async () => { await api.persistSubmission(input('next edit')); });
  expect(sent[1].action.payload.expectedSubmissionVersion).toBe(1);
});
it('never borrows a recovered version from a different editor even for the same submission ID', async () => {
  retainSubmissionSave({ requestId: 'other-editor-request', actorId: 'student', draftKey: 'other-editor', action, createdAt: 1, state: 'pending' });
  const sent: Envelope[] = [];
  mockServer(body => { sent.push(body); return ack(body, sent.length); });
  await mount(); await waitFor(() => expect(readSubmissionSaves('student', 'course')).toHaveLength(0));
  await act(async () => { await api.persistSubmission(input('my independent edit')); });
  expect(sent[1].action.payload.expectedSubmissionVersion).toBe(0);
});
it('advances only a receipt explicitly linked to the restored local draft', async () => {
  retainSubmissionSave({ requestId: 'recovered-request', actorId: 'student', draftKey: 'old-draft-key', action, createdAt: 1, state: 'pending' });
  const sent: Envelope[] = [];
  mockServer(body => { sent.push(body); return ack(body, sent.length); });
  await mount(); await waitFor(() => expect(readSubmissionSaves('student', 'course')).toHaveLength(0));
  await act(async () => { await api.persistSubmission({ ...input('continued edit'), recoveredDraftKey: 'old-draft-key' }); });
  expect(sent[1].action.payload.expectedSubmissionVersion).toBe(1);
});
it('retries pending writes on reconnect with their immutable payload, including caller-owned nested arrays', async () => {
  const sent: Envelope[] = [];
  let available = false;
  mockServer(body => { sent.push(body); return available ? ack(body) : Response.json({ code: 'RESPONSE_LOST' }, { status: 400 }); });
  await mount();
  const files = [{ name: 'original.txt', type: 'text/plain' }];
  await act(async () => { await api.persistSubmission({ ...input(), files }); });
  files[0].name = 'mutated.txt'; available = true;
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await waitFor(() => expect(api.saveState).toBe('saved'));
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
  expect(sent[1].action.payload.submission.files?.[0].name).toBe('original.txt');
});
it('surfaces corrupted owned outbox records and never reports that all writes are confirmed', async () => {
  localStorage.setItem('openpbl:submission-save:v1:student:broken', '{');
  const send = vi.fn(ack); mockServer(send); await mount();
  await waitFor(() => expect(api.saveState).toBe('error'));
  expect(api.saveError).toContain('无法读取'); expect(await api.flushSaves()).toBe(false);
  expect(localStorage.getItem('openpbl:submission-save:v1:student:broken')).toBe('{');
  await act(async () => { await api.persistSubmission(input()); });
  expect(send).not.toHaveBeenCalled();
});
it('does not write an identical restored editor snapshot a second time after its durable receipt is replayed', async () => {
  retainSubmissionSave({ requestId: 'original-request', actorId: 'student', draftKey: 'editor', action, createdAt: 1, state: 'pending' });
  const sent: Envelope[] = [];
  mockServer(body => { sent.push(body); return ack(body); });
  await mount(); await waitFor(() => expect(readSubmissionSaves('student', 'course')).toHaveLength(0));
  await act(async () => { expect(await api.persistSubmission(input())).toMatchObject({ content: 'hello', version: 1 }); });
  expect(sent).toHaveLength(1);
});
it('does not use another editor receipt to silently settle even an identical pending snapshot', async () => {
  retainSubmissionSave({ requestId: 'other-request', actorId: 'student', draftKey: 'different-editor', action, createdAt: 1, state: 'pending' });
  const sent: Envelope[] = [];
  mockServer(body => { sent.push(body); return ack(body, sent.length); });
  await mount(); await waitFor(() => expect(readSubmissionSaves('student', 'course')).toHaveLength(0));
  await act(async () => { await api.persistSubmission(input()); });
  expect(sent).toHaveLength(2); expect(sent[1].action.payload.expectedSubmissionVersion).toBe(0);
});

it('keeps an original durable receipt when another restored request only reconciles the same revision', async () => {
  retainSubmissionSave({ requestId: 'original-receipt', actorId: 'student', draftKey: 'old-editor', action, createdAt: 1, state: 'pending' });
  retainSubmissionSave({ requestId: 'restored-attempt', actorId: 'student', draftKey: 'editor', action, createdAt: 2, state: 'pending' });
  const sent: Envelope[] = [];
  mockServer(body => {
    sent.push(body);
    if (body.requestId === 'original-receipt') return ack(body);
    if (body.requestId === 'restored-attempt') return Response.json({ code: 'DRAFT_VERSION_CONFLICT',
      details: { currentVersion: 1, currentSubmission: submission } }, { status: 409 });
    return ack(body, 2);
  });
  await mount();
  await waitFor(() => expect(readSubmissionSaves('student', 'course')).toHaveLength(0));
  expect(sent).toHaveLength(2);
  await act(async () => { expect(await api.persistSubmission({ ...input(), recoveredDraftKey: 'old-editor' }))
    .toMatchObject({ content: 'hello', version: 1 }); });
  expect(sent.map(body => body.requestId)).toEqual(['original-receipt', 'restored-attempt']);
  expect(await api.flushSaves()).toBe(true);
});
it('does not carry an earlier receipt proof into a different remote revision', async () => {
  retainSubmissionSave({ requestId: 'original-receipt', actorId: 'student', draftKey: 'old-editor', action, createdAt: 1, state: 'pending' });
  retainSubmissionSave({ requestId: 'restored-attempt', actorId: 'student', draftKey: 'editor', action, createdAt: 2, state: 'pending' });
  const sent: Envelope[] = [];
  mockServer(body => {
    sent.push(body);
    if (body.requestId === 'original-receipt') return ack(body);
    if (body.requestId === 'restored-attempt') return Response.json({ code: 'DRAFT_VERSION_CONFLICT',
      details: { currentVersion: 2, currentSubmission: { ...submission, version: 2 } } }, { status: 409 });
    return ack(body, 3);
  });
  await mount();
  await waitFor(() => expect(readSubmissionSaves('student', 'course')).toHaveLength(0));
  await act(async () => { expect(await api.persistSubmission({ ...input(), recoveredDraftKey: 'old-editor' }))
    .toMatchObject({ content: 'hello', version: 3 }); });
  expect(sent).toHaveLength(3);
  expect(sent[2].action.payload.expectedSubmissionVersion).toBe(2);
});

it.each([
  ['wrong request', (body: Envelope) => ({ requestId: `${body.requestId}-other` }), 200],
  ['missing cursor', () => ({ eventCursor: undefined }), 200],
  ['malformed cursor', () => ({ eventCursor: 'not-a-domain-event' }), 200],
  ['missing course version', () => ({ courseVersion: undefined }), 200],
  ['invalid course version', () => ({ courseVersion: 0 }), 200],
  ['missing submission version', () => ({ submissionVersion: undefined }), 200],
  ['wrong baseline revision', () => ({ submissionVersion: 2 }), 200],
  ['fractional revision', () => ({ submissionVersion: 1.5 }), 200],
  ['invalid optional stage', () => ({ stageVersion: -1 }), 200],
  ['unexpected success status', () => ({}), 201],
] as const)('retains the exact pending request after %s and replays it only with a valid ACK', async (_label, patch, status) => {
  const sent: Envelope[] = [];
  let valid = false;
  mockServer(body => {
    sent.push(structuredClone(body));
    return valid ? ack(body) : Response.json({ requestId: body.requestId, courseVersion: 2,
      submissionVersion: 1, eventCursor: receiptCursor, ...patch(body) }, { status });
  });
  await mount();
  await act(async () => { expect(await api.persistSubmission(input())).toBeUndefined(); });
  const pending = readSubmissionSaves('student', 'course');
  expect(pending).toHaveLength(1); expect(pending[0].action).toEqual(sent[0].action);
  expect(api.saveState).toBe('error'); expect(api.lastSavedAt).toBeUndefined();
  expect(await api.flushSaves()).toBe(false);
  valid = true;
  await act(async () => { await api.retrySave(); });
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
  expect(readSubmissionSaves('student', 'course')).toEqual([]);
  expect(api.saveState).toBe('saved'); expect(await api.flushSaves()).toBe(true);
});

it.each([null, {}, [], 'success'])('does not treat malformed successful JSON %j as a save receipt', async malformed => {
  mockServer(() => Response.json(malformed)); await mount();
  await act(async () => { expect(await api.persistSubmission(input())).toBeUndefined(); });
  expect(readSubmissionSaves('student', 'course')).toHaveLength(1);
  expect(api.saveState).toBe('error'); expect(await api.flushSaves()).toBe(false);
});

it('reports an unreadable successful body in Chinese and retains its immutable request', async () => {
  mockServer(() => new Response('{interrupted', { status: 200 })); await mount();
  await act(async () => { expect(await api.persistSubmission(input())).toBeUndefined(); });
  expect(api.saveError).toContain('尚未收到与本次保存匹配的服务器回执');
  expect(readSubmissionSaves('student', 'course')).toHaveLength(1);
  expect(await api.flushSaves()).toBe(false);
});

it('an invalid old ACK cannot erase a newer optimistic edit or its immutable queued operation', async () => {
  const sent: Envelope[] = [];
  let release!: (response: Response) => void;
  mockServer(body => {
    sent.push(structuredClone(body));
    return sent.length === 1 ? new Promise<Response>(resolve => { release = resolve; })
      : ack(body, Number(body.action.payload.expectedSubmissionVersion) + 1);
  });
  await mount();
  let first!: ReturnType<typeof api.persistSubmission>;
  act(() => { first = api.persistSubmission(input('old')); });
  await waitFor(() => expect(sent).toHaveLength(1));
  // upsertSubmission is the synchronous optimistic entrypoint; it uses the same durable queue.
  act(() => { api.upsertSubmission(input('new live edit')); });
  await act(async () => { release(Response.json({ requestId: 'wrong', courseVersion: 2, submissionVersion: 1, eventCursor: receiptCursor })); await first; });
  await waitFor(() => expect(sent).toHaveLength(2));
  await act(async () => { await api.flushSaves(); });
  expect(api.courses.find(item => item.id === 'course')?.submissions?.find(item => item.id === 'draft')?.content).toBe('new live edit');
  expect(readSubmissionSaves('student', 'course')).toMatchObject([{ requestId: sent[0].requestId, action: sent[0].action }]);
  expect(api.saveState).toBe('error'); expect(await api.flushSaves()).toBe(false);
});


for (const originalContent of ['B', 'A'] as const) {
  it(`restores marked A against stale GET A and reconciles original ${originalContent} with no duplicate confirmed version`, async () => {
    const draftScope = 'course:student:make:code:python';
    const originalKey = documentDraftKey(draftScope);
    const oldSnapshot = { ...submission, type: 'code' as const, content: 'A', version: 1 };
    const originalAction: SubmissionAction = { type: 'UPSERT_SUBMISSION', payload: {
      courseId: 'course', expectedSubmissionVersion: 1,
      submission: { ...oldSnapshot, content: originalContent, version: 2 },
    } };
    retainSubmissionSave({ requestId: 'original-durable-request', actorId: 'student',
      draftKey: originalKey, action: originalAction, createdAt: 1, state: 'pending' });
    writeDocumentDraft({ key: originalKey, scope: draftScope, submissionId: 'draft',
      expectedVersion: 1, content: 'A', updatedAt: 1, requiresConfirmation: true });
    const sent: Envelope[] = [];
    let release!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
      if (url.endsWith('/actions')) {
        const body = JSON.parse(String(options?.body)) as Envelope;
        sent.push(body);
        return body.requestId === 'original-durable-request'
          ? new Promise<Response>(resolve => { release = resolve; }) : Promise.resolve(ack(body, 3));
      }
      if (url.startsWith('/api/courses?')) return Promise.resolve(Response.json({
        courses: [{ ...course, submissions: [oldSnapshot] }],
        user: { role: 'student', name: '学生' }, studentId: 'student', joinedCourseId: 'course',
        updatedAt: course.updatedAt,
      }));
      throw new Error(`Unexpected ${url}`);
    }));
    function RecoveredEditor() {
      const session = useSession();
      const [content, setContent] = useState('A');
      const initial = session.courses.find(item => item.id === 'course')?.submissions?.find(item => item.id === 'draft') ?? oldSnapshot;
      const draft = useCodeDraft({ scope: draftScope, content,
        initial: { id: initial.id, version: initial.version ?? 1, content: initial.content },
        enabled: session.hydrated, restore: setContent,
        persist: (value, id, expectedVersion, draftKey, recoveredDraftKey) => session.persistSubmission({
          ...oldSnapshot, id, content: value, expectedVersion, draftKey, recoveredDraftKey,
        }),
      });
      return <span data-testid="recovered-code-status">{content}:{draft.status}</span>;
    }
    render(<SessionProvider><Probe /><RecoveredEditor /></SessionProvider>);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].requestId).toBe('original-durable-request');
    expect(sent[0].action).toEqual(originalAction);
    await act(async () => { release(ack(sent[0], 2)); });
    // The actual hook's existing 900ms debounce runs; no direct save call.
    await waitFor(() => expect(screen.getByTestId('recovered-code-status').textContent).toBe('A:saved'), { timeout: 3000 });
    expect(readSubmissionSaves('student', 'course')).toEqual([]);
    expect(readDocumentDrafts(draftScope)).toEqual([]);
    if (originalContent === 'B') {
      expect(sent).toHaveLength(2);
      expect(sent[1].requestId).not.toBe(sent[0].requestId);
      expect(sent[1].action.payload.expectedSubmissionVersion).toBe(2);
      expect(sent[1].action.payload.submission.content).toBe('A');
    } else {
      // Provider reuses this editor's exact existing durable A receipt.
      expect(sent).toHaveLength(1);
    }
  });
}
