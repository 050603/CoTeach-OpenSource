import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Course, ShowcasePresentationSnapshot } from "@/lib/session/types";
import { showcaseReceipt } from "@/lib/showcase/projection-receipt-client";
const mock = vi.hoisted(() => ({ active: null as ShowcasePresentationSnapshot | null }));
vi.mock("@/hooks/use-showcase-presentation", () => ({ useShowcasePresentation: () => ({ data: { stageKey: "showcase", activePresentation: mock.active } }) }));
vi.mock("./showcase-artifact-viewer", () => ({ ShowcaseArtifactViewer: ({ mode, artifact, presentationLayout, onLoadStateChange }: { mode: string; artifact: { versionId: string }; presentationLayout: boolean; onLoadStateChange: (state: string) => void }) => <div data-testid="public-viewer" data-mode={mode} data-version={artifact.versionId} data-presentation={presentationLayout}><button onClick={() => onLoadStateChange("ready")}>作品渲染完成</button><button onClick={() => onLoadStateChange("error")}>模拟加载失败</button></div> }));
import { StudentShowcaseProvider } from "./student-showcase-projection";

const snapshot: ShowcasePresentationSnapshot = { id: "p1", courseId: "course-public", groupId: "g1", studentId: "another-student", studentName: "小李",
  artifactKind: "document", artifactVersionId: "document-1", artifactTitle: "节能方案", displayMode: "continuous", status: "active", revision: 3,
  requestedAt: "2026-10-20T01:00:00Z", updatedAt: "2026-10-20T01:00:00Z" };
const course = { id: "course-public", status: "teaching", currentStageIndex: 0, stages: [{ key: "showcase" }] } as unknown as Course;
beforeEach(() => { mock.active = snapshot; });
it("covers personal work with the exact public version and restores it after end", () => {
  const view = render(<StudentShowcaseProvider course={course}><input aria-label="个人草稿" defaultValue="保留个人内容" /></StudentShowcaseProvider>);
  expect(screen.getByRole("dialog", { name: "全班作品展示：节能方案" })).toHaveClass("fixed", "inset-0");
  expect(screen.getByTestId("public-viewer")).toHaveAttribute("data-mode", "follower");
  expect(screen.getByTestId("public-viewer")).toHaveAttribute("data-version", "document-1");
  fireEvent.click(screen.getByRole("button", { name: "作品渲染完成" }));
  expect(showcaseReceipt(course.id)).toMatchObject({ presentationId: "p1", artifactVersionId: "document-1", status: "ready" });
  mock.active = null;
  view.rerender(<StudentShowcaseProvider course={course}><input aria-label="个人草稿" defaultValue="保留个人内容" /></StudentShowcaseProvider>);
  expect(screen.queryByTestId("student-showcase-projection")).toBeNull();
  expect(screen.getByRole("textbox", { name: "个人草稿" })).toHaveValue("保留个人内容");
  expect(showcaseReceipt(course.id)).toBeUndefined();
});
it("records a failed load honestly and removes the projection on stage exit", () => {
  const view = render(<StudentShowcaseProvider course={course}><p>个人工作区</p></StudentShowcaseProvider>);
  fireEvent.click(screen.getByRole("button", { name: "模拟加载失败" }));
  expect(showcaseReceipt(course.id)?.status).toBe("error");
  act(() => view.rerender(<StudentShowcaseProvider course={{ ...course, status: "finished" }}><p>个人工作区</p></StudentShowcaseProvider>));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(showcaseReceipt(course.id)).toBeUndefined();
});
