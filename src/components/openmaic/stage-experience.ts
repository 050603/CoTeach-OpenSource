import type { EngineMode, PlaybackSnapshot } from "@openmaic/lib/playback";

export type StageExperience = "student-course" | "teacher-resource" | "projected-readonly";

export type PlaybackSyncState = {
  version: number;
  engineMode: EngineMode;
  snapshot: PlaybackSnapshot;
};

export function getStageExperienceCapabilities(experience: StageExperience) {
  return {
    isStudentCourse: experience === "student-course",
    showSidebar: experience === "student-course",
    showHeader: experience === "student-course",
    showHeaderControls: false,
    showRoundtable: experience === "student-course",
    showCompanionArea: false,
    showChat: experience === "student-course",
    showCourseComplete: experience === "student-course",
    showMinimalControls: experience === "teacher-resource",
    showPlaybackControls: experience === "student-course" || experience === "projected-readonly",
    showNarration: experience === "student-course" || experience === "projected-readonly",
    readOnly: experience === "projected-readonly",
  } as const;
}
