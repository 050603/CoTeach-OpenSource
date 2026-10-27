"use client";

import { useMemo, useState } from "react";
import type { TeacherPresentationMode } from "@/lib/classroom/presentation";
import type { Course } from "@/lib/session/types";
import { deriveProjectPracticeRows } from "@/lib/classroom/project-practice-analytics";
import { StageTaskPresentation, type ProjectTimerControls } from "./stage-task-presentation";
import { StudentWorkPresentation } from "./student-work-presentation";

/** The practice stage owns only its teaching and artifact surfaces. */
export function AiCollaborationTeacherMonitor({ course, presentation = "teaching", showStudentWork = false, projectTimerControls, selectedStudentId, onSelectStudent }: {
  course: Course;
  presentation?: TeacherPresentationMode;
  showStudentWork?: boolean;
  projectTimerControls?: ProjectTimerControls;
  selectedStudentId?: string;
  onSelectStudent?: (studentId: string) => void;
}) {
  const rows = useMemo(() => deriveProjectPracticeRows(course), [course]);
  const [localStudentId, setLocalStudentId] = useState<string>();
  return <>
    <StudentWorkPresentation active={presentation !== "analytics" && showStudentWork} key={course.id} rows={rows} selectedStudentId={selectedStudentId ?? localStudentId} onSelectStudent={onSelectStudent ?? setLocalStudentId} />
    {presentation !== "analytics" && !showStudentWork ? <div className="teacher-presentation-content"><StageTaskPresentation course={course} timerControls={projectTimerControls} /></div> : null}
  </>;
}
