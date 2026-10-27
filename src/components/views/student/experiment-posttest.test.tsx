import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { ExperimentPosttestStudentView } from "./experiment-posttest";

vi.mock("@/components/platform/student-experiment-assessment", () => ({
  StudentExperimentAssessment: () => <div>后测答题表单</div>,
}));

const platformContext = { offeringId: "offering", activityId: "activity", templateId: "template", templateVersionId: "version" };
function course(status: Course["status"], platform = true) {
  return { id: "classroom", status, platformContext: platform ? platformContext : undefined } as Course;
}

afterEach(cleanup);

describe("student legacy posttest stage", () => {
  it.each([true, false])("withholds both posttest entry and inline assessment while teaching (platform: %s)", (platform) => {
    render(<ExperimentPosttestStudentView course={course("teaching", platform)} />);
    expect(screen.getByRole("heading", { name: "后测尚未开放" })).toBeInTheDocument();
    expect(screen.getByText(/请先完成课堂学习/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "进入后测页面" })).toBeNull();
    expect(screen.queryByText("后测答题表单")).toBeNull();
  });

  it("retains the protected dedicated assessment route after classroom completion", () => {
    render(<ExperimentPosttestStudentView course={course("finished")} />);
    expect(screen.getByRole("link", { name: "进入后测页面" })).toHaveAttribute("href", "/student/activities/activity/assessments/classroom/posttest");
  });
});
