import { Buffer } from "node:buffer";
import { z } from "zod";

const ProductionEnvironmentSchema = z.object({
  NODE_ENV: z.literal("production"),
  DATABASE_URL: z.string().url().refine((value) => value.startsWith("postgresql://"), {
    message: "DATABASE_URL must use postgresql://",
  }),
  REDIS_URL: z.string().url().refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), {
    message: "REDIS_URL must use redis:// or rediss://",
  }),
  PUBLIC_BASE_URL: z.string().url().refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
    // 允许 http:// 用于无域名/无证书的内网 IP 直访部署(如 http://172.16.x.x),
    // 公网域名部署仍应使用 https://
    message: "PUBLIC_BASE_URL must use http:// or https://",
  }),
  JWT_SECRET: z.string().min(43),
  PROVIDER_ENCRYPTION_KEY: z.string().refine(isBase64Key, {
    message: "PROVIDER_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
  }),
  INTERNAL_MONITOR_TOKEN: z.string().min(32),
  ENABLE_LOAD_TEST_API: z.enum(["true", "false"]).default("false"),
  LOAD_TEST_ADMIN_TOKEN: z.string().optional(),
  TRUST_PROXY_HEADERS: z.literal("true"),
}).superRefine((environment, context) => {
  if (
    environment.ENABLE_LOAD_TEST_API === "true" &&
    (!environment.LOAD_TEST_ADMIN_TOKEN ||
      environment.LOAD_TEST_ADMIN_TOKEN.length < 32)
  ) {
    context.addIssue({
      code: "custom",
      path: ["LOAD_TEST_ADMIN_TOKEN"],
      message: "LOAD_TEST_ADMIN_TOKEN must contain at least 32 characters when load testing is enabled",
    });
  }
});

let validated = false;

export function assertProductionEnvironment(): void {
  if (validated || process.env.NODE_ENV !== "production") return;
  // Next evaluates instrumentation while compiling. Runtime validation must
  // happen when the built server starts, not while creating the image.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const result = ProductionEnvironmentSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid production environment: ${issues}`);
  }
  validated = true;
}

function isBase64Key(value: string): boolean {
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 && decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "");
  } catch {
    return false;
  }
}
