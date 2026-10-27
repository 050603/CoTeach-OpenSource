/** Disposable PostgreSQL acceptance. Never uses the caller's DATABASE_URL or loads .env files.
 * pnpm exec tsx scripts/verify-content-monitor-database.ts [--keep]
 * --keep retains only the labeled disposable container for browser acceptance;
 * its connection and synthetic accounts are written under .openpbl-runtime/.
 * Semantic model output is deterministic here; real-provider quality is verified separately.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import type { AuthClaims } from "../src/lib/auth/session";
import type { ContentMonitorCheckInput } from "../src/lib/project-practice/content-monitor-contract";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.resolve(process.env.OPENPBL_CONTENT_MONITOR_MANIFEST ?? path.join(root, ".openpbl-runtime/content-monitor-db-env.json"));
const testSecret = "content-monitor-disposable-test-jwt-secret-only-2026";
function command(executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 60_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function isolatedDatabase() {
  const container = `openpbl-content-monitor-check-${randomUUID()}`;
  const temporary = mkdtempSync(path.join(tmpdir(), "openpbl-content-monitor-"));
  let started = false, passed = false;
  try {
    command("docker", ["run", "--detach", "--rm", "--name", container, "--label", "openpbl.verification=content-monitor",
      "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data:rw", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "pgvector/pgvector:0.8.6-pg16"]);
    started = true;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], { stdio: "ignore", timeout: 5000 }).status === 0) { ready = true; break; }
      await delay(500);
    }
    assert.ok(ready, "Disposable PostgreSQL did not become ready");
    const binding = command("docker", ["port", container, "5432/tcp"]);
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    const databaseUrl = `postgresql://postgres@${binding}/postgres?schema=public&connection_limit=12&pool_timeout=20`;
    const environment = { ...process.env, DATABASE_URL: databaseUrl, PROVIDER_CONFIG_DATABASE_URL: databaseUrl,
      REDIS_URL: "", JWT_SECRET: testSecret, OPENPBL_VERIFICATION_MARKER: container, PRISMA_CLIENT_ENGINE_TYPE: "library" };
    delete environment.PRISMA_GENERATE_NO_ENGINE;
    cpSync(path.join(root, "prisma"), path.join(temporary, "prisma"), { recursive: true });
    command(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", path.join(temporary, "prisma/schema.prisma")], { cwd: temporary, env: environment });
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      await db.$executeRaw`CREATE TABLE "_OpenpblVerification" (marker TEXT PRIMARY KEY)`;
      await db.$executeRaw`INSERT INTO "_OpenpblVerification" (marker) VALUES (${container})`;
    } finally { await db.$disconnect(); }
    const config = JSON.parse(readFileSync(path.join(root, "tsconfig.json"), "utf8"));
    const verificationConfig = path.join(temporary, "tsconfig.json");
    const aliases = Object.fromEntries(Object.entries(config.compilerOptions.paths as Record<string, string[]>).map(([key, values]) => [key, values.map(value => path.resolve(root, value))]));
    writeFileSync(verificationConfig, JSON.stringify({ extends: path.join(root, "tsconfig.json"), compilerOptions: { paths: { ...aliases,
      "server-only": [path.join(root, "node_modules/next/dist/compiled/server-only/empty.js")] } } }));
    mkdirSync(path.dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ container, DATABASE_URL: databaseUrl, PROVIDER_CONFIG_DATABASE_URL: databaseUrl, REDIS_URL: "", JWT_SECRET: testSecret }, null, 2), { mode: 0o600 });
    console.log(command("pnpm", ["exec", "tsx", "--tsconfig", verificationConfig, "scripts/verify-content-monitor-database.ts", "--worker"], {
      cwd: root, env: { ...environment, NODE_OPTIONS: "--conditions=import" }, timeout: 180_000,
    }));
    passed = true;
    if (process.argv.includes("--keep")) console.log(`Retained disposable fixture: ${manifest}\nCleanup: docker rm -f ${container}`);
  } finally {
    if (started && !(passed && process.argv.includes("--keep"))) command("docker", ["rm", "--force", container]);
    rmSync(temporary, { recursive: true, force: true });
    if (!(passed && process.argv.includes("--keep"))) rmSync(manifest, { force: true });
  }
}

async function verify() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER ?? "";
  assert.match(marker, /^openpbl-content-monitor-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.username, "postgres"); assert.equal(target.password, ""); assert.ok(target.port);
  const { prisma } = await import("../src/lib/db/client");
  try {
    assert.equal((await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker=${marker}`).length, 1);
    const service = await import("../src/lib/project-practice/content-monitor-service");
    const worker = await import("../src/lib/project-practice/content-monitor-worker");
    const policy = await import("../src/lib/project-practice/content-monitor-policy");
    const { createPblTemplateCourse, encodePblTemplate } = await import("../src/lib/platform/pbl-template");
    const { emptyResourcePackageDraft } = await import("../src/lib/resource-package/types");
    const { readProcessEvidence } = await import("../src/lib/evaluation/process-evidence");
    const { signStudentToken, signTeacherToken } = await import("../src/lib/auth/session");
    const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
    const user = (name: string, role = "STUDENT") => prisma.user.create({ data: { username: `monitor-${name}`, usernameKey: `monitor-${name}`, displayName: name, role, passwordHash: "test-only-unusable" } });
    const teacher = await user("teacher", "TEACHER"), student = await user("student"), second = await user("second"), outsider = await user("outsider");
    const claims = (u: typeof student): AuthClaims => u.role === "TEACHER"
      ? { sub: u.id, role: "teacher", sv: 1, username: u.username, displayName: u.displayName }
      : { sub: u.id, role: "student", sv: 1, studentName: u.displayName };
    const studentClaims = claims(student), teacherClaims = claims(teacher);
    const offering = await prisma.courseOffering.create({ data: { name: "文档粘贴提醒隔离验收", status: "OPEN", teachers: { create: { userId: teacher.id } } } });
    const chapter = await prisma.chapter.create({ data: { offeringId: offering.id, title: "项目", position: 0, isOpen: true } });
    const activity = await prisma.activity.create({ data: { chapterId: chapter.id, title: "校园浪费调查与改进", type: "CLASSROOM", position: 0, isOpen: true } });
    const template = await prisma.classroomTemplate.create({ data: { ownerId: teacher.id, title: "校园浪费调查" } });
    const requirements = "根据校园午餐浪费的调查数据，独立比较两种改进方案，并解释选择依据与验证方法。";
    const draft = emptyResourcePackageDraft();
    const course = createPblTemplateCourse(template.id, { name: "校园浪费调查", subject: "科学", grade: "七年级", drivingQuestion: "怎样减少校园午餐浪费？", learningObjectives: ["根据真实数据比较方案并说明取舍"],
      content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" },
        stagePlan: { ...draft, schemaVersion: 1, source: "resource-package", totalMinutes: 90, projectTask: requirements,
          stages: draft.stages.map(stage => ({ ...stage, durationMin: stage.key === "make" ? 40 : 10, requirements: stage.key === "make" ? requirements : "学习并记录发现", outputs: "个人调查与改进方案", teacherActions: "", aiActions: "帮助核验依据" })) } } });
    const version = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED", snapshot: json(encodePblTemplate(course)) } });
    const runtime = { evaluationContractVersion: 2, currentStageIndex: 2, stageVersion: 1, version: 1, documentPasteMonitoringEnabled: true, makeArtifactMode: "document" };
    const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: "TEACHING", startedAt: new Date(), runtimeConfig: runtime } });
    const other = await prisma.classroomInstance.create({ data: { activityId: activity.id, runNo: 2, templateVersionId: version.id, status: "TEACHING", runtimeConfig: runtime } });
    const participants = [];
    for (const u of [student, second]) {
      const enrollment = await prisma.enrollment.create({ data: { userId: u.id, offeringId: offering.id } });
      const member = await prisma.classroomParticipation.create({ data: { enrollmentId: enrollment.id, instanceId: instance.id, firstEnteredAt: new Date(), lastEnteredAt: new Date() } });
      participants.push(member);
      // normalizeCourse gives every student this personal-project alias. Seed
      // the same persistent membership as real classroom entry so autosave can
      // authorize the groupId sent by the document editor.
      await prisma.projectGroup.create({ data: { id: `${offering.id}:grp-${u.id}`, offeringId: offering.id, name: `${u.displayName}的个人项目`,
        members: { create: { userId: u.id, participationId: member.id, role: "项目负责人" } },
        board: { create: { snapshot: { proposal: { topic: "校园午餐浪费", goal: "比较改进方案并设计核验方法", keywords: [], selectedForms: ["调查报告"] } } } },
      } });
    }
    const participation = participants[0];
    const text = "根据连续五天的称重记录，我们发现主食剩余集中在固定大份配餐，而提供小份后仍可续取的方案能够兼顾不同食量。因此选择小份加续餐方案，先在两个班试行一周，保持菜品和用餐人数可比，每日记录每人平均剩余重量，并比较实施前后的变化。如果平均剩余量降低且学生满意度没有下降，再扩大实施范围。".repeat(3);
    const body = (requestId: string, pastedText = text): ContentMonitorCheckInput => ({ courseId: instance.id, requestId, fragments: [{ text: pastedText, beforeText: "" }], documentText: pastedText });
    const classified = (input: Parameters<typeof policy.classifyDocumentPaste>[0], options?: Parameters<typeof policy.classifyDocumentPaste>[1]) => policy.classifyDocumentPaste(input, { ...options,
      generate: async () => JSON.stringify({ category: "core-answer", confidence: "high", reason: "片段已经给出具体方案、选择理由和验证方法", pasteExcerpt: text.slice(0, 180), taskRequirement: requirements }) });
    const runNext = async (classify = classified) => {
      const job = await worker.claimContentMonitorJob(); assert.ok(job, "Expected a claimable monitor task");
      await worker.runContentMonitorJob(job, new AbortController().signal, classify); return job;
    };

    await Promise.all([service.submitContentMonitorCheck(studentClaims, body("first")), service.submitContentMonitorCheck(studentClaims, body("first"))]);
    assert.equal(await prisma.aiTask.count(), 1);
    await assert.rejects(() => service.submitContentMonitorCheck(studentClaims, { ...body("first"), documentText: "changed" }), (e: { code: string }) => e.code === "IDEMPOTENCY_CONFLICT");
    const firstJob = await runNext();
    let receipt = await service.readContentMonitorCheck(studentClaims, instance.id, "first");
    assert.equal(receipt.status, "flagged"); assert.ok(receipt.event);
    const eventId = receipt.event.id;
    const original = await prisma.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
    const terminal = await prisma.aiTask.findUniqueOrThrow({ where: { id: firstJob.id } });
    assert.ok(!JSON.stringify(terminal.input).includes("连续五天")); assert.ok(!("fragments" in (terminal.input as object)));
    console.log("PASS PostgreSQL atomic submit, concurrent duplicate receipt, fingerprint conflict, claim, grounded flag and input cleanup");

    await assert.rejects(() => service.readContentMonitorCheck(claims(second), instance.id, "first"), (e: { code: string }) => e.code === "CHECK_NOT_FOUND");
    await assert.rejects(() => service.listContentMonitorEvents(claims(second), { courseId: instance.id, studentId: student.id }), (e: { code: string }) => e.code === "STUDENT_SCOPE_MISMATCH");
    await assert.rejects(() => service.listContentMonitorEvents(claims(outsider), { courseId: instance.id }), (e: { code: string }) => e.code === "STUDENT_SCOPE_MISMATCH");
    await assert.rejects(() => service.submitContentMonitorCheck(studentClaims, { ...body("wrong-class"), courseId: other.id }), (e: { code: string }) => e.code === "STUDENT_SCOPE_MISMATCH");
    await assert.rejects(() => service.updateContentMonitorEvent(claims(second), eventId, { courseId: instance.id, action: "acknowledge" }), (e: { code: string }) => e.code === "EVENT_NOT_FOUND");
    await service.updateContentMonitorEvent(studentClaims, eventId, { courseId: instance.id, action: "explain", source: "own-draft", explanation: "这是课前自写草稿" });
    await service.updateContentMonitorEvent(teacherClaims, eventId, { courseId: instance.id, action: "review", status: "dismissed", note: "已核对草稿" });
    receipt = await service.readContentMonitorCheck(studentClaims, instance.id, "first");
    assert.equal(receipt.event?.status, "dismissed"); assert.equal(receipt.event?.studentExplanation, "这是课前自写草稿");
    assert.deepEqual((await prisma.domainEvent.findUniqueOrThrow({ where: { id: eventId } })).payload, original.payload);
    assert.equal((await service.listContentMonitorEvents(teacherClaims, { courseId: instance.id })).pendingCount, 0);
    assert.equal(await prisma.domainEvent.count({ where: { eventType: "document_content_reminder_history" } }), 2);
    assert.equal(await prisma.aiInteractionEvent.count(), 0);
    const processEvidence = await readProcessEvidence(participation.id);
    assert.deepEqual(processEvidence.evidence, []);
    assert.ok(!JSON.stringify(processEvidence).includes("自写草稿"));
    assert.ok(!JSON.stringify(service.redactContentMonitorEvent(receipt.event!, false)).includes("连续五天"));
    console.log("PASS cross-student/classroom isolation, immutable observation plus append-only explanations/reviews, default export redaction and process-score isolation");

    const aiText = "系统AI帮助整理的表格与背景说明，学生可在这些资料基础上独立分析并作出自己的决定。".repeat(10);
    const conversation = await prisma.aiConversation.create({ data: { userId: student.id, offeringId: offering.id, participationId: participation.id } });
    await prisma.aiMessage.create({ data: { conversationId: conversation.id, role: "assistant", content: aiText } });
    await service.submitContentMonitorCheck(studentClaims, body("system-ai", aiText));
    let generated = false;
    await runNext((input, options) => policy.classifyDocumentPaste(input, { ...options, generate: async () => { generated = true; throw new Error("Owned AI text must bypass the model"); } }));
    assert.equal(generated, false); assert.equal((await service.readContentMonitorCheck(studentClaims, instance.id, "system-ai")).status, "clear");
    assert.equal(await prisma.domainEvent.count({ where: { eventType: "document_content_reminder" } }), 1);
    await service.submitContentMonitorCheck(studentClaims, body("mixed", `${aiText}\n\n${text}`));
    await runNext(); assert.equal((await service.readContentMonitorCheck(studentClaims, instance.id, "mixed")).status, "flagged");
    console.log("PASS server-owned AI source exemption and mixed-source remainder detection");

    await service.submitContentMonitorCheck(studentClaims, body("retry"));
    const firstFailure = await runNext(async () => { throw new Error("simulated provider timeout"); });
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: firstFailure.id } })).status, "PENDING");
    await prisma.aiTask.update({ where: { id: firstFailure.id }, data: { availableAt: new Date(0) } });
    const secondFailure = await runNext(async () => { throw new Error("simulated provider timeout"); });
    assert.equal(secondFailure.attemptCount, 2);
    assert.equal((await service.readContentMonitorCheck(studentClaims, instance.id, "retry")).status, "incomplete");
    assert.ok(!JSON.stringify((await prisma.aiTask.findUniqueOrThrow({ where: { id: firstFailure.id } })).input).includes("连续五天"));
    await service.submitContentMonitorCheck(studentClaims, body("lease"));
    const stale = await worker.claimContentMonitorJob(); assert.ok(stale);
    await prisma.aiTask.update({ where: { id: stale.id }, data: { startedAt: new Date(stale.startedAt.getTime() + 1000), leaseUntil: new Date(0) } });
    const countBefore = await prisma.domainEvent.count({ where: { eventType: "document_content_reminder" } });
    await worker.runContentMonitorJob(stale, new AbortController().signal, classified);
    assert.equal(await prisma.domainEvent.count({ where: { eventType: "document_content_reminder" } }), countBefore);
    await runNext(async () => ({ outcome: "clear" }));
    assert.equal((await service.readContentMonitorCheck(studentClaims, instance.id, "lease")).status, "clear");
    console.log("PASS one technical retry, terminal cleanup, expired lease recovery and stale-owner commit prevention");

    await service.submitContentMonitorCheck(studentClaims, body("off"));
    const offJob = await worker.claimContentMonitorJob(); assert.ok(offJob);
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: { ...runtime, documentPasteMonitoringEnabled: false } } });
    await worker.runContentMonitorJob(offJob, new AbortController().signal, classified);
    assert.equal((await service.readContentMonitorCheck(studentClaims, instance.id, "off")).status, "cancelled");
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: runtime } });
    await service.submitContentMonitorCheck(studentClaims, body("toggle"));
    await prisma.$transaction(tx => service.cancelContentMonitorChecks(tx, instance.id));
    assert.equal((await service.readContentMonitorCheck(studentClaims, instance.id, "toggle")).status, "cancelled");
    await service.submitContentMonitorCheck(studentClaims, body("retire"));
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { status: "FINISHED" } });
    await worker.retireContentMonitorJobs();
    assert.equal((await service.readContentMonitorCheck(studentClaims, instance.id, "retire")).status, "cancelled");
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { status: "TEACHING" } });
    await service.submitContentMonitorCheck(studentClaims, body("expired"));
    const expired = await worker.claimContentMonitorJob(); assert.ok(expired);
    await prisma.aiTask.update({ where: { id: expired.id }, data: { attemptCount: 2, leaseUntil: new Date(0) } });
    await worker.retireContentMonitorJobs();
    assert.equal((await service.readContentMonitorCheck(studentClaims, instance.id, "expired")).status, "incomplete");
    await service.submitContentMonitorCheck(studentClaims, body("revoked"));
    await prisma.user.update({ where: { id: student.id }, data: { sessionVersion: 2 } });
    await worker.retireContentMonitorJobs();
    await prisma.user.update({ where: { id: student.id }, data: { sessionVersion: 1 } });
    assert.equal((await service.readContentMonitorCheck(studentClaims, instance.id, "revoked")).status, "cancelled");
    console.log("PASS live opt-out, finished-class cancellation, exhausted-lease retirement SQL and session revocation");

    const studentToken = await signStudentToken({ userId: student.id, studentName: student.displayName, sessionVersion: 1 });
    const teacherToken = await signTeacherToken({ teacherId: teacher.id, username: teacher.username, displayName: teacher.displayName, sessionVersion: 1 });
    const outsiderToken = await signStudentToken({ userId: outsider.id, studentName: outsider.displayName, sessionVersion: 1 });
    const checks = await import("../src/app/api/project-practice/content-monitor/checks/route");
    const events = await import("../src/app/api/project-practice/content-monitor/events/route");
    const updates = await import("../src/app/api/project-practice/content-monitor/events/[eventId]/route");
    const request = (url: string, token: typeof studentToken, method = "GET", value?: unknown, origin = "http://localhost") => new Request(`http://localhost${url}`, {
      method, headers: { cookie: `${token.cookieName}=${token.token}`, "x-auth-role": token.cookieName === teacherToken.cookieName ? "teacher" : "student", origin, "Content-Type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const listPath = `/api/project-practice/content-monitor/events?courseId=${instance.id}`;
    assert.equal((await events.GET(request(listPath, outsiderToken))).status, 403);
    assert.equal((await events.GET(request(listPath, teacherToken))).status, 200);
    assert.equal((await checks.POST(request("/api/project-practice/content-monitor/checks", studentToken, "POST", body("http"), "https://foreign.invalid"))).status, 403);
    const response = await checks.POST(request("/api/project-practice/content-monitor/checks", studentToken, "POST", body("http")));
    assert.equal(response.status, 200); assert.equal((await response.json()).status, "pending");
    await runNext();
    assert.equal((await checks.GET(request(`/api/project-practice/content-monitor/checks?courseId=${instance.id}&requestId=http`, studentToken))).status, 200);
    assert.equal((await updates.PATCH(request(`/api/project-practice/content-monitor/events/${eventId}`, studentToken, "PATCH", { courseId: instance.id, action: "review", status: "dismissed" }), { params: Promise.resolve({ eventId }) })).status, 403);
    console.log("PASS authenticated real HTTP handlers: JWT/session checks, CSRF, own receipt, teacher list and role-separated review");

    await prisma.classroomSubmission.create({ data: { participationId: participation.id, stageKey: "make:document", payload: { collection: "submissions", view: {
      id: "monitor-browser-document", courseId: instance.id, studentId: student.id, groupId: `grp-${student.id}`, stageKey: "make", title: "我的调查方案", type: "document", content: `<p>${text}</p>`, version: 1, status: "draft", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } } } });
    const saved = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, JSON.stringify({ ...saved, fixture: { courseId: instance.id, otherCourseId: other.id, offeringId: offering.id, activityId: activity.id,
      teacherId: teacher.id, studentId: student.id, secondStudentId: second.id, outsiderId: outsider.id, participationId: participation.id,
      teacherToken, studentToken, eventId, text, systemAiText: aiText }, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    console.log(`PASS all disposable database checks; fixture course=${instance.id}, student=${student.id}, teacher=${teacher.id}`);
  } finally { await prisma.$disconnect(); }
}

(process.argv.includes("--worker") ? verify() : isolatedDatabase()).catch(error => { console.error(error); process.exitCode = 1; });
