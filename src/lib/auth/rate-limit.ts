import { isIP } from "node:net";
//
// Strategy: bucket by key (IP + username for login, IP+userId for API), count
// requests in window, reject when over limit. Buckets expire after window.

interface Bucket {
  count: number;
  resetAt: number;
}

export interface LimiterOptions {
  /** Maximum requests allowed within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const MAX_BUCKETS = 10_000;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastCleanup = Date.now();

  constructor(private readonly options: LimiterOptions) {}

  /**
   * Check whether the key is allowed to perform one more action.
   * Returns `{ allowed, remaining, retryAfterMs }`.
   */
  check(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    this.maybeCleanup();
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      const resetAt = now + this.options.windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.options.limit - 1, retryAfterMs: 0 };
    }

    if (bucket.count >= this.options.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: bucket.resetAt - now,
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: this.options.limit - bucket.count,
      retryAfterMs: 0,
    };
  }

  /** Reset a key's bucket (e.g., on successful login). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < DEFAULT_CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;
    if (this.buckets.size < MAX_BUCKETS) return;
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) this.buckets.delete(k);
    }
  }
}

// Pre-configured limiters
export const loginLimiter = new RateLimiter({
  // 10 attempts per minute per IP+username
  limit: 10,
  windowMs: 60_000,
});

export const apiLimiter = new RateLimiter({
  // 120 requests per minute per user/IP (default fallback)
  limit: 120,
  windowMs: 60_000,
});

export const generateLimiter = new RateLimiter({
  // 2 LLM generations per minute per teacher
  limit: 2,
  windowMs: 60_000,
});

export const uploadLimiter = new RateLimiter({
  // 20 uploads per hour per user
  limit: 20,
  windowMs: 60 * 60_000,
});

export const companionLimiter = new RateLimiter({
  // 10 companion chat requests per minute per user
  limit: 10,
  windowMs: 60_000,
});

export const codeRunnerLimiter = new RateLimiter({
  // Code execution consumes isolated CPU/memory slots. Keep rapid iteration
  // responsive without allowing one student to monopolize the runner.
  limit: 20,
  windowMs: 60_000,
});

export const codeSuggestionLimiter = new RateLimiter({
  // Code-aware starter chips refresh after an editing pause. Keep those
  // lightweight refreshes separate from the student's direct AI turns.
  limit: 20,
  windowMs: 60_000,
});

export const imageLimiter = new RateLimiter({
  // 20 image generations per minute per user
  limit: 20,
  windowMs: 60_000,
});

export const ttsLimiter = new RateLimiter({
  // 30 TTS requests per minute per user
  limit: 30,
  windowMs: 60_000,
});

/**
 * Extract client IP from request, respecting x-forwarded-for.
 * Returns "unknown" if not determinable.
 */
export function getClientIp(req: Request): string {
  if (process.env.TRUST_PROXY_HEADERS !== "true") return "unknown";
  // The production Nginx config overwrites this header. Never accept a
  // client-supplied forwarding chain directly in application code.
  const xRealIp = req.headers.get("x-real-ip")?.trim();
  if (xRealIp && isIP(xRealIp)) return xRealIp;
  return "unknown";
}

/**
 * Build a rate-limit key from IP and optional user identifier.
 */
export function rateLimitKey(req: Request, userId?: string): string {
  const ip = getClientIp(req);
  return userId ? `${ip}:${userId}` : ip;
}

/**
 * Build a 429 response with Retry-After header.
 */
export function rateLimitedResponse(retryAfterMs: number): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return Response.json(
    { error: "RATE_LIMITED", message: "请求过于频繁,请稍后重试" },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSec),
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}
