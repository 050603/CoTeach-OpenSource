import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { runCodeBackgroundCloseProof, assertCodeBackgroundCoverage, CODE_BACKGROUND_GATE } from './classroom-acceptance-code-background.mjs';
import { runTeacherArtifactPreviews } from './classroom-acceptance-teacher-previews.mjs';
import { confirmSubmissionSave, observeSubmissionSaveReceipts, removeAcknowledgedDocumentDrafts } from './classroom-acceptance-save-confirmation.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stages = [
  ['launch', '项目启动', 'simple-resource'], ['ai-learning', '知识讲授', 'ai-learning'],
  ['make', '项目实践', 'ai-collaboration'], ['showcase', '成果汇报与评价', 'showcase-reporting'],
  ['reflection', '后测', 'experiment-posttest'],
].map(([key, label, view]) => ({ key, label, view, description: label }));

async function until(read, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (value) return value; await delay(300); } while (Date.now() < deadline);
  throw new Error(message);
}

export function assertArtifactReplay(original, replay) {
  for (const key of ['versionId', 'uploadId', 'sequence', 'requestId', 'submittedAt']) {
    assert.notEqual(original[key], undefined, `Original artifact receipt lacks ${key}`);
    assert.deepEqual(replay[key], original[key], `Artifact replay changed ${key}`);
  }
}

/** Additional artifact modes run after the main classroom; their elapsed time
 * must never be counted as the main course's 90-minute sustained workload.
 * All business writes use the caller's disposable instance and existing users.
 */
