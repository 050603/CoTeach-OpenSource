import { createClient, type RedisClientType } from "redis";

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;
const CONNECT_WAIT_TIMEOUT_MS = 2_500;
let lastUnavailableLogAt = Number.NEGATIVE_INFINITY;
let lastClientErrorLogAt = Number.NEGATIVE_INFINITY;
const UNAVAILABLE_LOG_INTERVAL_MS = 30_000;

export async function getRedisClient(): Promise<RedisClientType | null> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("REDIS_URL is required in production.");
    }
    return null;
  }
  if (client?.isReady) return client;
  // node-redis keeps reconnecting indefinitely. During that period isOpen is
  // true but commands would enter the offline queue and make HTTP requests
  // wait without a bound. Let callers degrade until the singleton reconnects.
  if (client?.isOpen && !connecting) return null;

  if (!connecting) {
    const next = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: (retries) => Math.min(50 * 2 ** retries, 2_000),
      },
    });
    next.on("error", (error) => {
      const now = Date.now();
      if (now - lastClientErrorLogAt < UNAVAILABLE_LOG_INTERVAL_MS) return;
      lastClientErrorLogAt = now;
      console.error("[redis] client error:", error instanceof Error ? error.message : error);
    });
    client = next as RedisClientType;
    const connection = next.connect()
      .then(() => next as RedisClientType)
      .catch((error) => {
        if (client === next) client = null;
        if (next.isOpen) next.destroy();
        throw error;
      });
    const tracked = connection.finally(() => {
      if (connecting === tracked) connecting = null;
    });
    connecting = tracked;
  }

  try {
    return await waitForConnection(connecting, CONNECT_WAIT_TIMEOUT_MS);
  } catch (error) {
    logUnavailable(error);
    return null;
  }
}

export async function closeRedisClient(): Promise<void> {
  const current = client;
  client = null;
  connecting = null;
  if (!current?.isOpen) return;
  if (current.isReady) await current.quit();
  else current.destroy();
}

async function waitForConnection(
  connection: Promise<RedisClientType>,
  timeoutMs: number,
): Promise<RedisClientType> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      connection,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Redis connection timed out.")),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function logUnavailable(error: unknown): void {
  const now = Date.now();
  if (now - lastUnavailableLogAt < UNAVAILABLE_LOG_INTERVAL_MS) return;
  lastUnavailableLogAt = now;
  console.error(
    "[redis] unavailable; request will use its configured fallback:",
    error instanceof Error ? error.message : error,
  );
}

export function __resetRedisClientForTests(): void {
  const current = client;
  client = null;
  connecting = null;
  lastUnavailableLogAt = Number.NEGATIVE_INFINITY;
  lastClientErrorLogAt = Number.NEGATIVE_INFINITY;
  if (current?.isOpen) current.destroy();
}
