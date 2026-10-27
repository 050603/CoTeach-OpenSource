import { expect, test, type BrowserContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SignJWT } from "jose";
import { PDFDocument } from "pdf-lib";
import { createPblTemplateCourse, encodePblTemplate } from "../src/lib/platform/pbl-template";
import type { Course } from "../src/lib/session/types";

// Run only against the explicit disposable database and its matching server.
// The verification marker prevents accidental writes to a development/production database.
test.skip(!process.env.SHOWCASE_E2E_DATABASE_URL || !process.env.SHOWCASE_E2E_MARKER, "Requires a marked disposable showcase database");
test.use({ serviceWorkers: "block" });

test("real backend: full-class projection, browsing isolation, recovery, PDF and hand-off", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const origin = process.env.OPENPBL_RESOURCE_E2E_BASE_URL!;
  const secret = process.env.SHOWCASE_E2E_JWT_SECRET!;
  const db = new PrismaClient({ datasourceUrl: process.env.SHOWCASE_E2E_DATABASE_URL });
  const contexts: BrowserContext[] = [];
  try {
    const markers = await db.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification"`;
    expect(markers.map(row => row.marker)).toContain(process.env.SHOWCASE_E2E_MARKER);
    const prefix = `showcase-${randomUUID()}`;
    const user = async (role: string, displayName: string) => db.user.create({ data: { username: `${prefix}-${displayName}`, usernameKey: `${prefix}-${displayName}`, displayName, role, passwordHash: "unusable-test-password" } });
    const teacher = await user("TEACHER", "验收教师");
    const students = [await user("STUDENT", "小林"), await user("STUDENT", "小李")];
    const offering = await db.courseOffering.create({ data: { name: "汇报同步回归", status: "OPEN" } });
    await db.courseTeacher.create({ data: { userId: teacher.id, offeringId: offering.id } });
    const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: "节能项目", position: 0, isOpen: true } });
    const activity = await db.activity.create({ data: { chapterId: chapter.id, title: "节能成果展示", type: "CLASSROOM", position: 0, isOpen: true } });
    const template = await db.classroomTemplate.create({ data: { ownerId: teacher.id, title: "同步验收模板", status: "ACTIVE" } });
    const design = createPblTemplateCourse(template.id, { name: "节能成果展示", subject: "科学", grade: "七年级",
      content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" },
        stagePlan: { schemaVersion: 2, source: "resource-package", totalMinutes: 60, lessonCount: 1, minutesPerLesson: 60, evaluationCriteria: "依据原始记录说明结论", reflectionQuestions: [],
          stages: [["launch", 5], ["ai-learning", 15], ["make", 25], ["showcase", 10], ["reflection", 5]].map(([key, durationMin]) => ({ key, title: key, durationMin, requirements: "提交实际观察与证据", outputs: "观察作品", teacherActions: "组织展示", aiActions: "分析实际证据" })),
          showcasePlan: { presenterCount: 2, presentationSec: 180, transitionSec: 10 } } } as unknown as Course["content"] });
    const version = await db.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED", snapshot: JSON.parse(JSON.stringify(encodePblTemplate(design))) } });
    const instance = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: "TEACHING", startedAt: new Date(), runtimeConfig: { currentStageIndex: 3, version: 1, uiState: {} } } });
    const artifactIds: string[] = [];
    for (const [index, student] of students.entries()) {
      const enrollment = await db.enrollment.create({ data: { userId: student.id, offeringId: offering.id } });
      const participation = await db.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id, firstEnteredAt: new Date(), lastEnteredAt: new Date() } });
      const group = await db.projectGroup.create({ data: { offeringId: offering.id, name: `${student.displayName}的项目` } });
      await db.groupMember.create({ data: { groupId: group.id, userId: student.id, participationId: participation.id } });
      const artifact = await db.artifact.create({ data: { participationId: participation.id, groupId: group.id, title: index ? "节能观察演示稿.pdf" : "校园节能成果", type: index ? "PDF_ARCHIVE" : "DOCUMENT_ARCHIVE", status: "SUBMITTED" } });
      let fileAssetId: string | undefined;
      if (index) {
        const pdf = await PDFDocument.create();
        for (let page = 1; page <= 3; page++) pdf.addPage([960, 540]).drawText(`ENERGY OBSERVATION ${page}`, { x: 60, y: 400, size: 32 });
        const bytes = await pdf.save(); const storageKey = `${randomUUID()}.pdf`;
        const uploads = process.env.SHOWCASE_E2E_UPLOAD_DIR!;
        await mkdir(uploads, { recursive: true }); await writeFile(path.join(uploads, storageKey), bytes);
        fileAssetId = (await db.fileAsset.create({ data: { storageKey, originalName: "节能观察演示稿.pdf", mimeType: "application/pdf", size: bytes.length, uploadedById: student.id, offeringId: offering.id } })).id;
      }
      const html = '<h1>校园节能成果</h1>' + Array.from({ length: 45 }, (_, i) => `<p>观察记录第${i + 1}段：连续五天在相同时段检查教室照明，记录每天未关闭灯具数量。改进后照明时长减少百分之二十，观察时段和统计口径保持一致，尚需扩大样本验证。依据原始记录提出值日检查建议，并保留异常天气的说明。</p>`).join("");
      artifactIds.push((await db.artifactVersion.create({ data: { artifactId: artifact.id, sequence: 1, status: "SUBMITTED", submittedAt: new Date(Date.now() + index * 1000), sourceHtml: index ? undefined : html, fileAssetId, mimeType: index ? "application/pdf" : "text/html" } })).id);
    }
    const contextFor = async (identity: typeof teacher) => {
      const role = identity.role.toLowerCase();
      const token = await new SignJWT({ role, sv: 1, userId: identity.id, username: identity.username, displayName: identity.displayName, studentName: identity.displayName })
        .setProtectedHeader({ alg: "HS256" }).setSubject(identity.id).setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
      const context = await browser.newContext({ viewport: { width: 1366, height: 768 } }); contexts.push(context);
      await context.addCookies([{ name: `openpbl_${role}`, value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
      return context;
    };
    const teacherContext = await contextFor(teacher);
    const studentContexts = await Promise.all(students.map(contextFor));
    // One listener loses the shared classroom socket: authoritative HTTP
    // polling must still open, follow and close the public presentation.
    await studentContexts[1].routeWebSocket("**/*", socket => socket.close());
    const teacherPage = await teacherContext.newPage();
    const studentPages = await Promise.all(studentContexts.map(context => context.newPage()));
    await studentPages[1].setViewportSize({ width: 768, height: 1024 });
    const errors: string[] = [];
    for (const page of [teacherPage, ...studentPages]) page.on("pageerror", error => errors.push(error.message));
    await Promise.all([teacherPage.goto(`${origin}/teacher/teach/${instance.id}/classroom`), ...studentPages.map(page => page.goto(`${origin}/student/classroom/${instance.id}`))]);
    await expect(teacherPage.getByRole("heading", { name: "选择汇报学生" })).toBeVisible({ timeout: 60_000 });
    await teacherPage.getByRole("tab", { name: "全部学生", exact: true }).click();
    await teacherPage.getByRole("button", { name: "加入小林汇报名单" }).click();
    await expect(teacherPage.getByText("名单已保存")).toBeVisible({ timeout: 30_000 });
    await teacherPage.getByRole("button", { name: "加入小李汇报名单" }).click();
    await expect(teacherPage.getByText("名单已保存")).toBeVisible({ timeout: 30_000 });
    await teacherPage.getByRole("button", { name: "开始汇报并投屏", exact: true }).filter({ visible: true }).first().click();
    const projection = teacherPage.getByRole("region", { name: "作品全屏展示：校园节能成果" });
    await expect(projection).toBeVisible();
    for (const page of studentPages) await expect(page.getByRole("dialog", { name: "全班作品展示：校园节能成果" })).toBeVisible({ timeout: 15_000 });
    await expect(projection.getByText("作品已打开 2/2", { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(projection.locator("[data-slate-editor]")).toHaveCSS("font-size", "24px");
    await teacherPage.screenshot({ path: testInfo.outputPath("showcase-document-1366x768.png") });
    const teacherDocument = projection.getByLabel("最终文档预览", { exact: true });
    await teacherDocument.evaluate(node => { node.scrollTop = 2200; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
    for (const page of studentPages) await expect.poll(() => page.getByLabel("跟随汇报学生的文档").evaluate(node => node.scrollTop)).toBeGreaterThan(1000);
    const teacherBlock = await teacherDocument.evaluate(node => [...node.querySelectorAll<HTMLElement>("[data-showcase-block]")].find(block => block.getBoundingClientRect().bottom > node.getBoundingClientRect().top + 1)?.dataset.showcaseBlock);
    for (const page of studentPages) await expect.poll(() => page.getByLabel("跟随汇报学生的文档").evaluate(node => [...node.querySelectorAll<HTMLElement>("[data-showcase-block]")].find(block => block.getBoundingClientRect().bottom > node.getBoundingClientRect().top + 1)?.dataset.showcaseBlock)).toBe(teacherBlock);
    await projection.getByRole("button", { name: "浏览器全屏" }).click();
    await expect.poll(() => teacherPage.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
    await projection.getByRole("button", { name: "浏览学生作品", exact: true }).click();
    const browse = teacherPage.getByRole("dialog", { name: "浏览学生作品" });
    await browse.getByRole("tab", { name: "全部学生", exact: true }).click();
    await browse.getByRole("button", { name: "浏览小李作品" }).click();
    for (const page of studentPages) await expect(page.getByRole("dialog", { name: "全班作品展示：校园节能成果" })).toBeVisible();
    await browse.getByRole("button", { name: "返回当前汇报", exact: true }).click();
    await projection.getByRole("button", { name: "退出本机全屏", exact: true }).click();
    await expect.poll(() => teacherPage.evaluate(() => document.fullscreenElement === null)).toBe(true);
    for (const page of studentPages) await expect(page.getByTestId("student-showcase-projection")).toBeVisible();
    await teacherPage.getByRole("button", { name: "恢复作品全屏展示", exact: true }).click();
    const presentationUrl = `${origin}/api/courses/${instance.id}/showcase/presentation`;
    const previousControl = (await (await teacherContext.request.get(presentationUrl)).json()).activePresentation;
    const secondTeacherContext = await contextFor(teacher);
    const secondTeacherPage = await secondTeacherContext.newPage();
    await secondTeacherPage.goto(`${origin}/teacher/teach/${instance.id}/classroom`);
    await secondTeacherPage.getByRole("button", { name: "接管投屏", exact: true }).click();
    await expect(projection.getByRole("button", { name: "接管投屏", exact: true })).toBeVisible();
    const staleWrite = await teacherContext.request.patch(presentationUrl, {
      headers: { Origin: origin, "X-OpenPBL-Role": "teacher" },
      data: { presentationId: previousControl.id, clientId: previousControl.controllerClientId,
        controlEpoch: previousControl.controlEpoch, sequence: 999, viewState: { scrollRatio: 0 } },
    });
    expect(staleWrite.status()).toBe(409);
    expect((await staleWrite.json()).code).toBe("PROJECTION_CONTROL_CONFLICT");
    await projection.getByRole("button", { name: "接管投屏", exact: true }).click();
    await expect(secondTeacherPage.getByRole("button", { name: "接管投屏", exact: true })).toBeVisible();
    for (const page of studentPages) await expect.poll(() => page.getByLabel("跟随汇报学生的文档").evaluate(node => [...node.querySelectorAll<HTMLElement>("[data-showcase-block]")].find(block => block.getBoundingClientRect().bottom > node.getBoundingClientRect().top + 1)?.dataset.showcaseBlock)).toBe(teacherBlock);
    await secondTeacherContext.close();
    await studentContexts[1].setOffline(true);
    await projection.getByRole("button", { name: "结束汇报", exact: true }).click();
    await expect(studentPages[0].getByTestId("student-showcase-projection")).toHaveCount(0);
    await studentContexts[1].setOffline(false);
    await studentPages[1].evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(studentPages[1].getByTestId("student-showcase-projection")).toHaveCount(0);
    await expect(teacherPage.getByRole("button", { name: "开始小李汇报" }).filter({ visible: true }).first()).toBeVisible();
    await teacherPage.getByRole("button", { name: "开始小李汇报" }).filter({ visible: true }).first().click();
    for (const page of studentPages) await expect(page.getByRole("dialog", { name: /全班作品展示：节能观察演示稿/ })).toBeVisible();
    const pdfProjection = teacherPage.getByRole("region", { name: /作品全屏展示：节能观察演示稿/ });
    await pdfProjection.getByRole("button", { name: "下一页", exact: true }).click();
    for (const page of studentPages) await expect(page.getByTestId("student-showcase-projection").getByText("2 / 3", { exact: false })).toBeVisible({ timeout: 15_000 });
    await studentPages[1].reload();
    await expect(studentPages[1].getByTestId("student-showcase-projection").getByText("2 / 3", { exact: false })).toBeVisible({ timeout: 15_000 });
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 1024, height: 576 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
      await teacherPage.setViewportSize(viewport);
      await expect(pdfProjection.getByRole("button", { name: "结束汇报", exact: true })).toBeInViewport();
      const bounds = await pdfProjection.boundingBox(); expect(bounds?.width).toBe(viewport.width); expect(bounds?.height).toBe(viewport.height);
      await teacherPage.screenshot({ path: testInfo.outputPath(`showcase-${viewport.width}x${viewport.height}.png`) });
    }
    await pdfProjection.getByRole("button", { name: "结束汇报", exact: true }).click();
    for (const page of studentPages) await expect(page.getByTestId("student-showcase-projection")).toHaveCount(0);
    const denied = await studentContexts[0].request.get(`${origin}/api/courses/${instance.id}/showcase/artifacts/${artifactIds[1]}`);
    expect(denied.status()).toBe(404);
    const records = await db.showcasePresentation.findMany({ where: { participation: { instanceId: instance.id } } });
    expect(records.map(row => row.status)).toEqual(["ENDED", "ENDED"]);
    expect(errors).toEqual([]);
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    await db.$disconnect();
  }
});
