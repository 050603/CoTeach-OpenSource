import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";

const store = vi.hoisted(() => ({
  updateCourse: vi.fn(),
  getCourse: vi.fn(),
}));

vi.mock("@/lib/session/server-store", () => store);

import { linkClassroomToCourse } from "./course-linker";

describe("linkClassroomToCourse", () => {
  beforeEach(() => vi.clearAllMocks());

  it("durably links generated student and teacher content before publication", async () => {
    await linkClassroomToCourse("course-1", "student-classroom", {
      scenesCount: 8,
      stageName: "人工智能项目课",
      teacherClassroomId: "teacher-classroom",
      teacherResourceScenes: [{ id: "teacher-scene", title: "教师引导" }] as never,
      sceneOutlines: [{
        id: "outline-1",
        type: "slide",
        title: "课程导入",
        description: "导入课程主题",
        keyPoints: [],
        order: 0,
        mediaGenerations: [{ type: "image", elementId: "gen_img_1", prompt: "真实课程插图" }],
      }],
    });

    expect(store.updateCourse).toHaveBeenCalledWith("course-1", expect.any(Function));
    const updater = store.updateCourse.mock.calls[0]?.[1] as (course: Course) => Course;
    const saved = updater({ content: {} } as Course);
    expect(saved.aiLearningClassroomId).toBe("student-classroom");
    expect(saved.teacherClassroomId).toBe("teacher-classroom");
    expect(saved.content._openmaicClassroomId).toBe("student-classroom");
    expect(saved.content._openmaicScenesCount).toBe(8);
    expect(saved.content._openmaicSceneOutlines?.[0]?.mediaGenerations).toHaveLength(1);
    expect(saved.content.teacherResources?.scenes).toHaveLength(1);
  });

  it('checks the current confirmed source inside the course write before replacing its classroom', async () => {
    const validateCourse = vi.fn(() => { throw new Error('PREPARATION_SOURCE_CHANGED'); });
    await linkClassroomToCourse('course-1', 'stale-classroom', { scenesCount: 2, stageName: '旧方案' }, { validateCourse });
    const updater = store.updateCourse.mock.calls[0]?.[1] as (course: Course) => Course;
    const current = { aiLearningClassroomId: 'current-classroom', content: {} } as Course;
    expect(() => updater(current)).toThrow('PREPARATION_SOURCE_CHANGED');
    expect(validateCourse).toHaveBeenCalledWith(current);
    expect(current.aiLearningClassroomId).toBe('current-classroom');
  });
});
