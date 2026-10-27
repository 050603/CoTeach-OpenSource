import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { designCallLabel, FastCourseGenerator } from "./fast-course-generator";
import { emptyResourcePackageDraft } from "@/lib/resource-package/types";
import { courseGenerationDraftKey } from "@/lib/teacher/course-generation-draft";

function confirmedPackageJob() {
  const draft = emptyResourcePackageDraft();
  return { id: "package-job", status: "ready", progress: 100, message: "已确认", package: {
    schemaVersion: 1, id: "package-1", revision: 3, confirmedAt: "2026-09-12T00:00:00Z",
    source: { id: "upload-package", fileName: "教学资源.zip", url: "/api/uploads/upload-package" }, documents: {},
    draft: { ...draft, courseName: "机器学习", grade: "高中", drivingQuestion: "如何设计可靠的分类器？", learningObjectives: ["验证模型"], expectedOutcome: "分类模型", knowledgePoints: [{ name: "分类", description: "", subPoints: [] }], totalMinutes: 135, stages: draft.stages.map((stage, index) => ({ ...stage, durationMin: [15, 30, 60, 20, 10][index] })) },
  } };
}

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

describe("FastCourseGenerator knowledge references", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens the ZIP chooser directly, stays expanded on cancellation, and restores the mode only after a file is selected", async () => {
    const mutations: Array<{ url: string; body: BodyInit | null | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
      if (init?.method === "POST") mutations.push({ url: String(url), body: init.body });
      if (String(url) === "/api/uploads") return Response.json({ id: "uploaded-package" });
      return Response.json({ backgroundEnabled: true, job: null, textbooks: [] });
    }));
    const props = { course: { id: "new-mode-course" } as Course, teacherId: "teacher-1", onOpenDetailed: vi.fn(), simplified: true };
    const first = render(<FastCourseGenerator {...props} />);
    const choose = await screen.findByRole("button", { name: "选择交接包" });
    await waitFor(() => expect(choose).toBeEnabled());
    expect(screen.getByRole("heading", { name: "选择备课方式" })).toBeVisible();
    expect(screen.getByRole("group", { name: "备课模式" })).toHaveAttribute("data-expanded", "true");
    expect(screen.queryByRole("heading", { name: "上传课程资源包" })).toBeNull();
    const upload = screen.getByLabelText("上传课堂资源包") as HTMLInputElement;
    const openPicker = vi.spyOn(upload, "click");
    fireEvent.click(choose);
    expect(openPicker).toHaveBeenCalledOnce();
    fireEvent.change(upload, { target: { files: [] } });
    expect(screen.getByRole("group", { name: "备课模式" })).toHaveAttribute("data-expanded", "true");
    expect(window.localStorage.getItem("openpbl:preparation-mode:v1:teacher-1:new-mode-course")).toBeNull();
    expect(mutations).toEqual([]);
    const archive = new File(["archive"], "课程资料.zip", { type: "application/zip" });
    fireEvent.change(upload, { target: { files: [archive] } });
    expect(screen.getByRole("group", { name: "备课模式" })).toHaveAttribute("data-expanded", "false");
    expect(screen.getByRole("heading", { name: "上传课程资源包" })).toBeVisible();
    expect(screen.getByRole("button", { name: "导入交接包" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[0].url).toBe("/api/uploads");
    expect((mutations[0].body as FormData).get("file")).toBe(archive);
    expect((mutations[0].body as FormData).get("purpose")).toBe("course-resource-package");
    expect(mutations[1]).toEqual({ url: "/api/courses/new-mode-course/resource-package", body: JSON.stringify({ uploadId: "uploaded-package" }) });
    expect(window.localStorage.getItem("openpbl:preparation-mode:v1:teacher-1:new-mode-course")).toBe("resource-package");
    first.unmount();
    render(<FastCourseGenerator {...props} />);
    await waitFor(() => expect(screen.getByRole("group", { name: "备课模式" })).toHaveAttribute("data-expanded", "false"));
    expect(screen.getByRole("heading", { name: "上传课程资源包" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "选择备课方式" })).toBeNull();
  });

  it("restores unsubmitted requirements and settings after returning to the same source", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/resource-package")
      ? Response.json({ job: confirmedPackageJob() }) : Response.json({ backgroundEnabled: true, job: null, textbooks: [] })));
    const props = { course: { id: "draft-course" } as Course, teacherId: "teacher-1", onOpenDetailed: vi.fn(), simplified: true };
    const first = render(<FastCourseGenerator {...props} />);
    await screen.findByRole("button", { name: "开始生成课程" });
    expect(screen.getByRole("group", { name: "备课模式" })).toHaveAttribute("data-expanded", "false");
    await waitFor(() => expect(window.sessionStorage.getItem(courseGenerationDraftKey("teacher-1", "draft-course"))).not.toBeNull());
    fireEvent.change(screen.getByLabelText("补充课程生成要求（可选）"), { target: { value: "重点解释学生容易混淆的条件" } });
    fireEvent.click(screen.getByText("生成设置", { exact: false, selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "开启深度交互模式" }));
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(courseGenerationDraftKey("teacher-1", "draft-course"))!).generationMode).toBe("deep-interaction"));
    first.unmount();
    render(<FastCourseGenerator {...props} />);
    await waitFor(() => expect(screen.getByLabelText("补充课程生成要求（可选）")).toHaveValue("重点解释学生容易混淆的条件"));
    expect(screen.getByText("生成设置", { exact: false, selector: "summary" })).toHaveTextContent("深度交互");
    fireEvent.click(screen.getByRole("button", { name: "查看或修改资料" }));
    expect(screen.getByRole("heading", { name: "核对课程资料" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续：补充要求与生成" }));
    expect(screen.getByLabelText("补充课程生成要求（可选）")).toHaveValue("重点解释学生容易混淆的条件");
  });

  it("keeps a running request authoritative over an unsubmitted browser draft", async () => {
    window.sessionStorage.setItem(courseGenerationDraftKey("teacher-1", "running-course"), JSON.stringify({
      sourceKey: "package-1:3", jobId: "running-job", brief: "未提交的草稿", generationMode: "standard", generationScope: "test-lesson", assessmentMode: "adaptive",
      options: { enableImageGeneration: true, enableTTS: true, enableVideoGeneration: false }, referenceMaterials: [], textbookSelections: [],
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/resource-package")
      ? Response.json({ job: confirmedPackageJob() }) : Response.json({ backgroundEnabled: true, job: {
        id: "running-job", status: "running", step: "knowledgePoints", progress: 10, trace: [], message: "生成中", requestPreview: { teacherBrief: "实际提交的要求", generationScope: "full-course" },
      } })));
    render(<FastCourseGenerator course={{ id: "running-course" } as Course} teacherId="teacher-1" onOpenDetailed={vi.fn()} simplified />);
    expect(await screen.findByText("完成后继续规划讲授时长")).toBeTruthy();
    expect(screen.queryByText("未提交的草稿")).toBeNull();
    expect(screen.queryByText(/测试模式（正式链路/)).toBeNull();
  });

  it.each([false, true])("rebinds live inputs to a confirmed revision and isolates a replacement package: replacement=%s", async (replacement) => {
    let packageJob = confirmedPackageJob();
    const confirms: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/resource-package")) {
        if (init?.method === "POST") {
          packageJob = { ...packageJob, package: { ...packageJob.package, id: "replacement-package", revision: 1, confirmedAt: "" } };
        }
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          confirms.push(body);
          packageJob = { ...packageJob, package: { ...packageJob.package, revision: packageJob.package.revision + 1, confirmedAt: "2026-10-23T00:00:00Z", draft: body.draft } };
        }
        return Response.json({ job: packageJob });
      }
      if (url === "/api/uploads") return Response.json(init?.body instanceof FormData && init.body.get("purpose") === "course-resource-package"
        ? { id: "replacement-upload", fileName: "新的课程资料.zip" } : { id: "reference-1", fileName: "教师案例.md" });
      if (url.startsWith("/api/textbooks")) return Response.json({ textbooks: [{ id: "book-1", title: "课程教材", currentRevision: { id: "book-revision-1", version: 1, status: "READY" } }] });
      return Response.json({ backgroundEnabled: true, job: null });
    }));
    const props = { course: { id: "reconfirm-course" } as Course, teacherId: "teacher-1", onOpenDetailed: vi.fn(), simplified: true };
    const key = courseGenerationDraftKey("teacher-1", "reconfirm-course");
    const first = render(<FastCourseGenerator {...props} />);
    await screen.findByRole("button", { name: "开始生成课程" });
    await waitFor(() => expect(window.sessionStorage.getItem(key)).not.toBeNull());
    fireEvent.change(screen.getByLabelText("补充课程生成要求（可选）"), { target: { value: "保留生活案例和讲授重点" } });
    fireEvent.click(screen.getByText("生成设置", { selector: "summary", exact: false }));
    fireEvent.click(screen.getByRole("button", { name: "开启深度交互模式" }));
    fireEvent.click(screen.getByRole("button", { name: /语音：/ }));
    fireEvent.change(screen.getByLabelText("上传知识资料"), { target: { files: [new File(["案例"], "教师案例.md")] } });
    await screen.findByText("教师案例.md");
    fireEvent.click(screen.getByText("选用教材（可选）", { selector: "summary", exact: false }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择教材：课程教材" }));
    fireEvent.click(screen.getByRole("button", { name: "查看或修改资料" }));
    if (replacement) {
      fireEvent.change(screen.getByLabelText("上传课堂资源包"), { target: { files: [new File(["archive"], "新的课程资料.zip")] } });
      await waitFor(() => expect(packageJob.package.id).toBe("replacement-package"));
    }
    fireEvent.change(screen.getByLabelText("项目学习驱动问题（必填）"), { target: { value: "如何验证分类模型的可靠性？" } });
    expect(screen.getByRole("button", { name: /补充要求与生成/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "确认并保存教学要求" }));
    await screen.findByRole("button", { name: "开始生成课程" });
    const expectedBrief = replacement ? "" : "保留生活案例和讲授重点";
    await waitFor(() => expect(screen.getByLabelText("补充课程生成要求（可选）")).toHaveValue(expectedBrief));
    expect(confirms).toEqual([expect.objectContaining({ action: "confirm", revision: replacement ? 1 : 3, draft: expect.objectContaining({ drivingQuestion: "如何验证分类模型的可靠性？" }) })]);
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({
      sourceKey: replacement ? "replacement-package:2" : "package-1:4", brief: expectedBrief,
      generationMode: replacement ? "standard" : "deep-interaction", options: { enableTTS: replacement },
      referenceMaterials: replacement ? [] : [expect.objectContaining({ id: "reference-1" })],
      textbookSelections: replacement ? [] : [{ revisionId: "book-revision-1", primary: true, sectionIds: [] }],
    }));
    first.unmount();
    render(<FastCourseGenerator {...props} />);
    await screen.findByRole("button", { name: "开始生成课程" });
    await waitFor(() => expect(screen.getByLabelText("补充课程生成要求（可选）")).toHaveValue(expectedBrief));
    expect(screen.getByText("生成设置", { selector: "summary", exact: false })).toHaveTextContent(replacement ? "普通交互" : "深度交互");
    if (!replacement) expect(screen.getByText("教师案例.md")).toBeTruthy();
  });

  it("explains long reasoning and bounded retries instead of showing a static graph message", () => {
    expect(designCallLabel({
      stage: "knowledgePoints",
      status: "reasoning",
      attempt: 2,
      maxAttempts: 3,
      startedAt: Date.now() - 65_000,
    })).toContain("模型推理中，第 2/3 次尝试，已执行 65 秒");
    expect(designCallLabel({
      stage: "knowledgePoints",
      status: "receiving-output",
      attempt: 1,
      maxAttempts: 3,
      lastActivityAt: Date.now() - 3_000,
    })).toContain("正在接收图谱");
  });

  it("uploads an optional private reference and includes its id in the generation request", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.endsWith("/resource-package")) return Response.json({ job: confirmedPackageJob() });
      if (url === "/api/uploads" && method === "POST") {
        return Response.json({
          id: "11111111-1111-4111-8111-111111111111",
          fileName: "机器学习基础.md",
          fileType: "MD",
          size: "1.2 KB",
          purpose: "generation-reference",
        }, { status: 201 });
      }
      if (url.endsWith("/design-generation") && method === "POST") {
        return Response.json({ backgroundEnabled: true, job: null }, { status: 202 });
      }
      if (url.endsWith("/design-generation")) {
        return Response.json({ backgroundEnabled: true, job: null });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    render(
      <FastCourseGenerator
        course={{ id: "course-1" } as Course}
        onOpenDetailed={vi.fn()}
        simplified
      />,
    );

    await waitFor(() => expect(requests.some((request) => request.method === "GET")).toBe(true));
    expect(screen.getByRole("heading", { name: "准备课程资料" })).toBeTruthy();
    fireEvent.click(await screen.findByText("生成设置", { exact: false, selector: "summary" }));
    expect(screen.queryByText("生成 AI 授知内容")).toBeNull();
    expect(screen.queryByText(/系统只准备第二阶段/)).toBeNull();
    expect(screen.queryByText("普通模式")).toBeNull();
    expect(screen.getByRole("group", { name: "生成内容选项" })).toBeTruthy();
    expect(screen.getByLabelText(/图片：/).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText(/语音：/).getAttribute("aria-pressed")).toBe("true");
    const videoToggle = screen.getByLabelText(/视频：/);
    expect(videoToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(videoToggle);
    expect(videoToggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "开启深度交互模式" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(/支持 PDF、Word（DOCX）、PPT（PPTX）、TXT 和 Markdown/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("上传知识资料"), {
      target: { files: [new File(["训练数据与验证集"], "机器学习基础.md", { type: "text/markdown" })] },
    });

    expect(await screen.findByText("机器学习基础.md")).toBeTruthy();
    const upload = requests.find((request) => request.url === "/api/uploads" && request.method === "POST");
    expect(upload).toBeTruthy();

    fireEvent.change(screen.getByLabelText("补充课程生成要求（可选）"), {
      target: { value: "为高中生设计机器学习入门课" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始生成课程" }));

    await waitFor(() => {
      const generationRequest = requests.find((request) => request.url.endsWith("/design-generation") && request.method === "POST");
      expect(JSON.parse(generationRequest?.body ?? "{}")).toMatchObject({
        teacherBrief: "为高中生设计机器学习入门课",
        supplementalAnswers: { brief: "为高中生设计机器学习入门课" },
        resourcePackageId: "package-1",
        resourcePackageRevision: 3,
        generationMode: "standard",
        assessmentMode: "adaptive",
        referenceIds: ["11111111-1111-4111-8111-111111111111"],
        options: {
          enableImageGeneration: true,
          enableTTS: true,
          enableVideoGeneration: true,
        },
      });
    });
  });

  it("keeps deep interaction and deep response independent and submits both states", async () => {
    const requests: Array<{ method: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({ method, body: typeof init?.body === "string" ? init.body : undefined });
      if (String(input).endsWith("/resource-package")) return Response.json({ job: confirmedPackageJob() });
      return Response.json({ backgroundEnabled: true, job: null }, { status: method === "POST" ? 202 : 200 });
    }));

    render(<FastCourseGenerator course={{ id: "course-2" } as Course} onOpenDetailed={vi.fn()} simplified />);
    await waitFor(() => expect(requests.some((request) => request.method === "GET")).toBe(true));

    fireEvent.click(await screen.findByText("生成设置", { exact: false, selector: "summary" }));
    const deepToggle = screen.getByRole("button", { name: "开启深度交互模式" });
    const responseToggle = screen.getByRole("button", { name: "开启深度作答模式" });
    const send = screen.getByRole("button", { name: "开始生成课程" });
    expect(responseToggle.getAttribute("aria-pressed")).toBe("false");
    expect(deepToggle.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(deepToggle);
    expect(screen.getByRole("button", { name: "关闭深度交互，使用普通模式" }).getAttribute("aria-pressed")).toBe("true");
    expect(responseToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(responseToggle);
    expect(screen.getByRole("button", { name: "关闭深度作答，使用普通检测" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(screen.getByLabelText("补充课程生成要求（可选）"), { target: { value: "设计一节交互式 AI 课程" } });
    fireEvent.click(send);
    await waitFor(() => {
      const request = requests.find((item) => item.method === "POST");
      expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
        generationMode: "deep-interaction",
        assessmentMode: "constructed-response",
      });
    });
  });

  it("requires a confirmed package and accepts an empty supplemental brief", async () => {
    let confirmed = false;
    const post = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/resource-package")) {
        const job = confirmedPackageJob();
        if (init?.method === "PATCH") confirmed = true;
        return Response.json({ job: { ...job, package: { ...job.package, confirmedAt: confirmed ? job.package.confirmedAt : undefined } } });
      }
      if (init?.method === "POST") post(JSON.parse(String(init.body)));
      return Response.json({ backgroundEnabled: true, job: null });
    }));
    render(<FastCourseGenerator course={{ id: "course-3" } as Course} onOpenDetailed={vi.fn()} simplified />);
    expect(await screen.findByRole("button", { name: /补充要求与生成/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "开始生成课程" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "确认并保存教学要求" }));
    const send = await screen.findByRole("button", { name: "开始生成课程" });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ teacherBrief: "", supplementalAnswers: { brief: "" }, resourcePackageId: "package-1", resourcePackageRevision: 3 })));
    fireEvent.click(screen.getByRole("button", { name: "查看或修改资料" }));
    fireEvent.change(screen.getByLabelText("项目学习驱动问题（必填）"), { target: { value: "如何比较两种模型？" } });
    expect(screen.getByRole("button", { name: /补充要求与生成/ })).toBeDisabled();
  });

  it("retries an unchanged legacy failed request, but requires a package after editing", async () => {
    const post = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/resource-package")) return Response.json({ job: null });
      if (init?.method === "POST") { post(JSON.parse(String(init.body))); return Response.json({ backgroundEnabled: true, job: null }); }
      return Response.json({ backgroundEnabled: true, job: { id: "legacy", status: "failed", progress: 20, trace: [], message: "可继续", requestPreview: { teacherBrief: "旧的课程要求", generationMode: "standard", options: { enableImageGeneration: true, enableTTS: true, enableVideoGeneration: false }, referenceMaterials: [] } } });
    }));
    render(<FastCourseGenerator course={{ id: "legacy-course" } as Course} onOpenDetailed={vi.fn()} simplified />);
    const retry = await screen.findByRole("button", { name: "重生成失败阶段" });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("补充课程生成要求（可选）"), { target: { value: "新的课程要求" } });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("补充课程生成要求（可选）"), { target: { value: "旧的课程要求" } });
    fireEvent.click(retry);
    await waitFor(() => expect(post).toHaveBeenCalledWith({ teacherBrief: "旧的课程要求", generationMode: "standard", generationScope: "full-course", assessmentMode: "adaptive", options: { enableImageGeneration: true, enableTTS: true, enableVideoGeneration: false }, referenceIds: [], textbookSelections: [] }));
  });

  it("submits the single-lesson test scope independently from teaching style options", async () => {
    const post = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/resource-package")) return Response.json({ job: confirmedPackageJob() });
      if (init?.method === "POST") post(JSON.parse(String(init.body)));
      return Response.json({ backgroundEnabled: true, job: null }, { status: init?.method === "POST" ? 202 : 200 });
    }));
    render(<FastCourseGenerator course={{ id: "test-scope-course" } as Course} onOpenDetailed={vi.fn()} simplified />);
    fireEvent.click(await screen.findByText("生成设置", { exact: false, selector: "summary" }));
    const testToggle = await screen.findByRole("button", { name: "开启单节测试模式" });
    fireEvent.click(testToggle);
    expect(screen.getByRole("button", { name: "关闭测试模式，生成完整课程" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "开始生成课程" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({
      generationScope: "test-lesson",
      generationMode: "standard",
      assessmentMode: "adaptive",
    })));
  });

  it("opens the finished test lesson for teacher preview without starting the rest of the course", async () => {
    vi.useFakeTimers();
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.endsWith("/resource-package")) return Response.json({ job: confirmedPackageJob() });
      if (url.endsWith("/design-generation")) return Response.json({ backgroundEnabled: true, job: {
        id: "design-test", status: "completed", step: "completed", progress: 100,
        trace: [], requestPreview: { generationScope: "test-lesson" },
      } });
      if (url.endsWith("/generation")) return Response.json({ backgroundEnabled: true, job: {
        id: "content-test", status: "completed", step: "completed", progress: 100,
        message: "测试小节已完成", events: [], scenesGenerated: 4, totalScenes: 4,
        result: { id: "classroom-test", scenesCount: 4 },
      } });
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    render(<FastCourseGenerator course={{ id: "test-preview-course" } as Course} onOpenDetailed={vi.fn()} simplified />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const overview = screen.getByRole("button", { name: "查看课程总览" });
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(overview);
    expect(push).toHaveBeenCalledWith("/teacher/prepare/test-preview-course/preview?view=overview&classroomId=classroom-test");
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });
});
