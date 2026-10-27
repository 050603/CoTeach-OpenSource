"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Sparkles } from "lucide-react";
import { PreparationShell } from "@/components/teacher/preparation-shell";
import { useSession, useCourse, useHydrated } from "@/lib/session/store";
import { TeacherResourceViewer } from "@/components/openmaic-bridge/teacher-resource-viewer";

import { courseDetailHref, resolvePreparationReturnHref } from "@/lib/courses/preparation-navigation";

export default function TeacherResourcesPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const backHref = resolvePreparationReturnHref(searchParams.get("returnTo"), params.id, courseDetailHref(params.id, { view: "content" }));
  const { user } = useSession();
  const course = useCourse(params?.id);
  const hydrated = useHydrated();

  if (!hydrated) {
    return (
      <PreparationShell backHref={backHref} backLabel="返回课程详情" role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">加载中…</div>
      </PreparationShell>
    );
  }

  if (!course) {
    return (
      <PreparationShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">
          未找到课程。
          <Link className="mt-4 text-blue-700 hover:underline" href="/teacher/templates">
            返回课程列表
          </Link>
        </div>
      </PreparationShell>
    );
  }

  const teacherClassroomId = course.teacherClassroomId ?? course.content.teacherClassroomId;
  const teacherResources = course.content.teacherResources;

  // 无教师资源：提示教师先生成课程
  if (!teacherClassroomId) {
    return (
      <PreparationShell
        backHref={backHref}
        backLabel="返回课程详情"
        role="teacher"
        userName={user.name}
        variant="bare"
        currentCourse={{ id: course.id, name: course.name, status: course.status }}
      >
        <div className="mb-5 flex items-center gap-3">
          <div>
            <h1 className="text-[28px] font-bold">教师授课资源</h1>
          </div>
        </div>

        <div className="rounded-[12px] border border-dashed border-stone-200 bg-stone-50 p-10 text-center">
          <Sparkles className="mx-auto mb-3 text-stone-300" size={32} />
          <p className="text-sm text-stone-600">
            暂无教师授课资源。
          </p>
          <p className="mt-1 text-xs text-stone-400">
            可在课程详情的教学内容中查看现有课件、任务与讲稿。
          </p>
          <Link
            className="mt-5 inline-flex h-10 items-center gap-1.5 rounded-[6px] bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700"
            href={courseDetailHref(course.id, { view: "content" })}
          >
            查看教学内容
          </Link>
        </div>
      </PreparationShell>
    );
  }

  return (
    <PreparationShell
      backHref={backHref}
      backLabel="返回课程详情"
      role="teacher"
      userName={user.name}
      variant="bare"
      currentCourse={{ id: course.id, name: course.name, status: course.status }}
    >
      <TeacherResourceViewer
        teacherClassroomId={teacherClassroomId}
        teacherResources={teacherResources}
        courseName={course.name}
        backHref={backHref}
      />
    </PreparationShell>
  );
}
