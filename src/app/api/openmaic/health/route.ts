import { apiSuccess, apiError, API_ERROR_CODES } from '@openmaic/lib/server/api-response';
import {
  getServerWebSearchProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
} from '@openmaic/lib/server/provider-config';
import { runReadinessChecks } from '@/lib/observability/health-checks';

const version = process.env.npm_package_version || '0.1.0';

// Legacy health endpoint. New clients should use:
//   - GET /api/health/live  (liveness)
//   - GET /api/health/ready (readiness, with dependency detail)
//
// This route preserves the original response shape (status / version /
// capabilities) so existing clients continue to work. Internally it reuses
// the new readiness checks so a 503 here reflects the same dependency
// state as /api/health/ready.

export async function GET() {
  const { ok: ready, dependencies } = await runReadinessChecks();

  if (!ready) {
    // Keep the original response shape (capabilities) but flip status to
    // 'degraded' and return 503 so orchestrators see the unhealthy state.
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      503,
      'dependencies not ready',
      JSON.stringify(dependencies),
    );
  }

  return apiSuccess({
    status: 'ok',
    version,
    capabilities: {
      webSearch: Object.keys(getServerWebSearchProviders()).length > 0,
      imageGeneration: Object.keys(getServerImageProviders()).length > 0,
      videoGeneration: Object.keys(getServerVideoProviders()).length > 0,
      tts: Object.values(getServerTTSProviders()).some((info) => !info.disabled),
    },
    dependencies,
  });
}
