import { createHash } from "node:crypto";
import { getRedisClient } from "@/lib/redis/client";
import { RateLimiter } from "@/lib/auth/rate-limit";

type Result = { allowed: boolean; remaining: number; retryAfterMs: number };
type Options = { namespace: string; key: string; limit: number; windowSeconds: number };

const localFallbacks = new Map<string, RateLimiter>();
let lastFallbackLogAt = Number.NEGATIVE_INFINITY;
const FALLBACK_LOG_INTERVAL_MS = 30_000;

const FIXED_WINDOW_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { count, ttl }
`;

export async function checkDistributedRateLimit(options: Options): Promise<Result> {
  let redis: Awaited<ReturnType<typeof getRedisClient>>;
  try {
    redis = await getRedisClient();
  } catch (error) {
    logFallback(error);
    return localFallback(options);
  }
  if (!redis) return localFallback(options);

  const redisKey = `openpbl:rate:${options.namespace}:${digest(options.key)}`;
  const windowMs = options.windowSeconds * 1_000;
  try {
    const result = (await redis.eval(FIXED_WINDOW_SCRIPT, {
      keys: [redisKey],
      arguments: [String(windowMs)],
    })) as [number, number];
    const count = Number(result[0]);
    const ttl = Math.max(0, Number(result[1]));
    return {
      allowed: count <= options.limit,
      remaining: Math.max(0, options.limit - count),
      retryAfterMs: count <= options.limit ? 0 : ttl,
    };
  } catch (error) {
    // Authentication and classroom writes remain protected by a bounded
    // in-process limiter while Redis reconnects. This is intentionally an
    // availability fallback; normal operation still uses the shared counter.
    logFallback(error);
    return localFallback(options);
  }
}

export async function resetDistributedRateLimit(namespace: string, key: string): Promise<void> {
  for (const [id, limiter] of localFallbacks) {
    if (id.startsWith(`${namespace}:`)) limiter.reset(key);
  }
  try {
    const redis = await getRedisClient();
    if (!redis) return;
    await redis.del(`openpbl:rate:${namespace}:${digest(key)}`);
  } catch (error) {
    logFallback(error);
  }
}

function localFallback(options: Options): Result {
  const id = `${options.namespace}:${options.limit}:${options.windowSeconds}`;
  let limiter = localFallbacks.get(id);
  if (!limiter) {
    limiter = new RateLimiter({
      limit: options.limit,
      windowMs: options.windowSeconds * 1_000,
    });
    localFallbacks.set(id, limiter);
  }
  return limiter.check(options.key);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function logFallback(error: unknown): void {
  const now = Date.now();
  if (now - lastFallbackLogAt < FALLBACK_LOG_INTERVAL_MS) return;
  lastFallbackLogAt = now;
  console.error("[rate-limit] Redis unavailable; using local fallback", {
    error: error instanceof Error ? error.message : String(error),
  });
}

export function __resetDistributedRateLimitsForTests(): void {
  localFallbacks.clear();
  lastFallbackLogAt = Number.NEGATIVE_INFINITY;
}
