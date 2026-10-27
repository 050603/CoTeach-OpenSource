import type { SessionAction } from '@/lib/session/actions';
import type { ClassroomSubmission } from '@/lib/session/types';

export type SubmissionAction = Extract<SessionAction, { type: 'UPSERT_SUBMISSION' }>;
export type SubmissionSaveRecord = {
  requestId: string;
  actorId: string;
  draftKey?: string;
  action: SubmissionAction;
  createdAt: number;
  state: 'pending' | 'conflict' | 'resolved';
  remote?: ClassroomSubmission;
};
export type SubmissionSaveConflict = SubmissionSaveRecord & { remote: ClassroomSubmission };
const prefix = 'openpbl:submission-save:v1:';
const keyFor = (actorId: string, requestId: string) => `${prefix}${encodeURIComponent(actorId)}:${requestId}`;
const invalidRecord = () => new Error('本机有无法读取的待保存记录，请保留浏览器数据并下载草稿后重试。');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const positiveVersion = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const submissionTypes = new Set(['idea', 'plan', 'document', 'artifact-brief', 'code', 'resource', 'showcase', 'reflection', 'evidence']);
function validSubmission(value: ClassroomSubmission | undefined, actorId: string): value is ClassroomSubmission {
  return Boolean(value && nonempty(value.id) && nonempty(value.courseId) && value.studentId === actorId
    && nonempty(value.stageKey) && submissionTypes.has(value.type) && typeof value.title === 'string'
    && typeof value.content === 'string' && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
    && (value.studentName === undefined || typeof value.studentName === 'string')
    && (value.groupId === undefined || typeof value.groupId === 'string')
    && (value.submittedAt === undefined || typeof value.submittedAt === 'string')
    && (value.status === undefined || ['draft', 'submitted', 'failed'].includes(value.status))
    && (value.version === undefined || positiveVersion(value.version))
    && (value.files === undefined || (Array.isArray(value.files) && value.files.every(file => file
      && typeof file.name === 'string' && typeof file.type === 'string'
      && (file.size === undefined || typeof file.size === 'string') && (file.url === undefined || typeof file.url === 'string')))));
}

export function readSubmissionSaves(actorId: string, courseId: string): SubmissionSaveRecord[] {
  const records: SubmissionSaveRecord[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(`${prefix}${encodeURIComponent(actorId)}:`)) continue;
    let value: SubmissionSaveRecord;
    try { value = JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { throw invalidRecord(); }
    if (!value || value.actorId !== actorId || !nonempty(value.requestId)
      || value.action?.type !== 'UPSERT_SUBMISSION' || !value.action.payload
      || !validSubmission(value.action.payload.submission, actorId)
      || value.action.payload.courseId !== value.action.payload.submission.courseId
      || !Number.isSafeInteger(value.action.payload.expectedSubmissionVersion) || Number(value.action.payload.expectedSubmissionVersion) < 0
      || !Number.isFinite(value.createdAt) || (value.draftKey !== undefined && !nonempty(value.draftKey))
      || key !== keyFor(actorId, value.requestId) || !['pending', 'conflict', 'resolved'].includes(value.state)) throw invalidRecord();
    if (value.state !== 'pending' && (!validSubmission(value.remote, actorId) || !positiveVersion(value.remote.version)
      || value.remote.courseId !== value.action.payload.courseId || value.remote.type !== value.action.payload.submission.type
      || value.remote.stageKey !== value.action.payload.submission.stageKey)) throw invalidRecord();
    if (value.action.payload.courseId === courseId) records.push(value);
  }
  return records.sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId));
}

/** Persist before sending. A request ID can never be reused for a different action or editor. */
export function retainSubmissionSave(record: SubmissionSaveRecord): void {
  const key = keyFor(record.actorId, record.requestId);
  const previous = localStorage.getItem(key);
  const existing = previous ? JSON.parse(previous) : undefined;
  if (existing && (JSON.stringify(existing.action) !== JSON.stringify(record.action) || existing.draftKey !== record.draftKey)) {
    throw new Error('保存请求内容已变化，请保留本机草稿并重新打开页面。');
  }
  localStorage.setItem(key, JSON.stringify({ ...record, createdAt: existing?.createdAt ?? record.createdAt }));
}

export function acknowledgeSubmissionSave(record: SubmissionSaveRecord): void {
  const key = keyFor(record.actorId, record.requestId);
  const current = localStorage.getItem(key);
  if (current && JSON.stringify(JSON.parse(current).action) === JSON.stringify(record.action)) localStorage.removeItem(key);
}

/** Missing identity/revision cannot prove a save; IDs/timestamps otherwise belong to server metadata. */
export function sameSubmissionContent(left: ClassroomSubmission, right: ClassroomSubmission): boolean {
  if (!nonempty(left.studentId) || !validSubmission(left, left.studentId)
    || !validSubmission(right, left.studentId) || !positiveVersion(right.version)) return false;
  const project = (value: ClassroomSubmission) => [value.courseId, value.studentId, value.studentName ?? null, value.groupId ?? null,
    value.stageKey, value.type, value.title, value.content,
    (value.files ?? []).map(file => [file.name, file.type, file.size ?? null, file.url ?? null]),
    value.status ?? 'submitted', value.submittedAt ?? null];
  return JSON.stringify(project(left)) === JSON.stringify(project(right));
}
