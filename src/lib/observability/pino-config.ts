// Pino logger configuration: transport selection + field redaction.
//
// Production -> JSON to stdout. Development -> pino-pretty to stdout.
// Redaction masks apiKey / email / phone / studentName (incl. nested) per
// the P0P1 阶段 8 spec.

import type { LoggerOptions } from "pino";

/**
 * Mask a single value based on the leaf key name. Returns the masked
 * representation; non-string values are replaced with "***" to avoid
 * leaking structured data through type coercion.
 */
function maskValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return "***";
  switch (key) {
    case "apiKey":
    case "api_key":
    case "key":
    case "token":
    case "authorization":
      return "***";
    case "email": {
      const at = value.indexOf("@");
      if (at <= 0) return "***";
      const domain = value.slice(at + 1);
      return `${value[0]}***@${domain}`;
    }
    case "phone": {
      // Keep country prefix (+86 / +1 ...) + last 4 digits; mask the middle.
      const match = value.match(/^(\+?\d{1,3})?(\D*\d)(\d+)(\d{4})$/);
      if (!match) return "***";
      const prefix = match[1] ?? "";
      const first = match[2];
      const middle = match[3];
      const last = match[4];
      return `${prefix}${first}${"*".repeat(middle.length)}${last}`;
    }
    case "studentName": {
      // Chinese-name style: keep first character, mask the rest.
      const chars = [...value];
      if (chars.length === 0) return "***";
      if (chars.length === 1) return "*";
      return `${chars[0]}${"*".repeat(chars.length - 1)}`;
    }
    default:
      return "***";
  }
}

/**
 * Pino redact censor: receives (value, pathSegments) and returns the masked
 * replacement. Path segments are like ["user", "apiKey"]; we only need the
 * final segment to decide the mask shape.
 */
const redactCensor: (value: unknown, path: string[]) => unknown = (
  value,
  path,
) => {
  const leaf = path[path.length - 1] ?? "";
  return maskValue(leaf, value);
};

/**
 * Redact paths. fast-redact supports single-level `*` wildcards. We enumerate
 * a few common depths so nested payloads (e.g. log.info({ user: { email }}))
 * are masked without needing deep `**` (unsupported by fast-redact).
 */
const redactPaths = [
  "apiKey",
  "*.apiKey",
  "*.*.apiKey",
  "*.*.*.apiKey",
  "api_key",
  "*.api_key",
  "*.*.api_key",
  "token",
  "*.token",
  "*.*.token",
  "authorization",
  "*.authorization",
  "*.*.authorization",
  "email",
  "*.email",
  "*.*.email",
  "*.*.*.email",
  "phone",
  "*.phone",
  "*.*.phone",
  "*.*.*.phone",
  "studentName",
  "*.studentName",
  "*.*.studentName",
  "*.*.*.studentName",
];

/**
 * Field schema for log lines:
 *   timestamp, level, traceId, spanId, userId, courseId, module, message, payload
 * Pino emits `level` natively; we rename it via a formatter. The `timestamp`
 * field is injected by the custom `timestamp` function below (ISO 8601),
 * replacing pino's default `time` (unix ms). `msg` -> `message` via messageKey.
 */
export const baseLoggerOptions: LoggerOptions = {
  level: (process.env.LOG_LEVEL ?? "info").toLowerCase(),
  messageKey: "message",
  redact: {
    paths: redactPaths,
    censor: redactCensor,
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  // Emit `timestamp` as an ISO 8601 string instead of pino's default
  // `time` (unix ms). Pino's `timestamp` option takes a function that
  // returns a raw JSON fragment injected into the log line.
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
};

/**
 * Build pino options for the current runtime. In development we attach a
 * pino-pretty transport; in production we keep the JSON formatter on stdout.
 */
export function buildLoggerOptions(): LoggerOptions {
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev && process.env.LOG_FORMAT !== "json") {
    return {
      ...baseLoggerOptions,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
          messageFormat: "{module} {message}",
        },
      },
    };
  }
  return baseLoggerOptions;
}
