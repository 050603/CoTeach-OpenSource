import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { resolveStudentStateScope } from './student-state-scope';

describe('student classroom scope query', () => {
  it('distinguishes a missing or ambiguous legacy id from a denied classroom', async () => {
    const raw = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ accessible: false, offeringId: 'offering', runtimeVersion: 7 }]);
    const db = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
    expect(await resolveStudentStateScope(db, 'offering', 'student')).toBeNull();
    expect(await resolveStudentStateScope(db, 'classroom', 'student')).toEqual({ accessible: false, offeringId: 'offering', version: 7 });
  });

  it('binds identity, session and operation without interpolating them into SQL text', async () => {
    const raw = vi.fn().mockResolvedValue([{ accessible: true, offeringId: 'offering', runtimeVersion: 7 }]);
    const db = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
    await resolveStudentStateScope(db, "classroom' OR true--", 'student', { mode: 'write', sessionVersion: 3 });
    const [strings, ...values] = raw.mock.calls[0];
    const sql = (strings as string[]).join('?');
    expect(values).toEqual(['student', false, 3, false, "classroom' OR true--", "classroom' OR true--", "classroom' OR true--"]);
    expect(sql).not.toContain("classroom' OR true--");
    expect(sql).toContain('e."offeringId" = c."offeringId"');
    expect(sql).toContain("lower(u.role) = 'student' AND lower(u.status) = 'active'");
    expect(sql).toContain("upper(ci.status) = 'TEACHING' AND upper(e.status) = 'ACTIVE' AND upper(o.status) = 'OPEN'");
  });
});


describe('permission and event metadata from the same fresh read', () => {
  it('returns changed runtime versions and revocation from consecutive queries without retaining a result', async () => {
    const raw = vi.fn()
      .mockResolvedValueOnce([{ accessible: true, offeringId: 'offering', runtimeVersion: 9 }])
      .mockResolvedValueOnce([{ accessible: true, offeringId: 'offering', runtimeVersion: 12 }])
      .mockResolvedValueOnce([{ accessible: false, offeringId: 'offering', runtimeVersion: 12 }]);
    const db = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
    expect(await resolveStudentStateScope(db, 'course', 'student', { sessionVersion: 3 }))
      .toEqual({ accessible: true, offeringId: 'offering', version: 9 });
    expect(await resolveStudentStateScope(db, 'course', 'student', { sessionVersion: 3 }))
      .toEqual({ accessible: true, offeringId: 'offering', version: 12 });
    expect(await resolveStudentStateScope(db, 'course', 'student', { sessionVersion: 3 }))
      .toEqual({ accessible: false, offeringId: 'offering', version: 12 });
    expect(raw).toHaveBeenCalledTimes(3);
  });

  it.each([null, '9', true, [], {}])('preserves the existing number-only event version contract for %j', async runtimeVersion => {
    const raw = vi.fn().mockResolvedValue([{ accessible: true, offeringId: 'offering', runtimeVersion }]);
    const db = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
    expect(await resolveStudentStateScope(db, 'course', 'student'))
      .toEqual({ accessible: true, offeringId: 'offering', version: 1 });
  });

  it('preserves zero as a stored numeric version', async () => {
    const raw = vi.fn().mockResolvedValue([{ accessible: true, offeringId: 'offering', runtimeVersion: 0 }]);
    const db = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
    expect((await resolveStudentStateScope(db, 'course', 'student'))?.version).toBe(0);
  });
});
