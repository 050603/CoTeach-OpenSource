import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertPreparationMediaManifest, assertPreparationWarmupAudio } from './classroom-acceptance-preparation.mjs';

const classroomId = 'acceptance-source';
const hash = value => createHash('sha256').update(value).digest('hex');
const original = [{ path: `${classroomId}.json`, bytes: 2, sha256: hash('{}') },
  { path: `${classroomId}/audio/authored.wav`, bytes: 10, sha256: hash('old speech') }];
const sha256 = hash('new speech');
const added = { path: `${classroomId}/audio/explanation-${sha256}.wav`, bytes: 10, sha256 };
const committed = { id: 'explanation-1', status: 'COMPLETED', input: { classroomId },
  audio: { filename: `explanation-${sha256}.wav`, bytes: 10, audioDurationSec: 1 } };

test('concurrent committed warmup may add audio without mutating the publication source', () => {
  const additions = assertPreparationMediaManifest(original, [...original, added], classroomId);
  assert.deepEqual(additions, [added]);
  assert.deepEqual(assertPreparationWarmupAudio(additions, [committed], classroomId),
    [{ ...added, explanationId: committed.id, audioDurationSec: 1 }]);
  assert.deepEqual(assertPreparationMediaManifest(original, [...original].reverse(), classroomId), []);
});

test('new valid warmup never hides changed or deleted original files', () => {
  assert.throws(() => assertPreparationMediaManifest(original, [original[0], added], classroomId), /disappeared/);
  for (const patch of [{ bytes: 11 }, { sha256: hash('replacement') }]) {
    assert.throws(() => assertPreparationMediaManifest(original, [original[0], { ...original[1], ...patch }, added], classroomId), /changed/);
  }
  assert.throws(() => assertPreparationMediaManifest(original, [...original, original[1]], classroomId), /Duplicate/);
});

test('unrelated files, temporary output and forged content addresses cannot count as warmup', () => {
  for (const file of [
    { ...added, path: `${added.path}.token.tmp` },
    { ...added, path: `${classroomId}/audio/extra.wav` },
    { ...added, path: added.path.replace(classroomId, 'other-classroom') },
    { ...added, path: added.path.replace('/audio/', '/audio/nested/') },
    { ...added, sha256: hash('truncated') },
    { ...added, bytes: 0 },
  ]) assert.throws(() => assertPreparationMediaManifest(original, [...original, file], classroomId));
});

test('a final filename alone cannot prove a successful warmup or cross-course ownership', () => {
  for (const rows of [[], [{ ...committed, status: 'RUNNING' }], [{ ...committed, input: { classroomId: 'another-course' } }],
    [{ ...committed, audio: null }], [{ ...committed, audio: { ...committed.audio, bytes: 9 } }],
    [{ ...committed, audio: { ...committed.audio, audioDurationSec: 0 } }]]) {
    assert.throws(() => assertPreparationWarmupAudio([added], rows, classroomId), /no committed warmup metadata/);
  }
});
