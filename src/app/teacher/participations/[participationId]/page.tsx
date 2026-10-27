import { ClassroomWorkspace } from "@/components/platform/classroom-workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ participationId: string }>; searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const returnTo = (await searchParams).returnTo;
  // Only local record-list routes may become the back link; retain their filters.
  let returnHref: string | undefined;
  if (typeof returnTo === "string" && !/[\\\u0000-\u0020]/.test(returnTo)) {
    try {
      const url = new URL(returnTo, "https://coteach.local");
      if (returnTo.startsWith("/") && url.origin === "https://coteach.local" && /^\/teacher\/(?:classes\/[A-Za-z0-9_-]+\/students|classrooms\/[A-Za-z0-9_-]+)\/?$/.test(url.pathname)) returnHref = `${url.pathname}${url.search}`;
    } catch { /* Invalid return paths use the current classroom list. */ }
  }
  return <ClassroomWorkspace role="teacher" participationId={(await params).participationId} returnHref={returnHref} />;
}
