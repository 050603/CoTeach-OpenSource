import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';

const deliverySelect = {
  id: true, createdAt: true, eventType: true, actorId: true, payload: true,
  participation: { select: { enrollment: { select: { userId: true } } } },
} satisfies Prisma.DomainEventSelect;

type DeliveryEvent = Prisma.DomainEventGetPayload<{ select: typeof deliverySelect }>;
type Cursor = { createdAt: Date; id: string } | null;

/** Call only after fresh course authorization. Keep every row before the
 * client's visibility filter: hidden events still advance its canonical cursor.
 * Only the instance read projection changes; stored events and exports do not.
 */
export async function readCourseEvents(
  where: Prisma.DomainEventWhereInput,
  after: Cursor,
  limit: number,
  db: Prisma.TransactionClient = prisma,
): Promise<DeliveryEvent[]> {
  if (typeof where.classroomInstanceId !== 'string' || Object.keys(where).length !== 1) {
    return db.domainEvent.findMany({
      where: { AND: [where, ...(after ? [{ OR: [
        { createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } },
      ] }] : [])] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit, select: deliverySelect,
    });
  }
  return db.$queryRaw<DeliveryEvent[]>(Prisma.sql`
    SELECT d.id, d."createdAt", d."eventType", d."actorId",
      jsonb_build_object(
        'scope', CASE WHEN d.payload -> 'scope' = '"student"'::jsonb THEN d.payload -> 'scope' END,
        'studentId', CASE WHEN jsonb_typeof(d.payload -> 'studentId') = 'string' THEN d.payload -> 'studentId' END,
        'courseVersion', CASE WHEN jsonb_typeof(d.payload -> 'courseVersion') = 'number' THEN d.payload -> 'courseVersion' END,
        'source', CASE WHEN d.payload -> 'source' = '"learning-events"'::jsonb THEN d.payload -> 'source' END,
        'projection', CASE WHEN d."eventType" = 'projection-changed'
          AND jsonb_typeof(d.payload -> 'projection') = 'object' THEN d.payload -> 'projection' END
      ) AS payload,
      CASE WHEN p.id IS NULL THEN NULL ELSE
        jsonb_build_object('enrollment', jsonb_build_object('userId', e."userId"))
      END AS participation
    FROM "DomainEvent" d
    LEFT JOIN "ClassroomParticipation" p ON p.id = d."participationId"
    LEFT JOIN "Enrollment" e ON e.id = p."enrollmentId"
    WHERE d."classroomInstanceId" = ${where.classroomInstanceId}
      ${after ? Prisma.sql`AND (d."createdAt" > ${after.createdAt}
        OR (d."createdAt" = ${after.createdAt} AND d.id > ${after.id}))` : Prisma.empty}
    ORDER BY d."createdAt" ASC, d.id ASC
    LIMIT ${limit}
  `);
}
