// Prometheus metrics scrape endpoint.
// GET /api/metrics -> text/plain Prometheus exposition format.

import { refreshClassroomHealthMetrics } from "@/lib/observability/classroom-health";
import { register } from "@/lib/observability/metrics";
import { authorizeInternalMonitor } from "@/lib/auth/request-guards";
import { refreshNginxEdgeMetrics } from "@/lib/observability/nginx-edge-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = authorizeInternalMonitor(request);
  if (denied) return denied;
  await refreshClassroomHealthMetrics();
  await refreshNginxEdgeMetrics();
  const metrics = await register.metrics();
  return new Response(metrics, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
