"use client";

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type FormFieldProps = {
  children: (field: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
  className?: string;
  description?: string;
  error?: string;
  id?: string;
  label: string;
  optional?: boolean;
};

export function FormField({ children, className, description, error, id: idProp, label, optional = false }: FormFieldProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-sm font-semibold text-[var(--pbl-text)]" htmlFor={id}>{label}</label>
        {optional ? <span className="text-xs text-[var(--pbl-text-muted)]">可选</span> : null}
      </div>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {description ? <p className="text-sm text-[var(--pbl-text-muted)]" id={descriptionId}>{description}</p> : null}
      {error ? <p className="text-sm font-medium text-[var(--pbl-danger)]" id={errorId} role="alert">{error}</p> : null}
    </div>
  );
}

const controlClass = "min-h-11 w-full rounded-[var(--radius-xs)] border border-[var(--pbl-border-strong)] bg-[var(--pbl-surface)] px-3 text-sm text-[var(--pbl-text)] outline-none transition-colors placeholder:text-[var(--pbl-text-subtle)] focus:border-[var(--pbl-teacher)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--pbl-teacher)_18%,transparent)] disabled:cursor-not-allowed disabled:bg-[var(--pbl-surface-soft)] disabled:text-[var(--pbl-text-muted)] aria-invalid:border-[var(--pbl-danger)] aria-invalid:ring-[color-mix(in_srgb,var(--pbl-danger)_16%,transparent)]";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlClass, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(controlClass, "min-h-28 resize-y py-3 leading-6", className)} {...props} />;
}

export function NativeSelect({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(controlClass, className)} {...props} />;
}
