"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { CodeAiCollaboration } from "@/components/views/student/code-ai-collaboration";
import { DocumentAiCollaboration } from "@/components/views/student/document-ai-collaboration";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { useCourse, useHydrated } from "@/lib/session/store";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import { OtherArtifactCollaboration } from "@/components/views/student/other-artifact-collaboration";
import { StudentResourceProjection } from "@/components/classroom/simple-stage-resources";
import { StudentShowcaseProvider } from "@/components/showcase/student-showcase-projection";

export default function StudentAiCollaborationPage() {
  const params = useParams<{ id: string }>();
  const course = useCourse(params.id);
  return <StudentShowcaseProvider course={course}><StudentAiCollaborationContent /></StudentShowcaseProvider>;
}

function StudentAiCollaborationContent() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const course = useCourse(params.id);
  const hydrated = useHydrated();
  useRealtimeSync(params.id);
  const currentStage = course?.stages[course.currentStageIndex];
  const makeArtifactMode = normalizePblCourseConfig(course?.pblConfig).makeArtifactMode;
  const returningToClassroom = Boolean(
    hydrated
    && course
    && (course.status !== "teaching"
      || currentStage?.view !== "ai-collaboration"),
  );
  const artifactType = makeArtifactMode === "python" || makeArtifactMode === "c"
    ? makeArtifactMode
    : "document";

  useEffect(() => {
    if (!returningToClassroom || !course) return;
    router.replace(`/student/classroom/${course.id}`);
  }, [course, returningToClassroom, router]);

  if (returningToClassroom) {
    return (
      <div className="grid min-h-screen place-items-center bg-[var(--pbl-bg)] text-sm text-stone-500">
        正在进入新的课堂阶段…
      </div>
    );
  }

  const uploadedProjection = course?.uiState?.resourceProjection?.stageKey === currentStage?.key
    ? course?.uiState?.resourceProjection : undefined;
  const projectedResource = uploadedProjection
    ? course?.resources?.find(resource => resource.id === uploadedProjection.resourceId) : undefined;
  const workspace = currentStage?.key === "make" && makeArtifactMode === "other"
    ? <OtherArtifactCollaboration courseId={params.id} />
    : artifactType === "python" || artifactType === "c" ? (
      <CodeAiCollaboration
        courseId={params.id}
        language={artifactType}
      />
    ) : <DocumentAiCollaboration courseId={params.id} />;

  return (
    <>
      <div inert={Boolean(projectedResource && uploadedProjection)}>{workspace}</div>
      {projectedResource && uploadedProjection ? (
        <StudentResourceProjection course={course} projection={uploadedProjection} resource={projectedResource} />
      ) : null}
    </>
  );
}
