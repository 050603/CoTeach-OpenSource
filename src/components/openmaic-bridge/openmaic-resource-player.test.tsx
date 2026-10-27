import { describe, expect, it } from "vitest";
import { getStageExperienceCapabilities } from "@openmaic/components/stage-experience";

describe("OpenMAIC stage experiences", () => {
  it("teacher resources keep only minimal playback controls", () => {
    expect(getStageExperienceCapabilities("teacher-resource")).toMatchObject({
      showSidebar: false,
      showHeader: false,
      showRoundtable: false,
      showChat: false,
      showCourseComplete: false,
      showMinimalControls: true,
      showPlaybackControls: false,
      showNarration: false,
      readOnly: false,
    });
  });

  it("student projection is read-only and has no player chrome", () => {
    expect(getStageExperienceCapabilities("projected-readonly")).toMatchObject({
      showSidebar: false,
      showHeader: false,
      showRoundtable: false,
      showChat: false,
      showCourseComplete: false,
      showMinimalControls: false,
      showPlaybackControls: true,
      showNarration: true,
      readOnly: true,
    });
  });
});
