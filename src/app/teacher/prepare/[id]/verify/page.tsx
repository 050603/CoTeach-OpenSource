"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PreparationShell } from "@/components/teacher/preparation-shell";
import { FastCourseGenerator } from "@/components/teacher/fast-course-generator";
import { courseDetailedEditHref } from "@/lib/courses/preparation-navigation";
import { useCourse, useHydrated, useSession } from "@/lib/session/store";

export default function VerifyCoursePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useSession();
  const course = useCourse(params?.id);
  const hydrated = useHydrated();
  const [teacherId, setTeacherId] = useState<string | null>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/me", { cache: "no-store", headers: { "X-OpenPBL-Role": "teacher" }, signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        const id = data?.user?.sub ?? data?.user?.id;
        if (!controller.signal.aborted) setTeacherId(data?.user?.role === "teacher" && typeof id === "string" ? id : null);
      }).catch(() => { if (!controller.signal.aborted) setTeacherId(null); });
    return () => controller.abort();
  }, []);

  if (!hydrated) {
    return (
      <PreparationShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">加载中…</div>
      </PreparationShell>
    );
  }

  if (!course) {
    return (
      <PreparationShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">
          未找到课程。
          <Link className="mt-4 text-[var(--pbl-teacher)] hover:underline" href="/teacher/templates">
            返回课程列表
          </Link>
        </div>
      </PreparationShell>
    );
  }

  return (
    <PreparationShell
      backHref="/teacher/templates"
      backLabel="返回课程库"
      role="teacher"
      userName={user.name}
      variant="bare"
      currentCourse={{ id: course.id, name: course.name, status: course.status }}
    >
      {teacherId === undefined ? <p className="py-10 text-center text-sm text-slate-500">正在读取备课身份…</p> : <FastCourseGenerator
        course={course}
        teacherId={teacherId ?? undefined}
        onOpenDetailed={() => router.push(courseDetailedEditHref(course.id))}
        simplified
      />}
    </PreparationShell>
  );
}
