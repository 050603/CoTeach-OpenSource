"use client";

import { useRef } from "react";
import { BookOpen } from "lucide-react";
import { Dialog } from "radix-ui";

export function ExperimentReferenceDialog({ open, title, note, onAcknowledge, onReturnFocus }: {
  open: boolean;
  title: string;
  note: string;
  onAcknowledge: () => void;
  onReturnFocus: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);

  return <Dialog.Root open={open}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[120] bg-stone-950/45" />
      <Dialog.Content
        className="pbl-platform-theme fixed left-1/2 top-1/2 z-[121] flex max-h-[calc(100dvh-24px)] w-[min(580px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-orange-200 bg-white shadow-2xl outline-none"
        onCloseAutoFocus={(event) => { event.preventDefault(); onReturnFocus(); }}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => { event.preventDefault(); heading.current?.focus(); }}
      >
        <div className="shrink-0 border-b border-orange-200 bg-orange-50 px-5 py-4 sm:px-7 sm:py-5">
          <p className="mb-2 inline-flex items-center gap-2 text-sm font-semibold text-orange-800"><BookOpen aria-hidden="true" size={20} />作答前，请留意</p>
          <Dialog.Title className="text-xl font-bold leading-8 text-orange-950 outline-none" ref={heading} tabIndex={-1}>先读懂题目中的指代</Dialog.Title>
        </div>
        <div aria-label="指代说明内容" className="min-h-0 overflow-y-auto overscroll-contain px-5 py-5 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-orange-700 sm:px-7" role="region" tabIndex={0}>
          <p className="mb-4 text-sm font-semibold leading-6 text-stone-600 [overflow-wrap:anywhere]">{title}</p>
          <Dialog.Description className="whitespace-pre-wrap text-lg font-semibold leading-9 text-orange-950 [overflow-wrap:anywhere]">{note}</Dialog.Description>
          <p className="mt-4 text-sm leading-6 text-stone-600">请按以上含义理解本题组中的相关表述，再根据你的真实体验作答。</p>
        </div>
        <div className="shrink-0 border-t border-stone-200 px-5 py-4 sm:px-7">
          <button className="min-h-12 w-full rounded-xl bg-orange-700 px-4 py-3 text-sm font-bold leading-6 text-white hover:bg-orange-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700" onClick={onAcknowledge} type="button">我已阅读，开始作答</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
