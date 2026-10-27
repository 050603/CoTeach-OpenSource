// Liveness probe: is the process alive?
// GET /api/health/live -> 200 { status: "alive", uptime, version }
//
// Liveness should be cheap and never depend on downstream services — if it
// fails, the orchestrator restarts the pod. Readiness (separate route) is
// where dependency checks live.
//
// During graceful shutdown we flip to 503 so the orchestrator stops routing
// new traffic to this pod, but we do NOT fail liveness for any other reason
// (a transient DB blip must not cause a restart — that's readiness' job).

import { isShuttingDown } from "@/lib/runtime/lifecycle";

export const runtime = "nodejs";

const version = process.env.npm_package_version || "0.1.0";

export async function GET() {
  if (isShuttingDown()) {
    return Response.json(
      { status: "shutting_down", uptime: process.uptime(), version },
      { status: 503 },
    );
  }
  return Response.json(
    {
      status: "alive",
      uptime: process.uptime(),
      version,
    },
    { status: 200 },
  );
}
