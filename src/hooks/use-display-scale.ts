"use client";

import { useEffect, useState } from "react";

const BASE_ROOT_FONT_SIZE = 16;

export function readDisplayScale(): number {
  if (typeof window === "undefined") return 1;
  const rootFontSize = Number.parseFloat(
    window.getComputedStyle(document.documentElement).fontSize,
  );
  if (!Number.isFinite(rootFontSize) || rootFontSize <= 0) return 1;
  return Math.max(1, rootFontSize / BASE_ROOT_FONT_SIZE);
}

/** Keeps pixel-measured canvas rails aligned with the rem-based app shell. */
export function useDisplayScale(): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    let animationFrame = 0;
    const update = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => setScale(readDisplayScale()));
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", update);
    };
  }, []);

  return scale;
}

