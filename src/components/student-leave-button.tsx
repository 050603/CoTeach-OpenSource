"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { useSession } from "@/lib/session/store";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui";

export function StudentLeaveButton({
  redirectTo = "/student",
  label = "离开课堂",
  className,
}: {
  redirectTo?: string;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const { leaveClass, joinedCourseId } = useSession();

  async function handleClick() {
    if (joinedCourseId) {
      await fetch(`/api/courses/${encodeURIComponent(joinedCourseId)}/presence`, {
        method: "DELETE",
        headers: { "X-OpenPBL-Role": "student" },
        keepalive: true,
      }).catch(() => undefined);
    }
    const left = await leaveClass();
    if (!left) return;
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "X-OpenPBL-Role": "student" },
    });
    if (!response.ok) return;
    router.replace(redirectTo);
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild><button
      className={
        "inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-stone-200 bg-white px-3 text-sm font-semibold text-stone-600 hover:bg-stone-50 " +
        (className ?? "")
      }
      type="button"
    >
      <LogOut size={15} /> {label}
      </button></AlertDialogTrigger>
      <AlertDialogContent><AlertDialogTitle>离开当前课堂？</AlertDialogTitle><AlertDialogDescription>离开后当前身份会退出课堂，再次进入需要重新输入邀请码。</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>继续学习</AlertDialogCancel><AlertDialogAction onClick={() => void handleClick()}>确认离开</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  );
}
