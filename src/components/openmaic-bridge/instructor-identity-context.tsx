"use client";

import { createContext, useContext, type ReactNode } from "react";

export type InstructorIdentity = {
  name: string;
  avatar: string;
};

const InstructorIdentityContext = createContext<InstructorIdentity | null>(null);

export function InstructorIdentityProvider({
  children,
  value,
}: {
  children: ReactNode;
  value?: InstructorIdentity;
}) {
  return (
    <InstructorIdentityContext.Provider value={value ?? null}>
      {children}
    </InstructorIdentityContext.Provider>
  );
}

export function useInstructorIdentity(): InstructorIdentity | null {
  return useContext(InstructorIdentityContext);
}
