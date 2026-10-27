'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { PreparationShell } from '@/components/teacher/preparation-shell';
import { TeacherClassroomEditor } from '@/components/openmaic-bridge/teacher-classroom-editor';
import { useCourse, useHydrated, useSession } from '@/lib/session/store';
import { resolvePreparationReturnHref } from '@/lib/courses/preparation-navigation';

export default function TeacherClassroomEditorPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const session = useSession();
  const hydrated = useHydrated();
  const course = useCourse(params?.id);
  const previewHref = resolvePreparationReturnHref(searchParams.get('returnTo'), params.id);

  if (!hydrated) {
    return (
      <PreparationShell backHref={previewHref} backLabel="返回课程详情" role="teacher" userName={session.user.name} variant="bare">
        <div className="grid min-h-72 place-items-center text-sm text-stone-500">正在打开课堂编辑器…</div>
      </PreparationShell>
    );
  }
  if (!course) {
    return (
      <PreparationShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher" userName={session.user.name} variant="bare">
        <div className="grid min-h-72 place-items-center text-center text-sm text-stone-500">
          <div>
            <p>未找到可编辑课程。</p>
            <Link className="mt-3 inline-block font-semibold text-blue-700 hover:underline" href="/teacher/templates">
              返回课程列表
            </Link>
          </div>
        </div>
      </PreparationShell>
    );
  }

  return (
    <TeacherClassroomEditor
      backHref={previewHref}
      courseId={course.id}
      courseName={course.name}
      initialElementId={searchParams.get('elementId')?.trim() || undefined}
      initialSceneId={searchParams.get('sceneId')?.trim() || undefined}
    />
  );
}
