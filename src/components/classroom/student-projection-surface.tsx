"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { Pill } from "@/components/ui";

/** Shared full-window surface for uploaded resources and teacher courseware. */
export function StudentProjectionSurface({
  title,
  projectionVersion,
  children,
  status,
}: {
  title: string;
  projectionVersion?: number;
  children: ReactNode;
  status?: ReactNode;
}) {
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-[150] bg-slate-100 outline-none"
          data-teacher-resource-projection
          data-projection-version={projectionVersion}
          onOpenAutoFocus={() => { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = previousFocus.current;
            if (target?.isConnected && target !== document.body) target.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <Dialog.Title className="sr-only">教师投屏：{title}</Dialog.Title>
          <section className="relative h-full w-full overflow-hidden bg-[var(--pbl-surface)]">
            <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex items-center justify-between gap-3 px-4">
              <div className="max-w-[70vw] truncate rounded-full bg-slate-950/65 px-3 py-1.5 text-xs font-semibold text-white/90 shadow-lg backdrop-blur"><span className="mr-2 text-white/55">教师投屏</span>{title}</div>
              <Pill className="shrink-0 bg-white/90 shadow-lg" tone="green">同步中</Pill>
            </div>
            <div aria-label="投屏内容" className="h-full min-h-0" role="region">{children}</div>
            {status ? <div className="absolute bottom-5 left-1/2 z-30 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-full border border-[var(--pbl-border)] bg-white/95 px-3 py-2 shadow-2xl backdrop-blur">{status}</div> : null}
          </section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
