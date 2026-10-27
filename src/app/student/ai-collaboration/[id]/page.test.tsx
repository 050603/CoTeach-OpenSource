import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import StudentAiCollaborationPage from "./page";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "course-1" }),
  usePathname: () => "/student/ai-collaboration/course-1",
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-realtime-sync", () => ({ useRealtimeSync: vi.fn() }));
vi.mock("@/lib/session/store", () => ({
  useCourse: () => course,
  useHydrated: () => true,
}));
vi.mock("@/components/views/student/document-ai-collaboration", () => ({
  DocumentAiCollaboration: () => <div>文档协作工作台</div>,
}));
vi.mock("@/components/views/student/code-ai-collaboration", () => ({
  CodeAiCollaboration: () => <div>代码协作工作台</div>,
}));
vi.mock("@/components/views/student/other-artifact-collaboration", () => ({
  OtherArtifactCollaboration: () => <div>其他成果工作台</div>,
}));
vi.mock("@/components/classroom/simple-stage-resources", () => ({
  StudentResourceProjection: () => <div>教师资料投屏</div>,
}));

const course = {
  id: "course-1",
  status: "teaching",
  currentStageIndex: 0,
  stages: [{ key: "make", label: "项目实践", description: "项目实践", view: "ai-collaboration" }],
} as unknown as Course;

describe("student AI collaboration stage synchronization", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_OPENPBL_SYSTEM_MODE", "new");
    navigation.replace.mockReset();
    course.status = "teaching";
    course.currentStageIndex = 0;
    course.uiState = {};
    course.resources = [{ id: "practice-pdf" }] as Course["resources"];
    course.pblConfig = undefined;
    course.stages = [{ key: "make", label: "项目实践", description: "项目实践", view: "ai-collaboration" }];
  });

  it("keeps the collaboration workspace open during project practice", () => {
    render(<StudentAiCollaborationPage />);

    expect(screen.getByText("文档协作工作台")).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("returns to the classroom as soon as the teacher advances the stage", () => {
    course.stages = [{ key: "showcase", label: "成果汇报与评价", description: "成果汇报", view: "simple-resource" }];

    render(<StudentAiCollaborationPage />);

    expect(screen.getByText("正在进入新的课堂阶段…")).toBeTruthy();
    expect(screen.queryByText("文档协作工作台")).toBeNull();
    expect(navigation.replace).toHaveBeenCalledWith("/student/classroom/course-1");
  });

  it.each(["document", "python", "c", "other"] as const)("shows teacher resource projection over %s without remounting the workspace", mode => {
    course.pblConfig = { makeArtifactMode: mode } as Course["pblConfig"];
    const view = render(<StudentAiCollaborationPage />);
    const workspace = screen.getByText(mode === "document" ? "文档协作工作台" : mode === "other" ? "其他成果工作台" : "代码协作工作台");
    course.uiState = { resourceProjection: { resourceId: "practice-pdf", stageKey: "make", title: "核验资料", startedAt: new Date().toISOString() } };
    view.rerender(<StudentAiCollaborationPage />);
    expect(screen.getByText("教师资料投屏")).toBeTruthy();
    expect(screen.getByText(workspace.textContent!)).toBe(workspace);
    expect(workspace.parentElement?.hasAttribute("inert")).toBe(true);
    course.uiState = { resourceProjection: null };
    view.rerender(<StudentAiCollaborationPage />);
    expect(screen.queryByText("教师资料投屏")).toBeNull();
    expect(screen.getByText(workspace.textContent!)).toBe(workspace);
    expect(workspace.parentElement?.hasAttribute("inert")).toBe(false);
  });

  it("ignores resources projected from another stage or missing from the classroom", () => {
    course.uiState = { resourceProjection: { resourceId: "practice-pdf", stageKey: "launch", title: "旧资料", startedAt: new Date().toISOString() } };
    const view = render(<StudentAiCollaborationPage />);
    expect(screen.queryByText("教师资料投屏")).toBeNull();
    course.uiState.resourceProjection = { ...course.uiState.resourceProjection!, stageKey: "make", resourceId: "missing" };
    view.rerender(<StudentAiCollaborationPage />);
    expect(screen.queryByText("教师资料投屏")).toBeNull();
  });
});
