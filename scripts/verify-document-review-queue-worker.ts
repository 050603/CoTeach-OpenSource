// Disposable PostgreSQL regression: real admission, ownership, receipt/audit
// transactions and crash recovery. Model output is a local deterministic fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Course, CompanionMessage } from '../src/lib/session/types';
import type { QueuedDocumentReview, QueuedBackgroundReview } from '../src/lib/ai-collaboration/document-review-queue';

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? '', /^openpbl-research-check-[0-9a-f-]{36}$/);
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, 'postgres');
  assert.equal(url.password, ''); assert.equal(url.pathname, '/postgres'); assert.ok(url.port);
  const { prisma } = await import('../src/lib/db/client');
  try {
    assert.equal((await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`).length, 1);
    const { enqueueDocumentReview: enqueueAuthenticatedReview, claimQueuedDocumentReview, assertDocumentReviewScope, renewDocumentReviewLease,
      resumeDocumentReview, DOCUMENT_REVIEW_QUEUE } = await import('../src/lib/ai-collaboration/document-review-queue');
    const { completeDocumentRequest, prepareDocumentRequestResponse, getDocumentRequest, cancelDocumentRequest,
      listDocumentRequests, projectDocumentTask, documentTaskId, claimDocumentRequest } = await import('../src/lib/ai-collaboration/document-request-store');
    const { Prisma } = await import('@prisma/client');
    const { runQueuedDocumentReview } = await import('../src/lib/ai-collaboration/document-review-worker');
    const { createPblTemplateCourse } = await import('../src/lib/platform/pbl-template');
    const teacher = await prisma.user.create({ data: { username: 'queue-teacher', usernameKey: 'queue-teacher', displayName: 'Teacher', role: 'TEACHER', passwordHash: 'isolated' } });
    const offering = await prisma.courseOffering.create({ data: { name: 'Isolated document queue', status: 'OPEN' } });
    const chapter = await prisma.chapter.create({ data: { offeringId: offering.id, title: 'Queue', position: 0 } });
    const activity = await prisma.activity.create({ data: { chapterId: chapter.id, title: 'Document', type: 'CLASSROOM', position: 0 } });
    const template = await prisma.classroomTemplate.create({ data: { ownerId: teacher.id, title: 'Document queue' } });
    const version = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: 'PUBLISHED', snapshot: { title: 'Document queue' } } });
    const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: 'TEACHING', runtimeConfig: { version: 1, stageVersion: 1, currentStageIndex: 0 } } });
    const students = await Promise.all(Array.from({ length: 30 }, async (_, index) => {
      const name = `queue-student-${index}`;
      const student = await prisma.user.create({ data: { username: name, usernameKey: name, displayName: name, role: 'STUDENT', passwordHash: 'isolated' } });
      const enrollment = await prisma.enrollment.create({ data: { userId: student.id, offeringId: offering.id } });
      const participation = await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id } });
      return { student, participation };
    }));
    const course = { ...createPblTemplateCourse(instance.id), status: 'teaching', currentStageIndex: 0,
      stages: [{ key: 'make', label: '制作', view: 'project-making', description: '' }],
      students: students.map(({ student }) => ({ id: student.id, name: student.displayName, joinedAt: new Date().toISOString() })),
    } as Course;
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const input = (studentIndex: number, requestId: string) => {
      const { student, participation } = students[studentIndex];
      const documentHtml = '<p data-openpbl-block-id="one">原始日志东侧40只、西侧7只。</p>';
      const paragraphs = [{ candidateId: 'block:one', blockId: 'one', blockIndex: 0, targetText: '原始日志东侧40只、西侧7只。' }];
      return { course, documentHtml, paragraphs, task: { requestId, participationId: participation.id, courseId: instance.id, studentId: student.id,
        stageKey: 'make', workspaceKind: 'document', threadStageKey: 'ai-collaboration-comments:make',
        conversationId: 'proactive-document-comments', documentVersion: hash(documentHtml), message: JSON.stringify(paragraphs),
        intent: 'proactive-document-comments', history: [], fingerprint: hash({ action: 'proactive-document-comments', courseId: instance.id,
          stageKey: 'make', workspaceKind: 'document', documentHtml, proactiveParagraphs: paragraphs }) } };
    };
    const enqueueDocumentReview = (value: ReturnType<typeof input>) => enqueueAuthenticatedReview(value,
      students.find(({ student }) => student.id === value.task.studentId)!.student.sessionVersion);
    const first = await Promise.all(students.map((_, i) => enqueueDocumentReview(input(i, `first-${i}`))));
    assert.ok(first.every(item => item.kind === 'queued'));
    await Promise.all(students.map((_, i) => enqueueDocumentReview(input(i, `second-${i}`))));
    const repeated = await Promise.all(students.map((_, i) => enqueueDocumentReview(input(i, `first-${i}`))));
    assert.ok(repeated.every(item => item.kind === 'existing'));
    assert.equal(await prisma.aiTask.count({ where: { queueKey: DOCUMENT_REVIEW_QUEUE } }), 60);
    assert.equal((await enqueueDocumentReview({ ...input(0, 'first-0'), task: { ...input(0, 'first-0').task, fingerprint: 'different' } })).kind, 'conflict');
    console.log('PASS immutable 30-student admission: 60 tasks, replay creates no duplicates, changed identity conflicts');

    let modelCalls = 0; let injectCommitFailure = false;
    type Prepared = { receipt: Record<string, unknown>; messages: CompanionMessage[]; auditEvents: NonNullable<Parameters<typeof completeDocumentRequest>[0]['auditEvents']> };
    const execute = async (job: QueuedBackgroundReview) => {
      assert.equal(job.snapshot.version, 1, 'Original 60-document fixture must remain document-only');
      let prepared = job.preparedResponse?.preparedReview as Prepared | undefined;
      if (!prepared) {
        modelCalls++;
        prepared = { receipt: { requestId: job.snapshot.task.requestId, status: 'completed', documentVersion: job.snapshot.task.documentVersion,
          reviewDecision: { action: 'proactive-document-comments', documentVersion: job.snapshot.task.documentVersion }, complete: true },
        messages: [{ id: `checkpoint-${job.id}`, role: 'system-trigger', content: 'OPENPBL_DOCUMENT_COMMENT_REVIEW:fixture', createdAt: new Date().toISOString(), visibility: 'teacher-only' }],
        auditEvents: [{ idempotencyKey: `queue-proof-${job.id}`, eventType: 'policy', actor: 'system', content: 'No comment after complete review.', payload: { documentVersion: job.snapshot.task.documentVersion } }] };
        assert.equal(await prepareDocumentRequestResponse({ ...job.snapshot.task, token: job.token, response: { preparedReview: prepared } }), true);
      }
      const committed = await completeDocumentRequest({ ...job.snapshot.task, token: job.token, response: prepared.receipt,
        messages: prepared.messages, auditEvents: prepared.auditEvents, validate: async tx => {
          await assertDocumentReviewScope(tx, job.snapshot);
          if (injectCommitFailure) { injectCommitFailure = false; throw new Error('Injected commit rollback after prepare'); }
        } });
      return Response.json(prepared.receipt, { status: committed ? 200 : 409 });
    };
    const order: string[] = [];
    while (order.length < 60) {
      const claims = (await Promise.all(Array.from({ length: 30 }, () => claimQueuedDocumentReview()))).filter((job): job is QueuedDocumentReview => job !== null);
      assert.ok(claims.length > 0 && claims.length <= 8);
      assert.equal(new Set(claims.map(job => job.snapshot.task.studentId)).size, claims.length);
      for (const job of claims) {
        await assertDocumentReviewScope(prisma, job.snapshot); // Includes actual JSONB reorder roundtrip.
        order.push(job.snapshot.task.requestId);
      }
      await Promise.all(claims.map(job => runQueuedDocumentReview(job, new AbortController().signal, execute)));
    }
    assert.ok(order.slice(0, 30).every(id => id.startsWith('first-')));
    assert.equal(new Set(order.slice(0, 30)).size, 30); assert.equal(modelCalls, 60);
    assert.equal(await prisma.aiTask.count({ where: { queueKey: DOCUMENT_REVIEW_QUEUE, status: 'COMPLETED' } }), 60);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { idempotencyKey: { startsWith: 'queue-proof-' } } }), 60);
    assert.equal(await prisma.aiMessage.count({ where: { id: { startsWith: 'checkpoint-' } } }), 60);
    console.log('PASS real worker: max 8 concurrent claims; every student first batch precedes repeat batches; 60 atomic receipts/checkpoints/audits');

    // Run only after the first batch drains; this helper refuses any unrelated
    // pending/running task. Its child processes each revalidate the isolated DB.
    const { verifyDocumentReviewProcessCrashes } = await import('./verify-document-review-process-crash');
    await verifyDocumentReviewProcessCrashes(requestId => input(0, requestId), students[0].student.sessionVersion);
    const { verifyMixedCodeReviewQueue } = await import('./verify-code-review-queue-worker');
    await verifyMixedCodeReviewQueue(input);

    await enqueueDocumentReview(input(0, 'prepared-recovery')); const original = (await claimQueuedDocumentReview())!;
    injectCommitFailure = true; await runQueuedDocumentReview(original, new AbortController().signal, execute);
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: original.id } })).status, 'PENDING');
    assert.equal(await prisma.aiMessage.count({ where: { id: `checkpoint-${original.id}` } }), 0);
    await prisma.aiTask.update({ where: { id: original.id }, data: { availableAt: new Date(0) } });
    const recovered = (await claimQueuedDocumentReview())!; assert.notEqual(recovered.token, original.token);
    const callsBefore = modelCalls; await runQueuedDocumentReview(recovered, new AbortController().signal, execute);
    assert.equal(modelCalls, callsBefore);
    assert.equal(await completeDocumentRequest({ ...original.snapshot.task, token: original.token, messages: [], response: { invalid: true } }), false);
    assert.equal((await getDocumentRequest(original.snapshot.task))!.status, 'completed');
    assert.equal(await prisma.aiInteractionEvent.count({ where: { idempotencyKey: `queue-proof-${original.id}` } }), 1);
    console.log('PASS commit rollback preserves prepared result; new lease commits once without model replay, stale token cannot overwrite');

    // The checkpoint must make progress while both the local course permit and
    // its PG advisory lock are held elsewhere. It writes no course/message/audit.
    const { runMutationTransaction } = await import('../src/lib/db/transaction-retry');
    await enqueueDocumentReview(input(20, 'checkpoint-no-course-lock'));
    const checkpointJob = (await claimQueuedDocumentReview())!;
    const messageCountBeforeCheckpoint = await prisma.aiMessage.count();
    const courseBeforeCheckpoint = (await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig;
    let releaseCourse!: () => void; let enteredCourse!: () => void;
    const held = new Promise<void>(resolve => { releaseCourse = resolve; });
    const entered = new Promise<void>(resolve => { enteredCourse = resolve; });
    const holdingCourse = runMutationTransaction(async () => { enteredCourse(); await held; }, { lowPriorityCourseId: instance.id });
    await entered;
    const checkpointInput = { ...checkpointJob.snapshot.task, token: checkpointJob.token,
      response: { preparedReview: { receipt: { requestId: checkpointJob.snapshot.task.requestId, status: 'completed', original: true }, messages: [], auditEvents: [] } } };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.equal(await Promise.race([prepareDocumentRequestResponse(checkpointInput), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Checkpoint waited behind course permit')), 1500);
      })]), true);
    } finally { clearTimeout(deadline); releaseCourse(); await holdingCourse; }
    assert.equal(await prepareDocumentRequestResponse(checkpointInput), true);
    assert.equal(await prepareDocumentRequestResponse({ ...checkpointInput, response: { changed: true } }), false);
    const preparedBefore = (await prisma.aiTask.findUniqueOrThrow({ where: { id: checkpointJob.id } })).output;
    for (const field of ['courseId', 'studentId', 'participationId', 'requestId', 'stageKey', 'workspaceKind', 'conversationId', 'threadStageKey', 'fingerprint', 'documentVersion', 'intent', 'token'] as const) {
      assert.equal(await prepareDocumentRequestResponse({ ...checkpointInput, [field]: 'foreign' }), false, field);
    }
    assert.deepEqual((await prisma.aiTask.findUniqueOrThrow({ where: { id: checkpointJob.id } })).output, preparedBefore);
    assert.equal(await prisma.aiMessage.count(), messageCountBeforeCheckpoint);
    assert.deepEqual((await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig, courseBeforeCheckpoint);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { taskId: checkpointJob.id } }), 0);
    await cancelDocumentRequest(checkpointJob.snapshot.task);
    assert.equal(await prepareDocumentRequestResponse(checkpointInput), false);
    assert.deepEqual((await prisma.aiTask.findUniqueOrThrow({ where: { id: checkpointJob.id } })).output, preparedBefore);
    console.log('PASS native checkpoint bypasses held course permit/PG lock, keeps first result immutable, rejects foreign scope and cancellation without messages/audits');

    // Hold the real completion after task/user validation. The second statement
    // must wait on that task, then see COMPLETED and preserve its final receipt.
    await enqueueDocumentReview(input(21, 'checkpoint-completion-race'));
    const completionJob = (await claimQueuedDocumentReview())!;
    let releaseCompletion!: () => void; let enteredCompletion!: () => void;
    const completionHeld = new Promise<void>(resolve => { releaseCompletion = resolve; });
    const completionEntered = new Promise<void>(resolve => { enteredCompletion = resolve; });
    const completing = completeDocumentRequest({ ...completionJob.snapshot.task, token: completionJob.token,
      messages: [], response: { final: true }, validate: async tx => {
        await assertDocumentReviewScope(tx, completionJob.snapshot); enteredCompletion(); await completionHeld;
      } });
    await completionEntered;
    const competing = prepareDocumentRequestResponse({ ...completionJob.snapshot.task, token: completionJob.token, response: { stale: true } });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const [row] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
            AND query LIKE '%WITH target AS MATERIALIZED%') AS waiting`;
        waiting = row.waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'checkpoint actually waited on the completing task');
    } finally { releaseCompletion(); }
    assert.equal(await completing, true); assert.equal(await competing, false);
    assert.deepEqual((await prisma.aiTask.findUniqueOrThrow({ where: { id: completionJob.id } })).output, { schemaVersion: 1, response: { final: true } });
    console.log('PASS overlapping native completion/checkpoint serializes only task ownership and never replaces final output');

    // Real CAS contenders may win in either order. Cancellation must always
    // remain terminal, and a reclaimed token must reject every later old write.
    await enqueueDocumentReview(input(22, 'checkpoint-cancel-race'));
    const cancelledJob = (await claimQueuedDocumentReview())!;
    const cancelCheckpoint = { ...cancelledJob.snapshot.task, token: cancelledJob.token, response: { first: true } };
    await Promise.all([prepareDocumentRequestResponse(cancelCheckpoint), cancelDocumentRequest(cancelledJob.snapshot.task)]);
    assert.equal((await getDocumentRequest(cancelledJob.snapshot.task))!.status, 'cancelled');
    assert.equal(await prepareDocumentRequestResponse({ ...cancelCheckpoint, response: { late: true } }), false);

    await enqueueDocumentReview(input(23, 'checkpoint-reclaim-race'));
    const reclaimJob = (await claimQueuedDocumentReview())!;
    await prisma.aiTask.update({ where: { id: reclaimJob.id }, data: { leaseUntil: new Date(0) } });
    const reclaimCheckpoint = { ...reclaimJob.snapshot.task, token: reclaimJob.token, response: { original: true } };
    const [preparedWon, newLease] = await Promise.all([prepareDocumentRequestResponse(reclaimCheckpoint), claimQueuedDocumentReview()]);
    assert.ok(newLease); assert.notEqual(newLease.token, reclaimJob.token);
    assert.equal(await prepareDocumentRequestResponse({ ...reclaimCheckpoint, response: { stale: true } }), false);
    if (preparedWon) assert.deepEqual(newLease.preparedResponse, reclaimCheckpoint.response);
    await cancelDocumentRequest(newLease.snapshot.task);

    await enqueueDocumentReview(input(24, 'checkpoint-prepare-race'));
    const prepareJob = (await claimQueuedDocumentReview())!;
    const outputs = [{ first: 1 }, { first: 2 }];
    const won = await Promise.all(outputs.map(response => prepareDocumentRequestResponse({ ...prepareJob.snapshot.task, token: prepareJob.token, response })));
    assert.equal(won.filter(Boolean).length, 1);
    assert.deepEqual((await prisma.aiTask.findUniqueOrThrow({ where: { id: prepareJob.id } })).output, { preparedResponse: outputs[won.indexOf(true)] });
    await cancelDocumentRequest(prepareJob.snapshot.task);
    console.log('PASS concurrent native prepare/prepare, prepare/cancel and prepare/reclaim retain one original result and reject stale ownership');

    // A revocation already waiting/holding the User row must be observed after
    // FOR SHARE obtains it, rather than authorizing against the initial MVCC view.
    await enqueueDocumentReview(input(25, 'checkpoint-live-user-race'));
    const identityJob = (await claimQueuedDocumentReview())!;
    let releaseIdentity!: () => void; let enteredIdentity!: () => void;
    const identityHeld = new Promise<void>(resolve => { releaseIdentity = resolve; });
    const identityEntered = new Promise<void>(resolve => { enteredIdentity = resolve; });
    const revoking = prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: identityJob.snapshot.task.studentId }, data: { status: 'DISABLED' } });
      enteredIdentity(); await identityHeld;
    });
    await identityEntered;
    const denied = prepareDocumentRequestResponse({ ...identityJob.snapshot.task, token: identityJob.token, response: { invalid: true } })
      .then(() => null, error => error as Error & { code: string });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const [row] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
            AND query LIKE '%WITH target AS MATERIALIZED%') AS waiting`;
        waiting = row.waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'checkpoint actually waited for the live User row');
    } finally { releaseIdentity(); }
    await revoking; assert.equal((await denied)?.code, 'REVIEW_IDENTITY_CHANGED');
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: identityJob.id } })).output, null);
    await prisma.user.update({ where: { id: identityJob.snapshot.task.studentId }, data: { status: 'ACTIVE', sessionVersion: { increment: 1 } } });
    await assert.rejects(() => prepareDocumentRequestResponse({ ...identityJob.snapshot.task, token: identityJob.token, response: {} }), /REVIEW_IDENTITY_CHANGED/);
    await cancelDocumentRequest(identityJob.snapshot.task);
    console.log('PASS checkpoint waits for live identity revocation, rejects the committed change and rejects restored account with changed SV');

    for (const [index, blockedRow] of ['task', 'user'].entries()) {
      await enqueueDocumentReview(input(26 + index, `checkpoint-${blockedRow}-timeout`));
      const job = (await claimQueuedDocumentReview())!;
      let release!: () => void; let acquired!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      const acquiredRow = new Promise<void>(resolve => { acquired = resolve; });
      const blocker = prisma.$transaction(async tx => {
        if (blockedRow === 'task') await tx.$queryRaw`SELECT id FROM "AiTask" WHERE id = ${job.id} FOR UPDATE`;
        else await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${job.snapshot.task.studentId} FOR UPDATE`;
        acquired(); await hold;
      });
      await acquiredRow;
      const started = performance.now();
      try {
        await assert.rejects(() => prepareDocumentRequestResponse({ ...job.snapshot.task, token: job.token, response: { retry: true } }),
          (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010'
            && ['55P03', '57014'].includes(String(error.meta?.code)));
        assert.ok(performance.now() - started < 3000, 'one-second PG lock/statement budget cancels the wait');
      } finally { release(); await blocker; }
      assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: job.id } })).output, null);
      assert.equal(await prepareDocumentRequestResponse({ ...job.snapshot.task, token: job.token, response: { retry: true } }), true);
      await cancelDocumentRequest(job.snapshot.task);
    }
    // Occupy every configured pool connection simultaneously so the check
    // includes the connection used by either a successful or timed-out CAS.
    const poolSize = Number(url.searchParams.get('connection_limit') ?? 0);
    assert.equal(poolSize, 12, 'this isolated verification runner fixes the pool size');
    let inspected = 0; let releasePool!: () => void;
    const poolBarrier = new Promise<void>(resolve => { releasePool = resolve; });
    const settings = await Promise.all(Array.from({ length: poolSize }, () => prisma.$transaction(async tx => {
      const [row] = await tx.$queryRaw<Array<{ lock: string; statement: string }>>`
        SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement`;
      if (++inspected === poolSize) releasePool();
      await poolBarrier; return row;
    })));
    assert.ok(settings.every(row => row.lock === '0' && row.statement === '0'));
    console.log('PASS actual task/User lock waits cancel within checkpoint budget; subsequent checkpoint succeeds and all 12 pooled connections retain default timeout settings');

    const legacyInput = input(28, 'legacy-checkpoint-compatibility').task;
    const legacyClaim = await claimDocumentRequest(legacyInput);
    assert.equal(legacyClaim.kind, 'run'); if (legacyClaim.kind !== 'run') throw new Error('Expected legacy claim');
    assert.equal(await prepareDocumentRequestResponse({ ...legacyInput, token: legacyClaim.token, response: { candidateStarters: ['first'] } }), true);
    assert.equal(await prepareDocumentRequestResponse({ ...legacyInput, token: legacyClaim.token, response: { candidateStarters: ['second'] } }), true);
    const legacyRow = await prisma.aiTask.findUniqueOrThrow({ where: { id: documentTaskId(legacyInput.participationId, legacyInput.requestId) } });
    assert.equal(legacyRow.queueKey, null);
    assert.deepEqual(legacyRow.output, { preparedResponse: { candidateStarters: ['second'] } });
    assert.equal(await completeDocumentRequest({ ...legacyInput, token: legacyClaim.token, response: { complete: true }, messages: [] }), true);
    assert.equal(await prepareDocumentRequestResponse({ ...legacyInput, token: legacyClaim.token, response: { late: true } }), false);
    assert.deepEqual((await getDocumentRequest(legacyInput))?.response, { complete: true });
    console.log('PASS legacy nonqueue checkpoint replacement/replay and completed receipt remain unchanged without inventing a missing session guard');

    await enqueueDocumentReview(input(1, 'lease-recovery')); const abandoned = (await claimQueuedDocumentReview())!;
    await prisma.aiTask.update({ where: { id: abandoned.id }, data: { leaseUntil: new Date(0) } });
    const replacement = (await claimQueuedDocumentReview())!; assert.notEqual(replacement.token, abandoned.token);
    assert.equal(await renewDocumentReviewLease(abandoned), false);
    assert.equal(await prepareDocumentRequestResponse({ ...abandoned.snapshot.task, token: abandoned.token, response: { stale: true } }), false);
    await runQueuedDocumentReview(replacement, new AbortController().signal, execute);
    console.log('PASS an expired worker lease is recovered; old worker cannot renew or commit');

    await enqueueDocumentReview(input(2, 'bounded-failure'));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = (await claimQueuedDocumentReview())!;
      assert.equal(job.snapshot.task.requestId, 'bounded-failure');
      await runQueuedDocumentReview(job, new AbortController().signal, async () => Response.json({ error: 'AI_COLLABORATION_TIMEOUT' }, { status: 504 }));
      await prisma.aiTask.update({ where: { id: job.id }, data: { availableAt: new Date(0) } });
    }
    assert.equal(await claimQueuedDocumentReview(), null);
    const terminal = await getDocumentRequest(input(2, 'bounded-failure').task);
    assert.equal(terminal!.status, 'failed'); assert.equal(terminal!.retryable, false);
    assert.equal((await enqueueDocumentReview(input(2, 'bounded-failure'))).kind, 'existing');
    assert.equal((await resumeDocumentReview(input(2, 'bounded-failure').task)).kind, 'queued');
    await runQueuedDocumentReview((await claimQueuedDocumentReview())!, new AbortController().signal, execute);
    console.log('PASS three real failures become terminal; normal retransmission cannot reset attempts, explicit retry preserves the same task');

    await enqueueDocumentReview(input(3, 'stage-race')); const stageRace = (await claimQueuedDocumentReview())!;
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: { version: 2, stageVersion: 2, currentStageIndex: 0 } } });
    const priorCalls = modelCalls; await runQueuedDocumentReview(stageRace, new AbortController().signal, execute);
    assert.equal(modelCalls, priorCalls); assert.equal((await getDocumentRequest(stageRace.snapshot.task))!.error, 'REVIEW_STAGE_CHANGED');
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: { version: 3, stageVersion: 1, currentStageIndex: 0 } } });
    await enqueueDocumentReview(input(4, 'cancel-before-run'));
    assert.equal((await cancelDocumentRequest(input(4, 'cancel-before-run').task))!.status, 'cancelled');
    assert.equal(await claimQueuedDocumentReview(), null);
    console.log('PASS stage-version change rejects execution even after returning to same index; queued cancellation never runs');

    // No cookie/connection is needed by the worker; the durable identity guard is
    // invalidated by account revocation, including a later restored role.
    for (const [offset, changed] of [{ status: 'DISABLED' }, { sessionVersion: { increment: 1 } },
      { role: 'TEACHER', sessionVersion: { increment: 1 } }].entries()) {
      const index = 10 + offset; const value = input(index, `identity-${offset}`);
      await enqueueDocumentReview(value); const job = (await claimQueuedDocumentReview())!;
      await prisma.user.update({ where: { id: value.task.studentId }, data: changed });
      const calls: number = modelCalls;
      await runQueuedDocumentReview(job, new AbortController().signal, execute);
      assert.equal(modelCalls, calls);
      assert.equal((await getDocumentRequest(value.task))!.error, 'REVIEW_IDENTITY_CHANGED');
      await assert.rejects(() => enqueueDocumentReview(input(index, `identity-invalid-admission-${offset}`)), /REVIEW_IDENTITY_CHANGED/);
      await prisma.user.update({ where: { id: value.task.studentId }, data: { status: 'ACTIVE', role: 'STUDENT', sessionVersion: { increment: 1 } } });
      await assert.rejects(() => resumeDocumentReview(value.task), /REVIEW_IDENTITY_CHANGED/);
      assert.equal(await prisma.aiInteractionEvent.count({ where: { taskId: job.id } }), 0);
    }
    console.log('PASS disabled users, changed sessions and changed/restored roles cannot execute or resume old tasks; zero model calls/audits');

    const revokedCommitInput = input(13, 'identity-changed-before-commit');
    await enqueueDocumentReview(revokedCommitInput); const revokedCommit = (await claimQueuedDocumentReview())!;
    const callsBeforeCommit = modelCalls;
    await runQueuedDocumentReview(revokedCommit, new AbortController().signal, async job => {
      // Simulate identity revocation after the worker's pre-model check.
      await prisma.user.update({ where: { id: job.snapshot.task.studentId }, data: { sessionVersion: { increment: 1 } } });
      return execute(job);
    });
    assert.equal(modelCalls, callsBeforeCommit + 1);
    assert.equal((await getDocumentRequest(revokedCommitInput.task))!.error, 'REVIEW_IDENTITY_CHANGED');
    assert.equal(await prisma.aiMessage.count({ where: { id: `checkpoint-${revokedCommit.id}` } }), 0);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { taskId: revokedCommit.id } }), 0);
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: revokedCommit.id } })).output, null);
    await assert.rejects(() => resumeDocumentReview(revokedCommitInput.task), /REVIEW_IDENTITY_CHANGED/);
    console.log('PASS identity changed after execution check prevents atomic prepared receipt/checkpoint/audit commit');

    const missingIdentityInput = input(14, 'identity-snapshot-missing');
    await enqueueDocumentReview(missingIdentityInput); const missingIdentity = (await claimQueuedDocumentReview())!;
    const stored = await prisma.aiTask.findUniqueOrThrow({ where: { id: missingIdentity.id } });
    const storedInput = JSON.parse(JSON.stringify(stored.input)); delete storedInput.reviewSnapshot.guard.identity;
    await prisma.aiTask.update({ where: { id: stored.id }, data: { input: storedInput, status: 'FAILED', leaseUntil: null, completedAt: new Date() } });
    await assert.rejects(() => resumeDocumentReview(missingIdentityInput.task), /REVIEW_IDENTITY_SNAPSHOT_MISSING/);
    console.log('PASS recovery rejects missing immutable identity guards instead of inferring authorization');

    const { verifyDocumentReviewCapacity } = await import('./verify-document-review-capacity');
    await verifyDocumentReviewCapacity(input);

    // Receipt-only reads must preserve old public semantics while excluding
    // execution snapshots/checkpoints from the selected DB-to-Node payload.
    // This fixture stays inside this runner's guarded disposable PostgreSQL.
    const receiptIdentity = input(29, 'read-projection-fixture').task;
    const receiptOwner = await prisma.aiTask.findUniqueOrThrow({ where: { id: documentTaskId(students[29].participation.id, 'first-29') } });
    const receiptId = documentTaskId(receiptIdentity.participationId, receiptIdentity.requestId);
    const fullInput = { ...receiptIdentity, reviewSnapshot: { documentHtml: 'large-snapshot'.repeat(40000) },
      history: [{ role: 'user', content: 'original-history'.repeat(10000) }], token: 'private-lease-token' };
    const fullResponse = { requestId: receiptIdentity.requestId, documentVersion: receiptIdentity.documentVersion,
      status: 'completed', nested: { preserved: 'full-receipt'.repeat(1000), values: [null, false, 1, { extra: true }] } };
    const fullOutput = { response: fullResponse, preparedResponse: { preparedReview: 'prepared-private'.repeat(40000) } };
    await prisma.aiTask.create({ data: { id: receiptId, conversationId: receiptOwner.conversationId, offeringId: offering.id,
      createdById: receiptIdentity.studentId, taskType: 'DOCUMENT_COLLABORATION', status: 'COMPLETED', input: fullInput, output: fullOutput } });
    const [payloadSizes] = await prisma.$queryRaw<Array<{ fullBytes: number; projectedBytes: number }>>`
      SELECT octet_length(jsonb_build_object('input', input, 'output', output)::text) AS "fullBytes",
        octet_length(jsonb_build_object('input', jsonb_build_object(
          'requestId', input -> 'requestId', 'stageKey', input -> 'stageKey',
          'workspaceKind', input -> 'workspaceKind', 'conversationId', input -> 'conversationId',
          'documentVersion', input -> 'documentVersion', 'message', input -> 'message', 'intent', input -> 'intent'),
          'output', jsonb_build_object('response', output -> 'response'))::text) AS "projectedBytes"
      FROM "AiTask" WHERE id = ${receiptId}`;
    assert.ok(payloadSizes.fullBytes > 1000000 && payloadSizes.projectedBytes < payloadSizes.fullBytes / 20);
    console.log(`MEASURED receipt JSON projection fixture payload bytes: full ${payloadSizes.fullBytes}, selected ${payloadSizes.projectedBytes}; not a production latency measurement`);
    for (const queueKey of [null, 'document-review-v1']) {
      for (const status of ['PENDING', 'RUNNING', 'FAILED', 'CANCELLED', 'COMPLETED']) {
        for (const startedAt of [null, new Date(0), new Date()]) {
          const originalRow = await prisma.aiTask.update({ where: { id: receiptId }, data: { queueKey, status, startedAt,
            error: status === 'FAILED' ? 'FIXTURE_ERROR' : null } });
          assert.deepEqual(await getDocumentRequest(receiptIdentity), projectDocumentTask(originalRow));
          assert.deepEqual(await prisma.aiTask.findUniqueOrThrow({ where: { id: receiptId } }), originalRow, 'receipt read never rewrites immutable input/output');
        }
      }
    }
    for (const value of [null, 12, false, ['a', 3], { nested: true }]) {
      const originalRow = await prisma.aiTask.update({ where: { id: receiptId }, data: {
        input: { ...fullInput, message: value, intent: value, documentVersion: value },
        output: { response: { arbitrary: value }, preparedResponse: fullOutput.preparedResponse },
      } });
      assert.deepEqual(await getDocumentRequest(receiptIdentity), projectDocumentTask(originalRow));
    }
    for (const key of ['stageKey', 'workspaceKind', 'conversationId']) {
      await prisma.aiTask.update({ where: { id: receiptId }, data: { input: { ...fullInput, [key]: 12 } } });
      assert.equal(await getDocumentRequest({ ...receiptIdentity, [key]: '12' }), null, 'JSON numeric identity must not become a matching string');
    }
    for (const invalid of [Prisma.DbNull, Prisma.JsonNull, false, 'primitive', ['array']]) {
      await prisma.aiTask.update({ where: { id: receiptId }, data: { input: invalid } });
      assert.equal(await getDocumentRequest(receiptIdentity), null, 'non-object legacy identity cannot pass logical scope guards');
    }
    await prisma.aiTask.update({ where: { id: receiptId }, data: { input: fullInput } });
    for (const output of [Prisma.DbNull, Prisma.JsonNull, false, 'primitive', ['array'], {}, { response: null }, { response: [] }, fullOutput]) {
      const originalRow = await prisma.aiTask.update({ where: { id: receiptId }, data: { output } });
      assert.deepEqual(await getDocumentRequest(receiptIdentity), projectDocumentTask(originalRow));
    }
    const ownedRow = await prisma.aiTask.findUniqueOrThrow({ where: { id: receiptId } });
    for (const changed of [{ studentId: students[28].student.id }, { participationId: students[28].participation.id },
      { requestId: 'other' }, { stageKey: 'other' }, { workspaceKind: 'code' }, { conversationId: 'other' }]) {
      assert.equal(await getDocumentRequest({ ...receiptIdentity, ...changed }), null);
    }
    assert.deepEqual(await getDocumentRequest({ ...receiptIdentity, conversationId: '' }), projectDocumentTask(ownedRow));
    const otherConversation = await prisma.aiTask.findUniqueOrThrow({ where: { id: documentTaskId(students[28].participation.id, 'first-28') } });
    await prisma.aiTask.update({ where: { id: receiptId }, data: { conversationId: otherConversation.conversationId } });
    assert.equal(await getDocumentRequest(receiptIdentity), null, 'conversation relation participation still required');
    await prisma.aiTask.update({ where: { id: receiptId }, data: { conversationId: ownedRow.conversationId, taskType: 'OTHER' } });
    assert.equal(await getDocumentRequest(receiptIdentity), null, 'task type still required');
    await prisma.aiTask.update({ where: { id: receiptId }, data: { taskType: 'DOCUMENT_COLLABORATION' } });
    const receiptHistory = Array.from({ length: 31 }, (_, index) => ({
      id: `receipt-history-${index}`, conversationId: receiptOwner.conversationId, offeringId: offering.id,
      createdById: receiptIdentity.studentId, taskType: 'DOCUMENT_COLLABORATION', status: 'FAILED',
      input: { ...receiptIdentity, requestId: `receipt-history-${index}`, workspaceKind: index ? 'code' : 'document' },
      createdAt: new Date(Date.UTC(2030, 0, 1) + index * 1000),
    }));
    await prisma.aiTask.createMany({ data: receiptHistory });
    assert.deepEqual(await listDocumentRequests(receiptIdentity), [], 'latest 30 are filtered before logical scope, not after');
    await prisma.aiTask.update({ where: { id: 'receipt-history-30' }, data: { input: { ...receiptHistory[30].input, workspaceKind: 'document' }, status: 'PENDING' } });
    const expectedLatest = await prisma.aiTask.findUniqueOrThrow({ where: { id: 'receipt-history-30' } });
    assert.deepEqual(await listDocumentRequests(receiptIdentity), [projectDocumentTask(expectedLatest)]);
    assert.deepEqual(await listDocumentRequests({ ...receiptIdentity, conversationId: '' }), [], 'list keeps exact logical conversation match');
    assert.deepEqual((await prisma.aiTask.findUniqueOrThrow({ where: { id: receiptId } })).input, fullInput);
    assert.deepEqual((await prisma.aiTask.findUniqueOrThrow({ where: { id: receiptId } })).output, fullOutput);
    console.log('PASS native receipt projection: legacy/new status and JSON type parity, exact nested response, original input/output unchanged, ownership guards, GET-only wildcard and latest-30 list contract');

  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
