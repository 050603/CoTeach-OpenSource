import { describe, expect, it } from "vitest";
import { isForcedProjection, isOptionalProjection } from "@/lib/classroom/projection-mode";
import type { TeacherResourceProjection } from "@/lib/session/types";

function projection(mode?: TeacherResourceProjection["mode"]): TeacherResourceProjection {
  return { classroomId: "classroom-1", sceneId: "scene-1", stageKey: "launch", title: "演示", sceneType: "slide", startedAt: "2026-07-11T10:00:00.000Z", mode };
}

describe("student projection modes", () => {
  it("treats legacy and forced projections as forced", () => {
    expect(isForcedProjection(projection())).toBe(true);
    expect(isForcedProjection(projection("forced"))).toBe(true);
  });

  it("keeps optional projection opt-in", () => {
    expect(isOptionalProjection(projection("optional"))).toBe(true);
    expect(isForcedProjection(projection("optional"))).toBe(false);
  });
});
