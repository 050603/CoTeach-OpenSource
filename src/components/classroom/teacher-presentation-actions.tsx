"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const ActionsTarget = createContext<HTMLElement | null>(null);
const LeadingActionsTarget = createContext<HTMLElement | null>(null);

export function TeacherPresentationActionsProvider({ target, leadingTarget = null, children }: { target: HTMLElement | null; leadingTarget?: HTMLElement | null; children: ReactNode }) {
  return <ActionsTarget.Provider value={target}><LeadingActionsTarget.Provider value={leadingTarget}>{children}</LeadingActionsTarget.Provider></ActionsTarget.Provider>;
}

/** Keep stage actions with their existing controller and local state. */
export function TeacherPresentationActions({ children, inlineFallback = false }: { children: ReactNode; inlineFallback?: boolean }) {
  const target = useContext(ActionsTarget);
  return target ? createPortal(children, target) : inlineFallback ? children : null;
}

export function TeacherPresentationLeadingActions({ children, inlineFallback = false }: { children: ReactNode; inlineFallback?: boolean }) {
  const target = useContext(LeadingActionsTarget);
  return target ? createPortal(children, target) : inlineFallback ? children : null;
}
