"use client";

import { useCallback, useEffect, useRef } from "react";

type NavigationRequest = { href: string; proceed: () => void };
const HISTORY_POSITION = "__coteachPreparationPosition";

/** Protect links and history traversal before the App Router discards an editor. */
export function useUnsavedNavigation({
  dirty,
  onRequest,
  navigate,
}: {
  dirty: boolean;
  onRequest: (request: NavigationRequest) => void;
  navigate: (href: string) => void;
}) {
  const latest = useRef({ dirty, onRequest, navigate });
  useEffect(() => { latest.current = { dirty, onRequest, navigate }; }, [dirty, onRequest, navigate]);

  const allowNavigation = useCallback((action: () => void) => {
    latest.current.dirty = false;
    action();
  }, []);

  useEffect(() => {
    let position = Number.isFinite(history.state?.[HISTORY_POSITION]) ? history.state[HISTORY_POSITION] as number : 0;
    let restoring = false;
    let afterRestore: (() => void) | undefined;
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    const withPosition = (data: unknown, value: number) => ({ ...(data && typeof data === "object" ? data : {}), [HISTORY_POSITION]: value });
    originalReplace.call(history, withPosition(history.state, position), "");
    const push: History["pushState"] = function (data, unused, url) {
      position += 1;
      originalPush.call(history, withPosition(data, position), unused, url);
    };
    const replace: History["replaceState"] = function (data, unused, url) {
      // App Router may commit a replacement while a blocked history traversal
      // is being restored. Keep the destination entry's own position intact;
      // overwriting it with the editor's position would bypass the next guard.
      const entryPosition = history.state?.[HISTORY_POSITION];
      originalReplace.call(history, withPosition(data, Number.isFinite(entryPosition) ? entryPosition : position), unused, url);
    };
    history.pushState = push;
    history.replaceState = replace;

    const click = (event: MouseEvent) => {
      if (!latest.current.dirty || event.defaultPrevented || event.button !== 0
        || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.download || (anchor.target && anchor.target !== "_self")) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin || url.href === location.href) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      event.preventDefault();
      event.stopPropagation();
      const href = `${url.pathname}${url.search}${url.hash}`;
      latest.current.onRequest({ href, proceed: () => allowNavigation(() => latest.current.navigate(href)) });
    };
    const pop = (event: PopStateEvent) => {
      if (restoring) {
        event.stopImmediatePropagation();
        restoring = false;
        const resume = afterRestore;
        afterRestore = undefined;
        resume?.();
        return;
      }
      const target = Number.isFinite(event.state?.[HISTORY_POSITION]) ? event.state[HISTORY_POSITION] as number : position - 1;
      if (!latest.current.dirty || target === position) {
        position = target;
        originalReplace.call(history, withPosition(event.state, position), "");
        return;
      }
      event.stopImmediatePropagation();
      const href = `${location.pathname}${location.search}${location.hash}`;
      const delta = position - target;
      restoring = true;
      afterRestore = () => latest.current.onRequest({ href, proceed: () => allowNavigation(() => history.go(-delta)) });
      history.go(delta);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!latest.current.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    document.addEventListener("click", click, true);
    window.addEventListener("popstate", pop, true);
    window.addEventListener("beforeunload", unload);
    return () => {
      document.removeEventListener("click", click, true);
      window.removeEventListener("popstate", pop, true);
      window.removeEventListener("beforeunload", unload);
      if (history.pushState === push) history.pushState = originalPush;
      if (history.replaceState === replace) history.replaceState = originalReplace;
    };
  }, [allowNavigation]);

  return allowNavigation;
}
