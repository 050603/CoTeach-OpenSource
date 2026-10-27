"use client";

import { Toaster } from "sonner";

export { toast } from "sonner";

export function AppToaster() {
  return (
    <Toaster
      closeButton
      duration={4_000}
      offset={24}
      position="bottom-right"
      richColors={false}
      visibleToasts={3}
      toastOptions={{
        classNames: {
          toast: "!rounded-[var(--radius-md)] !border-[var(--pbl-border)] !bg-[var(--pbl-surface-raised)] !text-[var(--pbl-text)] !shadow-[var(--shadow-floating)]",
          description: "!text-[var(--pbl-text-muted)]",
        },
      }}
    />
  );
}
