"use client";

import { useCallback, useState } from "react";

/** Keep the editor toolbar below a sticky action header, including wrapped rows. */
export function useWorkspaceToolbarOffset() {
  const [toolbarTop, setToolbarTop] = useState(140);
  const headerRef = useCallback((header: HTMLElement | null) => {
    if (!header) return;
    const update = () => {
      const stickyTop = Number.parseFloat(window.getComputedStyle(header).top) || 0;
      setToolbarTop(stickyTop + header.getBoundingClientRect().height + 12);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  return { headerRef, toolbarTop };
}
