import type { TeacherPresentationMode } from "@/lib/classroom/presentation";
import type { Course, StageViewKey } from "@/lib/session/types";
import type { TeacherStageFocus } from "@/lib/classroom/teacher-dashboard-metrics";
import type { ShowcasePresentationController } from "@/hooks/use-showcase-presentation";
import type { TeacherFullscreenController } from "@/hooks/use-teacher-presentation";
import { AiLearningTeacherView } from "./ai-learning";
import { NewExperimentPosttestTeacherView } from "./experiment-posttest";
import { SimplifiedTeacherStageView } from "@/components/classroom/simple-stage-resources";
import { AiCollaborationTeacherMonitor } from "./ai-collaboration-monitor";
import type { ProjectTimerControls } from "./stage-task-presentation";
import { NewShowcaseTeacherView } from "./showcase-reporting";
import { TeacherPblEvaluation } from "@/components/evaluation/teacher-evaluation";

/**
 * Teacher-side stage view dispatcher.
 * Renders a different UI per stage, focused on:
 *  - 课堂整体进度
 *  - 需关注的学生
 *  - 切换查看各组作品/方案
 *  - 实时打分与评价
 */
export function TeacherStageView({
  active = true,
  view,
  course,
  onSelectStudent,
  focus,
  showcaseController,
  fullscreen,
  presentation = "workspace",
  immersive = false,
  projectTimerControls,
  showStudentWork = false,
  selectedPracticeStudentId,
}: {
  active?: boolean;
  presentation?: TeacherPresentationMode;
  immersive?: boolean;
  view: StageViewKey;
  course: Course;
  onSelectStudent?: (studentId: string) => void;
  focus?: TeacherStageFocus;
  showcaseController?: ShowcasePresentationController;
  fullscreen?: TeacherFullscreenController;
  projectTimerControls?: ProjectTimerControls;
  showStudentWork?: boolean;
  selectedPracticeStudentId?: string;
}) {
  const currentStage = course.stages[course.currentStageIndex];
  const normalizedView = course.evaluationContractVersion === 2 && currentStage?.key === "reflection"
    ? "pbl-evaluation"
    : view === "simple-resource"
    && currentStage?.key === "showcase"
    ? "showcase-reporting"
    : view === "simple-resource"
      && currentStage?.key === "reflection"
      ? "experiment-posttest"
    : view === "reflection-survey" || view === "reflection"
      ? "experiment-posttest"
    : view;
  switch (normalizedView) {
    case "ai-learning":
      return (
        <AiLearningTeacherView
          active={active}
          immersive={immersive}
          presentation={presentation}
          course={course}
          onSelectStudent={onSelectStudent}
          focus={focus?.stageKey === "ai-learning" ? focus : undefined}
        />
      );
    case "simple-resource":
      return (
        <SimplifiedTeacherStageView
          presentation={presentation}
          course={course}
          stageKey={course.stages[course.currentStageIndex]?.key ?? "launch"}
          focus={focus?.stageKey === "launch" ? focus : undefined}
        />
      );
    case "ai-collaboration":
      return <AiCollaborationTeacherMonitor course={course} presentation={presentation} showStudentWork={showStudentWork} selectedStudentId={selectedPracticeStudentId} onSelectStudent={onSelectStudent} projectTimerControls={projectTimerControls} />;
    case "showcase-reporting":
      return <NewShowcaseTeacherView immersive={immersive} course={course} presentation={presentation} focus={focus?.stageKey === "showcase" ? focus : undefined} controller={showcaseController} fullscreen={fullscreen} />;
    case "experiment-posttest":
      return <NewExperimentPosttestTeacherView course={course} presentation={presentation} focus={focus?.stageKey === "reflection" ? focus : undefined} />;
    case "pbl-evaluation":
      return course.evaluationContractVersion === 2 ? <TeacherPblEvaluation course={course} presentation={presentation} /> : <NewExperimentPosttestTeacherView course={course} presentation={presentation} />;
    default:
      return (
        <SimplifiedTeacherStageView
          presentation={presentation}
          course={course}
          stageKey={currentStage?.key ?? "launch"}
          focus={focus?.stageKey === "launch" ? focus : undefined}
        />
      );
  }
}
