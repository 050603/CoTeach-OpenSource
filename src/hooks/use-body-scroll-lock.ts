import { useEffect } from "react";

let locks = 0;
let originalOverflow = "";

/** Overlapping classroom surfaces must release the body lock together. */
export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    if (locks++ === 0) originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      if (--locks === 0) document.body.style.overflow = originalOverflow;
    };
  }, [locked]);
}