export async function runArtifactModesAcceptance({ teacher, students, offering, chapter, origin, db, request, record, output }) {
  assert.ok(students.length >= 2 && students.length <= 30);
  assert.equal(new Set(students.map(student => student.user.id)).size, students.length, 'Artifact users must be unique');
  const directory = path.join(output, 'artifact-modes');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidence = { students: students.length, startedAt: new Date().toISOString(), modes: [], passed: false,
    scope: 'Separate browser artifact scenarios after the sustained classroom; no model responses are mocked.' };
  const backgroundProofs = [];
  const backgroundTargets = new Map(['google-chrome', 'microsoft-edge'].map(brand => [brand, students.find(student => student.label === brand)?.index]));
  const save = () => writeFile(path.join(directory, 'artifact-modes.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  for (const mode of ['python', 'c', 'other']) {
    const result = { mode, startedAt: new Date().toISOString(), students: [], errors: [], passed: false };
    evidence.modes.push(result);
    const pageErrors = [];
    const listeners = students.map(student => {
      const listener = error => pageErrors.push({ student: student.index, message: error.message });
      student.page.on('pageerror', listener);
      return [student.page, listener];
    });
    try {
      const template = await request(teacher.context, 'POST', '/api/platform/templates', {
        title: `整课验收 ${mode} 成果专项`, snapshot: { schemaVersion: 2, kind: 'pbl-course', design: {
          name: `${mode} 成果验收`, subject: '信息科技', grade: '七年级', hours: 1, stages,
          drivingQuestion: '如何保存、运行并复核项目成果？', expectedOutcome: '持久化且可独立复核的成果',
          pblConfig: { makeArtifactMode: mode },
          content: { pblOutline: '浏览器完成项目文件编辑、保存和验证。', knowledgePoints: [], lessonOutline: [],
            evaluationPlan: { dimensions: [], overallRubric: '' } },
        } },
      }, 201);
      const activity = (await request(teacher.context, 'POST', `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`, {
        type: 'Classroom', title: `${mode} 成果专项`, templateVersionId: template.versions[0].id,
      }, 201)).activity;
      await request(teacher.context, 'PATCH', `/api/platform/activities/${activity.id}`, { isOpen: true });
      const instance = await db.classroomInstance.findFirstOrThrow({ where: { activityId: activity.id } });
      result.courseId = instance.id;
      await request(teacher.context, 'POST', `/api/platform/classroom-instances/${instance.id}/start`, {});
      const participants = new Map();
      for (const student of students) {
        await request(student.context, 'GET', `/api/platform/activities/${activity.id}`);
        const entered = await request(student.context, 'POST', `/api/platform/classroom-instances/${instance.id}/enter`, {});
        participants.set(student.user.id, entered.participation.id);
      }
      const state = async () => (await request(teacher.context, 'GET', `/api/courses/${instance.id}/state`)).course;
      await request(teacher.context, 'POST', `/api/courses/${instance.id}/actions`, {
        requestId: randomUUID(), action: { type: 'SET_STAGE', payload: { id: instance.id, index: 2 } },
      });
      if (mode === 'other') {
        const course = await state();
        const groups = [...(course.groups ?? [])];
        for (const student of students) {
          if (groups.some(group => group.members.some(member => member.studentId === student.user.id))) continue;
          const now = new Date().toISOString();
          groups.push({ id: `grp-${randomUUID()}`, name: `成果验收个人项目${student.index}`, topic: '成果核验', keywords: [], selectedForms: [],
            members: [{ studentId: student.user.id, name: `验收学生${student.index}`, role: '组长' }], createdAt: now, updatedAt: now });
        }
        if (groups.length !== (course.groups ?? []).length) await request(teacher.context, 'POST', `/api/courses/${instance.id}/actions`, {
          requestId: randomUUID(), action: { type: 'UPDATE_COURSE', payload: { id: instance.id, patch: { groups } } },
        });
      }
      const outcomes = await Promise.allSettled(students.map(async student => {
        const { page, context, user } = student;
        const studentResult = { studentId: user.id, index: student.index, participationId: participants.get(user.id), passed: false };
        result.students.push(studentResult);
        const observedSaves = observeSubmissionSaveReceipts(page, { origin, courseId: instance.id, studentId: user.id });
        const saveObservers = [observedSaves];
        try {
          await page.goto(`${origin}/student/ai-collaboration/${instance.id}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          if (mode === 'other') {
            // The collaboration brief and uploaded files have independent
            // receipts. Wait for the brief's real browser ACK before reloading
            // and only remove its acknowledged draft, retaining all outboxes.
            const brief = await until(async () => {
              const rows = await db.classroomSubmission.findMany({ where: { participationId: participants.get(user.id) } });
              const row = rows.find(item => (item.payload?.view ?? item.payload).type === 'artifact-brief');
              if (!row) return null;
              return row;
            }, `Student ${student.index} collaboration brief has no confirmed save receipt`);
            const briefProof = await confirmSubmissionSave({ page, db, courseId: instance.id, studentId: user.id,
              participationId: participants.get(user.id), submission: brief, observations: observedSaves.entries });
            const briefView = brief.payload?.view ?? brief.payload;
            studentResult.collaborationBrief = { id: brief.id, version: briefView.version, contentSha256: digest(briefView.content), pendingSaves: 0, saveReceipt: briefProof };
            studentResult.versions = [];
            const endpoint = `/api/courses/${instance.id}/showcase/artifacts/pdf`;
            for (let round = 1; round <= 2; round++) {
              await page.getByRole('button', { name: '提交本地成果', exact: true }).click();
              const dialog = page.getByRole('dialog', { name: '提交本地成果', exact: true });
              const filename = `student-${student.index}-round-${round}.txt`;
              const bytes = Buffer.alloc(1024 * 1024 + student.index % 5 * 256 * 1024, 'Observation: equal duration; keep original date, place and count.\n');
              bytes.write(`Student ${student.index}; round ${round}; classroom ${instance.id}\n`);
              const acknowledged = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST', { timeout: 90_000 });
              await dialog.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: 'text/plain', buffer: bytes });
              const response = await acknowledged;
              const receipt = await response.json();
              assert.equal(response.status(), 201, JSON.stringify(receipt));
              assert.equal(receipt.sequence, round);
              const row = dialog.getByRole('listitem').filter({ hasText: `第 ${round} 版 · ${filename}` });
              await expect(row).toBeVisible();
              const downloading = page.waitForEvent('download', { timeout: 30_000 });
              await row.getByRole('link', { name: '下载', exact: true }).click();
              const download = await downloading;
              const downloaded = path.join(directory, filename);
              await download.saveAs(downloaded);
              assert.equal(digest(await readFile(downloaded)), digest(bytes), 'Browser download differs from uploaded bytes');
              const replayResponse = await context.request.post(`${origin}${endpoint}`, { headers: { Origin: origin }, timeout: 90_000,
                multipart: { title: filename, requestId: receipt.requestId, file: { name: filename, mimeType: 'text/plain', buffer: bytes } } });
              assert.equal(replayResponse.status(), 200, await replayResponse.text());
              assertArtifactReplay(receipt, await replayResponse.json());
              const stored = await db.artifactVersion.findUniqueOrThrow({ where: { id: receipt.versionId }, include: { artifact: true } });
              assert.equal(stored.artifact.participationId, participants.get(user.id));
              assert.equal(stored.sha256, digest(bytes)); assert.equal(Number(stored.size), bytes.length);
              assert.equal(stored.sequence, round); assert.equal(stored.status, 'SUBMITTED');
              studentResult.versions.push({ ...receipt, sha256: digest(bytes), size: bytes.length, downloaded: filename, replayStatus: 200 });
              await removeAcknowledgedDocumentDrafts(page, { courseId: instance.id, studentId: user.id,
                submission: brief, workspaceKind: 'external-artifact' });
              await page.reload({ waitUntil: 'domcontentloaded' });
            }
            await page.getByRole('button', { name: '提交本地成果', exact: true }).click();
            const versions = page.getByRole('dialog', { name: '提交本地成果', exact: true }).getByRole('listitem');
            await expect(versions).toHaveCount(2);
            const stored = await db.artifactVersion.findMany({ where: { artifact: { participationId: participants.get(user.id), type: 'FILE_ARCHIVE' } } });
            assert.equal(stored.length, 2, 'Replays consumed additional artifact versions');
            for (const receipt of studentResult.versions) {
              const version = stored.find(item => item.id === receipt.versionId);
              assert.equal(version?.sha256, receipt.sha256, 'A later upload changed an earlier immutable version');
              const response = await context.request.get(`${origin}/api/uploads/${receipt.uploadId}`, { timeout: 60_000 });
              assert.equal(response.status(), 200);
              assert.equal(digest(await response.body()), receipt.sha256, 'Earlier file download changed after submitting a later version');
              assert.equal(await db.domainEvent.count({ where: { idempotencyKey: `file-artifact:${instance.id}:${user.id}:${receipt.requestId}` } }), 1,
                'An acknowledged upload replay must retain exactly one process receipt');
            }
          } else {
            const mainPath = mode === 'python' ? 'main.py' : 'main.c';
            const helperPath = mode === 'python' ? 'helper.py' : 'helper.c';
            const expectedOutput = `ACCEPTANCE_${mode.toUpperCase()}_${student.index} 7`;
            const main = mode === 'python' ? `from helper import value\nprint("ACCEPTANCE_PYTHON_${student.index}", value())\n`
              : `#include <stdio.h>\nint helper(void);\nint main(void) { printf("ACCEPTANCE_C_${student.index} %d\\n", helper()); return 0; }\n`;
            const helper = mode === 'python' ? 'def value():\n    return 7\n' : 'int helper(void) { return 7; }\n';
            const editor = page.getByRole('textbox', { name: '编辑器内容', exact: true });
            const edit = async (filePath, text) => {
              await editor.waitFor({ timeout: 45_000 }); await editor.focus(); await editor.press('ControlOrMeta+A');
              await page.keyboard.insertText(text);
              const actual = await page.evaluate(filePath => window.monaco?.editor.getModels()
                .find(model => model.uri.toString().endsWith(`/${filePath}`))?.getValue(), filePath);
              const normalized = value => value.split('\n').map(line => line.trim()).join('\n').trim();
              assert.equal(normalized(actual), normalized(text));
              return actual;
            };
            const mainContent = await edit(mainPath, main);
            await page.getByRole('button', { name: '新建代码文件', exact: true }).click();
            await page.getByRole('textbox', { name: '新文件名' }).fill(helperPath);
            await page.getByRole('button', { name: '创建文件', exact: true }).click();
            const helperContent = await edit(helperPath, helper);
            await page.getByRole('button', { name: '保存', exact: true }).click();
            const saved = await until(async () => {
              const rows = await db.classroomSubmission.findMany({ where: { participationId: participants.get(user.id) } });
              return rows.find(row => {
                const view = row.payload?.view ?? row.payload;
                if (view?.type !== 'code') return false;
                const artifact = JSON.parse(view.content);
                return artifact.language === mode && artifact.files.some(file => file.path === mainPath && file.content === mainContent)
                  && artifact.files.some(file => file.path === helperPath && file.content === helperContent);
              });
            }, `Student ${student.index} ${mode} files were not saved`);
            studentResult.saveReceipt = await confirmSubmissionSave({ page, db, courseId: instance.id, studentId: user.id,
              participationId: participants.get(user.id), submission: saved, observations: observedSaves.entries });
            await removeAcknowledgedDocumentDrafts(page, { courseId: instance.id, studentId: user.id,
              submission: saved, workspaceKind: `code:${mode}` });
            await page.reload({ waitUntil: 'domcontentloaded' });
            for (const [filePath, content] of [[mainPath, mainContent], [helperPath, helperContent]]) {
              await page.getByRole('button', { name: filePath, exact: true }).click({ timeout: 45_000 });
              await editor.waitFor({ timeout: 30_000 });
              await page.waitForFunction(({ filePath, content }) => window.monaco?.editor.getModels()
                .some(model => model.uri.toString().endsWith(`/${filePath}`) && model.getValue() === content), { filePath, content }, { timeout: 30_000 });
            }
            const triggerRun = async () => {
              const running = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai-collaboration/code/run'
                && response.request().method() === 'POST', { timeout: 60_000 });
              void running.catch(() => undefined);
              await page.getByRole('button', { name: '运行', exact: true }).click();
              const response = await running; const run = await response.json();
              assert.equal(response.status(), 200, JSON.stringify(run)); assert.equal(run.status, 'success');
              assert.equal(run.exitCode, 0); assert.equal(run.stdout.trim(), expectedOutput);
              await expect(page.locator('pre').filter({ hasText: expectedOutput })).toBeVisible();
              return run;
            };
            studentResult.submissionId = saved.id; studentResult.content = (saved.payload.view ?? saved.payload).content;
            studentResult.restoredWithoutLocalDraft = true;
            let run;
            if (backgroundTargets.get(student.label) === student.index) {
              const proof = await runCodeBackgroundCloseProof({ student, instance, participationId: participants.get(user.id),
                language: mode, kind: student.label === 'google-chrome' ? 'proactive-review' : 'code-task-starters',
                artifact: JSON.parse(studentResult.content), triggerRun, origin, db, output: directory,
                observePage: observedPage => {
                  const listener = error => pageErrors.push({ student: student.index, message: error.message });
                  observedPage.on('pageerror', listener); listeners.push([observedPage, listener]);
                  // Install before replacement navigation, retaining real later
                  // saves without changing the original expected artifact.
                  saveObservers.push(observeSubmissionSaveReceipts(observedPage, {
                    origin, courseId: instance.id, studentId: user.id,
                  }));
                } });
              backgroundProofs.push(proof); studentResult.backgroundProof = proof;
              assert.equal(proof.passed, true, proof.error ?? proof.restoreError);
              run = proof.actualRun;
            } else run = await triggerRun();
            studentResult.run = { status: run.status, stdout: run.stdout, exitCode: run.exitCode };
          }
          studentResult.passed = true;
          return studentResult;
        } catch (error) {
          studentResult.error = String(error.message);
          await page.screenshot({ path: path.join(directory, `${mode}-student-${student.index}-failure.png`), fullPage: true }).catch(() => undefined);
          throw error;
        } finally {
          await Promise.all(saveObservers.map(observer => observer.close()));
          studentResult.saveObservations = saveObservers.flatMap(observer => observer.entries);
        }
      }));
      const failed = outcomes.filter(outcome => outcome.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(outcome => outcome.reason), `${mode}: ${failed.length} of ${students.length} students failed`);
      const teacherState = await state();
      for (const student of result.students) {
        if (mode === 'other') {
          const versions = (teacherState.projectPdfVersions ?? []).filter(version => version.studentId === student.studentId);
          assert.equal(versions.length, 2);
          for (const receipt of student.versions) assert.ok(versions.some(version => version.id === receipt.versionId
            && version.uploadId === receipt.uploadId && version.sequence === receipt.sequence), 'Teacher artifact versions differ from acknowledged receipts');
        } else {
          const actual = teacherState.submissions.filter(item => item.studentId === student.studentId
            && item.stageKey === 'make' && item.type === 'code');
          if (!actual.some(item => item.content === student.content)) {
            const filename = `${mode}-teacher-reconciliation-student-${student.index}.json`;
            // Preserve the actual projection before throwing. Full code is
            // private evidence in the ignored run directory, never inline logs.
            await writeFile(path.join(directory, filename), `${JSON.stringify({
              courseId: instance.id, studentId: student.studentId, index: student.index,
              expected: { submissionId: student.submissionId, content: student.content, sha256: digest(student.content) },
              actual: actual.map(item => ({ ...item, sha256: typeof item.content === 'string' ? digest(item.content) : null })),
              saveReceipt: student.saveReceipt, saveObservations: student.saveObservations,
            }, null, 2)}\n`, { mode: 0o600 });
            assert.fail(`Teacher code differs from persisted student content for student ${student.index}; evidence: ${filename}`);
          }
        }
      }
      await teacher.page.goto(`${origin}/teacher/teach/${instance.id}/classroom`, { waitUntil: 'domcontentloaded' });
      await teacher.page.getByText('项目实践进度', { exact: true }).waitFor({ timeout: 30_000 });
      await teacher.page.screenshot({ path: path.join(directory, `${mode}-teacher.png`), fullPage: true });
      await runTeacherArtifactPreviews({ teacher, students, instance, origin, db, request, record, output: directory, mode });
      assert.deepEqual(pageErrors, [], 'Artifact browser runtime errors');
      result.passed = true;
      record(`artifact-mode-${mode}`, '通过', { students: students.length, teacherReconciled: students.length, mode }, 'browser-real-backend');
    } catch (error) {
      result.errors.push(String(error.stack ?? error));
      record(`artifact-mode-${mode}`, '失败', String(error.message), 'browser-real-backend');
    } finally {
      for (const [page, listener] of listeners) page.off('pageerror', listener);
      result.pageErrors = pageErrors; result.finishedAt = new Date().toISOString(); await save();
    }
  }
  try {
    assertCodeBackgroundCoverage(backgroundProofs);
    record(CODE_BACKGROUND_GATE, '通过', { targets: backgroundProofs }, 'browser-real-provider');
  } catch (error) {
    record(CODE_BACKGROUND_GATE, '失败', { error: String(error.message), targets: backgroundProofs }, 'browser-real-provider');
  }
  evidence.codeBackground = backgroundProofs;
  evidence.passed = evidence.modes.length === 3 && evidence.modes.every(mode => mode.passed);
  evidence.finishedAt = new Date().toISOString(); await save();
  record('artifact-modes', evidence.passed ? '通过' : '失败', { students: students.length, modes: evidence.modes.map(mode => ({ mode: mode.mode, passed: mode.passed })) }, 'browser-real-backend');
  return evidence;
}
