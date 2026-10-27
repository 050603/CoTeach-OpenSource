"use client";

import "./platform.css";
import "./desktop-layout.css";
import "./mobile-layout.css";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { SessionProvider } from "@/lib/session/store";

function StandaloneLearningSession({ children }: { children: ReactNode }) {
  const search = useSearchParams().toString();
  return <SessionProvider search={search}>{children}</SessionProvider>;
}

/** Course-platform pages use their own authenticated API, while classroom
 * implementation routes retain their existing session provider. */
export function PlatformSessionBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/internal/slide-layout-audit" || pathname === "/internal/slide-export") return children;
  if (pathname.startsWith("/student/ai-learning/")) {
    return <Suspense fallback={<div className="grid min-h-screen place-items-center bg-white text-sm text-stone-500">正在准备学习环境...</div>}>
      <StandaloneLearningSession>{children}</StandaloneLearningSession>
    </Suspense>;
  }
  const platformPage = pathname === "/student" || pathname === "/student/profile" || pathname === "/teacher" ||
    ["/student/login", "/student/register", "/student/reset-password", "/student/courses", "/student/activities", "/student/participations", "/teacher/participations", "/teacher/classrooms", "/teacher/classes", "/teacher/activities", "/teacher/surveys", "/teacher/templates", "/teacher/textbooks", "/teacher/login", "/teacher/register"].some((path) => pathname === path || pathname.startsWith(`${path}/`));
  if (pathname === "/teacher/settings" || pathname.startsWith("/teacher/settings/")) {
    return <SessionProvider><div className="pbl-platform-theme">{children}</div></SessionProvider>;
  }
  return platformPage ? <div className="pbl-platform-theme">{children}</div> : <SessionProvider>{children}</SessionProvider>;
}
