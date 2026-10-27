"use client";

import { useRef, type ReactNode } from "react";
import { Drawer, DrawerContent, DialogDescription, DialogTitle } from "@/components/ui";
import styles from "./teacher-operation-details.module.css";

/** Secondary classroom lists share one responsive surface in every window size. */
export function TeacherOperationDrawer({ open, onOpenChange, title, description, children, wide = false }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const previousFocus = useRef<HTMLElement | null>(null);
  return <Drawer open={open} onOpenChange={onOpenChange}>
    <DrawerContent className={`${styles.root} ${styles.drawer} ${wide ? styles.wideDrawer : ""}`} onOpenAutoFocus={() => {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }} onCloseAutoFocus={(event) => {
      event.preventDefault();
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    }}>
      <header className={styles.drawerHeader}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </header>
      <div className={styles.drawerBody}>{children}</div>
    </DrawerContent>
  </Drawer>;
}

export { styles as teacherOperationStyles };
