"use client";

import { Sparkles } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/** Compact generation mark used inside buttons and streamed placeholders. */
export function CourseGenerationGlyph({ className }: { className?: string }) {
  const reducedMotion = useReducedMotion();
  return (
    <span className={cn("relative inline-grid size-4 place-items-center", className)} aria-hidden>
      <motion.span
        className="absolute inset-0 rounded-full border border-current/30 border-t-current"
        animate={reducedMotion ? undefined : { rotate: 360 }}
        transition={{ duration: 1.3, repeat: Infinity, ease: "linear" }}
      />
      <Sparkles className="size-2" />
    </span>
  );
}
