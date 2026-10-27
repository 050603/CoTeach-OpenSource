import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_STAGES, type Course } from "@/lib/session/types";
import { StudentActionConfirmationDialog, useStudentActionConfirmation } from "./student-confirmation";

const session = vi.hoisted(() => ({
  studentId: "student-1",
  upsertCompanionConfirmation: vi.fn(() => ({ id: "confirmation-1" })),
  resolveCompanionConfirmation: vi.fn(),
}));

vi.mock("@/lib/session/store", () => ({ useSession: () => session }));

const course: Course = {
  id: "course-1",
  name: "课堂",
  subject: "科学",
  grade: "六年级",
  hours: 2,
  summary: "",
  drivingQuestion: "",
  status: "teaching",
  stages: DEFAULT_STAGES,
  currentStageIndex: 3,
  content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
  students: [{ id: "student-1", name: "学生", joinedAt: "2026-01-01T00:00:00.000Z", stageProgress: {} }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("student formal action confirmation", () => {
  it("does not run the formal action before explicit confirmation", async () => {
    const onConfirm = vi.fn();
    function ActionHarness() {
      const confirmation = useStudentActionConfirmation({ course, stageKey: "make" });
      return (
        <>
          <button onClick={() => confirmation.request({ action: "save", title: "保存草稿", summary: "写入课堂记录", onConfirm })} type="button">request</button>
          <StudentActionConfirmationDialog busy={confirmation.busy} onConfirm={() => void confirmation.confirm()} onReject={confirmation.reject} pending={confirmation.pending} />
        </>
      );
    }

    render(<ActionHarness />);
    fireEvent.click(screen.getByRole("button", { name: "request" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(session.upsertCompanionConfirmation).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(session.resolveCompanionConfirmation).toHaveBeenCalledWith("course-1", "confirmation-1", "confirmed");
  });
});
