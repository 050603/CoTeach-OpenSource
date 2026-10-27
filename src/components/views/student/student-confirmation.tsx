"use client";

import { useCallback, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import type { CompanionConfirmationAction, Course } from "@/lib/session/types";
import { useSession } from "@/lib/session/store";
import { PrimaryButton } from "@/components/ui";

export type StudentConfirmationIntent = {
  action: CompanionConfirmationAction;
  title: string;
  summary: string;
  payload?: Record<string, unknown>;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
};

export type PendingStudentConfirmation = StudentConfirmationIntent & { id: string };

export function useStudentActionConfirmation({ course, stageKey }: { course?: Course; stageKey: string }) {
  const session = useSession();
  const [pending, setPending] = useState<PendingStudentConfirmation | null>(null);
  const [busy, setBusy] = useState(false);

  const request = useCallback((intent: StudentConfirmationIntent): boolean => {
    if (!course || !session.studentId) return false;
    const record = session.upsertCompanionConfirmation({
      courseId: course.id,
      studentId: session.studentId,
      stageKey,
      action: intent.action,
      title: intent.title,
      summary: intent.summary,
      payload: intent.payload,
      status: "pending",
    });
    setPending({ ...intent, id: record.id });
    return true;
  }, [course, session, stageKey]);

  const reject = useCallback(() => {
    if (!course || !pending) return;
    session.resolveCompanionConfirmation(course.id, pending.id, "rejected");
    setPending(null);
  }, [course, pending, session]);

  const confirm = useCallback(async () => {
    if (!course || !pending || busy) return;
    setBusy(true);
    try {
      await pending.onConfirm();
      session.resolveCompanionConfirmation(course.id, pending.id, "confirmed");
      setPending(null);
    } catch {
      // The action owns its user-facing error state. Keep the confirmation open
      // when it throws so the student can retry without losing intent.
    } finally {
      setBusy(false);
    }
  }, [busy, course, pending, session]);

  return { pending, busy, request, reject, confirm };
}

export function StudentActionConfirmationDialog({
  pending,
  busy,
  onConfirm,
  onReject,
}: {
  pending: PendingStudentConfirmation | null;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  if (!pending) return null;
  return (
    <div aria-labelledby="student-confirmation-title" aria-modal="true" className="fixed inset-0 z-[80] grid place-items-center bg-stone-950/35 p-4 backdrop-blur-[2px]" role="dialog">
      <div className="w-full max-w-md rounded-[18px] border border-stone-200 bg-white p-5 shadow-[0_24px_80px_rgba(15,23,42,0.22)]">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-50 text-rose-600"><AlertTriangle size={19} /></span>
          <div className="min-w-0"><h2 className="text-lg font-bold text-stone-900" id="student-confirmation-title">确认这个正式操作？</h2><p className="mt-1 text-xs leading-5 text-stone-500">伴学伙伴只能提出建议，正式写入课堂记录前必须由你明确确认。</p></div>
          <button aria-label="关闭确认窗口" className="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-stone-700" onClick={onReject} type="button"><X size={18} /></button>
        </div>
        <div className="mt-5 rounded-[12px] border border-rose-100 bg-[#fff9f7] p-4"><p className="text-sm font-bold text-stone-900">{pending.title}</p><p className="mt-2 text-sm leading-6 text-stone-600">{pending.summary}</p></div>
        <div className="mt-5 flex flex-wrap justify-end gap-2"><PrimaryButton onClick={onReject} variant="outline" tone="slate">先不做</PrimaryButton><PrimaryButton disabled={busy} onClick={onConfirm} tone="green">{busy ? "处理中…" : <><Check size={16} />确认并继续</>}</PrimaryButton></div>
      </div>
    </div>
  );
}
