import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CourseGenerationStage } from "./course-generation-stage";

describe("CourseGenerationStage", () => {
  it("shows real adaptive-generation progress and the active task", () => {
    const now = Date.now();
    render(
      <CourseGenerationStage
        adaptiveBranchCount={2}
        error={null}
        result={null}
        status="loading"
        steps={[
          {
            step: "生成先决知识资源",
            progress: 91,
            message: "函数概念回顾：正在生成讲稿与语音",
            ts: now,
          },
        ]}
      />,
    );

    expect(screen.getByLabelText("生成进度 91%")).toBeTruthy();
    expect(screen.getAllByText("生成先决知识资源")).toHaveLength(2);
    expect(screen.getByText(/2 个已确认分支/)).toBeTruthy();
    expect(screen.getAllByText(/函数概念回顾/)).toHaveLength(2);
  });

  it("presents a clear completion state", () => {
    render(
      <CourseGenerationStage
        adaptiveBranchCount={0}
        error={null}
        result={{
          scenesCount: 18,
          studentSceneCount: 14,
          teacherSceneCount: 4,
          stage: { name: "课程生成完成" },
        }}
        status="success"
        steps={[]}
      />,
    );

    expect(screen.getByLabelText("生成进度 100%")).toBeTruthy();
    expect(screen.getByText(/已完成 18 个课堂场景/)).toBeTruthy();
    expect(screen.getByText("全部内容已检查并保存")).toBeTruthy();
  });

  it("turns server progress codes into teacher-friendly Chinese", () => {
    render(
      <CourseGenerationStage
        adaptiveBranchCount={0}
        error={null}
        result={null}
        status="loading"
        steps={[
          {
            step: "generating_scenes",
            progress: 46,
            message: "Generating scene 3/12: 光合作用实验",
            ts: Date.now(),
          },
        ]}
      />,
    );

    expect(screen.getAllByText("正在制作教学内容").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/正在制作第 3\/12 个课堂页面/).length).toBeGreaterThan(0);
    expect(screen.queryByText("generating_scenes")).toBeNull();
    expect(screen.queryByText(/Generating scene/)).toBeNull();
  });

  it("estimates remaining time from elapsed time and current progress", () => {
    render(
      <CourseGenerationStage
        adaptiveBranchCount={0}
        elapsedSeconds={300}
        error={null}
        result={null}
        status="loading"
        steps={[
          {
            step: "generating_scenes",
            progress: 50,
            message: "Generated 6/12 scenes",
            ts: Date.now(),
          },
        ]}
      />,
    );

    expect(screen.getByText("预计还需约 10–15 分钟")).toBeTruthy();
    expect(screen.queryByText("真实进度")).toBeNull();
  });
});
