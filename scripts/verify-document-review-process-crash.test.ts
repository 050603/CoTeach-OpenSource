import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertVerificationChildIdentity, isolatedReviewDatabase, parseVerificationProcessIdentity } from './verify-document-review-process-crash';

function stat(pid = 101, parentPid = 100, startTicks = '12345') {
  const fields = ['S', String(parentPid), ...Array.from({ length: 17 }, () => '0'), startTicks];
  return `${pid} (node worker ) name) ${fields.join(' ')}`;
}

test('reads PID/start/parent from stat even when the process name contains a closing parenthesis', () => {
  assert.deepEqual(parseVerificationProcessIdentity(stat()), { pid: 101, parentPid: 100, startTicks: '12345' });
});

test('refuses missing, malformed or unsafe process identities instead of guessing ownership', () => {
  for (const source of ['', '101 node S 100', stat(0), stat(101, 0), stat(101, 100, ''),
    stat(101, 100, 'NaN'), stat(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => parseVerificationProcessIdentity(source));
  }
});

test('permits only the exact owned child and refuses PID reuse, parent changes or a foreign caller', () => {
  const expected = parseVerificationProcessIdentity(stat());
  assert.doesNotThrow(() => assertVerificationChildIdentity(expected, { ...expected }, 100));
  for (const actual of [{ ...expected, pid: 102 }, { ...expected, startTicks: '12346' }, { ...expected, parentPid: 99 }]) {
    assert.throws(() => assertVerificationChildIdentity(expected, actual, 100));
  }
  assert.throws(() => assertVerificationChildIdentity(expected, expected, 99));
});

test('rejects unmarked or non-disposable database targets before loading the database client', async () => {
  const previous = { marker: process.env.OPENPBL_VERIFICATION_MARKER, url: process.env.DATABASE_URL };
  const marker = 'openpbl-research-check-11111111-1111-4111-8111-111111111111';
  const validUrl = 'postgresql://postgres@127.0.0.1:1/postgres';
  try {
    for (const [candidateMarker, url] of [
      ['', validUrl], ['unrelated-marker', validUrl],
      [marker, 'postgresql://postgres@192.0.2.1:1/postgres'],
      [marker, 'postgresql://postgres@127.0.0.1/postgres'],
      [marker, 'postgresql://postgres@127.0.0.1:1/production'],
      [marker, 'postgresql://postgres:fixture@127.0.0.1:1/postgres'],
      [marker, 'postgresql://another@127.0.0.1:1/postgres'],
      [marker, 'postgres://postgres@127.0.0.1:1/postgres'],
    ]) {
      process.env.OPENPBL_VERIFICATION_MARKER = candidateMarker;
      process.env.DATABASE_URL = url;
      await assert.rejects(isolatedReviewDatabase, { name: 'AssertionError' });
    }
  } finally {
    if (previous.marker === undefined) delete process.env.OPENPBL_VERIFICATION_MARKER;
    else process.env.OPENPBL_VERIFICATION_MARKER = previous.marker;
    if (previous.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.url;
  }
});
