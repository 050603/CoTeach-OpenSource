"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function WizardStepper({
  steps,
  current,
}: {
  steps: { key: string; label: string }[];
  current: number;
}) {
  return (
    <ol className="flex items-center gap-3 overflow-x-auto py-1">
      {steps.map((step, index) => {
        const state =
          index < current ? "done" : index === current ? "current" : "todo";
        return (
          <li className="flex shrink-0 items-center gap-3" key={step.key}>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-full text-sm font-bold",
                  state === "done" && "bg-[var(--pbl-success)] text-white",
                  state === "current" && "bg-[var(--pbl-teacher)] text-white",
                  state === "todo" && "bg-stone-200 text-stone-500",
                )}
              >
                {state === "done" ? <Check size={14} /> : index + 1}
              </span>
              <span
                className={cn(
                  "text-sm font-semibold",
                  state === "current" && "text-[var(--pbl-teacher)]",
                  state === "done" && "text-[var(--pbl-success)]",
                  state === "todo" && "text-stone-500",
                )}
              >
                {step.label}
              </span>
            </div>
            {index < steps.length - 1 ? (
              <span
                className={cn(
                  "h-px w-10 shrink-0",
                  state === "done" ? "bg-emerald-300" : "bg-stone-200",
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
