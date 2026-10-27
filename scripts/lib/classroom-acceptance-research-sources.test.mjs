import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNonemptyResearchExport } from './classroom-acceptance-research-sources.mjs';

const sample = type => ({ type, researchKeys: ['student-a', 'student-b'], pageCount: 2,
  rows: [{ id: 'row-a', researchKey: 'student-a' }, { id: 'row-b', researchKey: 'student-b' }],
  expected: [{ id: 'row-a', researchKey: 'student-a' }, { id: 'row-b', researchKey: 'student-b' }],
});
for (const type of ['events', 'submissions', 'experiments', 'outcomes', 'ai', 'domain']) {
  test(`${type} requires nonempty, cross-page coverage for every real student`, () => {
    const fixture = sample(type);
    assert.deepEqual(assertNonemptyResearchExport(fixture), { type, rows: 2, pages: 2, students: 2 });
    assert.throws(() => assertNonemptyResearchExport({ ...fixture, rows: [], expected: [] }), /empty or omits students/);
    assert.throws(() => assertNonemptyResearchExport({ ...fixture, pageCount: 1 }), /never followed a cursor/);
    const sameStudent = fixture.rows.map(row => ({ ...row, researchKey: 'student-a' }));
    assert.throws(() => assertNonemptyResearchExport({ ...fixture, rows: sameStudent }), /omitted an enrolled student/);
  });
}

test('export pagination rejects duplicates, missing rows and foreign rows despite equal counts', () => {
  const fixture = sample('submissions');
  assert.throws(() => assertNonemptyResearchExport({ ...fixture, rows: [fixture.rows[0], fixture.rows[0]] }), /duplicated rows/);
  assert.throws(() => assertNonemptyResearchExport({ ...fixture, rows: [fixture.rows[0]] }), /empty or omits students/);
  assert.throws(() => assertNonemptyResearchExport({ ...fixture, rows: [fixture.rows[0], { ...fixture.rows[1], id: 'foreign' }] }), /foreign records/);
});

test('null and duplicate enrollment identities cannot manufacture all-student coverage', () => {
  const fixture = sample('outcomes');
  assert.throws(() => assertNonemptyResearchExport({ ...fixture, researchKeys: ['student-a', null] }), /actual enrolled/);
  assert.throws(() => assertNonemptyResearchExport({ ...fixture, researchKeys: ['student-a', 'student-a'] }), /duplicated a research identity/);
});
