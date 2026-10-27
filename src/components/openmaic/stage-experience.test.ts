import { describe, expect, it } from "vitest";
import { getStageExperienceCapabilities } from "./stage-experience";

describe("student course playback chrome", () => {
  it("keeps the original learning controls while removing unused authoring and companion chrome", () => {
    const capabilities = getStageExperienceCapabilities("student-course");

    expect(capabilities).toMatchObject({
      isStudentCourse: true,
      showSidebar: true,
      showHeader: true,
      showHeaderControls: false,
      showRoundtable: true,
      showCompanionArea: false,
      showChat: true,
      showPlaybackControls: true,
      showNarration: true,
    });
  });
});
