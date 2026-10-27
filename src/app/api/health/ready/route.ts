// Readiness probe: are downstream dependencies healthy?
// GET /api/health/ready -> 200 if all checks pass, 503 if any fail.
//
// Each check has its own ~2s timeout so a slow dependency cannot block the
// probe (k8s readiness probes have their own deadline and failing fast is
// better than hanging). The shape of the body is:
//   {
//     status: "ready" | "not_ready",
//     uptime, version,
//     dependencies: {
//       db:    { ok, latencyMs? },
//       llm:   { ok },
//       fs:    { ok },
//       redis: { ok, latencyMs? }   // present only when REDIS_URL is set
//     }
//   }

import { runReadinessChecks } from "@/lib/observability/health-checks";
import {
  withRequestContext,
  generateTraceId,
} from "@/lib/observability/request-id";
import { logger } from "@/lib/observability/logger";
import { isShuttingDown } from "@/lib/runtime/lifecycle";
import { authorizeInternalMonitor } from "@/lib/auth/request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const version = process.env.npm_package_version || "0.1.0";

export async function GET(request: Request) {
  const denied = authorizeInternalMonitor(request);
  if (denied) return denied;
  // Short-circuit during graceful shutdown: the orchestrator should stop
  // sending traffic to this pod regardless of downstream dependency health.
  if (isShuttingDown()) {
    return Response.json(
      {
        status: "shutting_down",
        uptime: process.uptime(),
        version,
      },
      { status: 503 },
    );
  }

  // Wrap in a request context so the logger has a traceId for any warnings
  // emitted by the dependency checks.
  return withRequestContext(
    { traceId: generateTraceId(), spanId: "health-ready" },
    async () => {
      const { ok, dependencies } = await runReadinessChecks();
      const status = ok ? "ready" : "not_ready";

      if (!ok) {
        logger.warn({ dependencies }, "readiness probe failed");
      }

      return Response.json(
        {
          status,
          uptime: process.uptime(),
          version,
          dependencies,
        },
        { status: ok ? 200 : 503 },
      );
    },
  ) as Promise<Response>;
}
