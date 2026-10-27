"use client";

import { useEffect } from "react";

const RECOVERY_STORAGE_KEY = "openpbl:chunk-recovery-at";

export const CHUNK_RECOVERY_COOLDOWN_MS = 30_000;
export const CHUNK_RECOVERY_STABILITY_MS = 10_000;

function errorText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) {
    return String((value as { message?: unknown }).message ?? "");
  }
  return "";
}

export function isChunkLoadError(value: unknown): boolean {
  return /ChunkLoadError|Failed to load chunk|Loading chunk .* failed|Failed to fetch dynamically imported module|Importing a module script failed/i.test(
    errorText(value),
  );
}

export function claimChunkRecovery(
  storage: Pick<Storage, "getItem" | "setItem">,
  now = Date.now(),
): boolean {
  const stored = storage.getItem(RECOVERY_STORAGE_KEY);
  const previous = stored === null ? Number.NaN : Number(stored);
  if (Number.isFinite(previous) && now - previous < CHUNK_RECOVERY_COOLDOWN_MS) {
    return false;
  }
  storage.setItem(RECOVERY_STORAGE_KEY, String(now));
  return true;
}

async function discardObsoleteClientCaches(): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  if ("serviceWorker" in navigator) {
    tasks.push(
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
          Promise.allSettled(registrations.map((registration) => registration.unregister())),
        ),
    );
  }

  if ("caches" in window) {
    tasks.push(
      window.caches
        .keys()
        .then((keys) =>
          Promise.allSettled(
            keys
              .filter((key) => /openpbl|next|workbox/i.test(key))
              .map((key) => window.caches.delete(key)),
          ),
        ),
    );
  }

  await Promise.allSettled(tasks);
}

export function releaseChunkRecovery(
  storage: Pick<Storage, "removeItem">,
): void {
  storage.removeItem(RECOVERY_STORAGE_KEY);
}

/**
 * React can catch a rejected route transition before it reaches the global
 * error/unhandledrejection events. Keep the actual recovery operation shared
 * so both the root listener and app/error.tsx use the same loop guard.
 */
export function recoverFromChunkLoadError(reason: unknown): boolean {
  if (!isChunkLoadError(reason)) return false;

  try {
    if (!claimChunkRecovery(window.sessionStorage)) return false;
  } catch {
    // Storage can be unavailable in privacy modes. Reloading is still safer
    // than leaving the application on an unrecoverable stale module graph.
  }

  void discardObsoleteClientCaches().finally(() => window.location.reload());
  return true;
}

/**
 * A stale browser can request a chunk that a restarted dev server no longer
 * owns. Recover once with a hard page reload; the cooldown prevents a broken
 * deployment or network outage from causing an infinite refresh loop.
 */
export function ChunkLoadRecovery() {
  useEffect(() => {
    let recoveryStarted = false;

    const recover = (reason: unknown) => {
      if (recoveryStarted) return;
      recoveryStarted = recoverFromChunkLoadError(reason);
    };

    const onError = (event: ErrorEvent) => recover(event.error ?? event.message);
    const onUnhandledRejection = (event: PromiseRejectionEvent) => recover(event.reason);

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    const stableTimer = window.setTimeout(() => {
      try {
        releaseChunkRecovery(window.sessionStorage);
      } catch {
        // Storage can be unavailable in privacy modes.
      }
    }, CHUNK_RECOVERY_STABILITY_MS);
    return () => {
      window.clearTimeout(stableTimer);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
