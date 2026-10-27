import { withReadApiBoundary, readApiOptionsFor, readApiMethodNotAllowed } from "@/lib/auth/read-api-boundary";
import { withHttpMetrics } from "@/lib/observability/http";
import { type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { apiError, API_ERROR_CODES } from '@openmaic/lib/server/api-response';
import { runtimeAssetMatchesIfNoneMatch } from '@openmaic/lib/server/runtime-asset-cache';
import {
  isValidClassroomId,
  readClassroom,
} from '@openmaic/lib/server/classroom-storage';
import { createLogger } from '@openmaic/lib/logger';
import { authorizeLegacyClassroomRead } from '@/lib/platform/access';
import {
  courseGenerationPreviewJobId,
  loadCourseGenerationPreviewClassroom,
} from '@/lib/course-generation/generation-preview';

import { classroomPreviewStatus } from '@/lib/course-generation/classroom-preview-status';

const log = createLogger('Classroom API');

async function getMeasured(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');

    if (id) {
      const authorization = await authorizeLegacyClassroomRead(request, id);
      if (authorization) return authorization;
    }

    if (!id) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const classroom = courseGenerationPreviewJobId(id)
      ? await loadCourseGenerationPreviewClassroom(id)
      : await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    const body = JSON.stringify({ success: true, classroom: {
      ...classroom,
      generationPreview: 'generationPreview' in classroom
        ? classroom.generationPreview
        : classroomPreviewStatus(classroom),
    } });
    // Re-entering a classroom still checks live access and the exact content,
    // while unchanged lessons need no second transfer over the campus uplink.
    const etag = `W/"${createHash('sha256').update(body).digest('hex')}"`;
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-cache, must-revalidate',
      Vary: 'Cookie, Authorization, X-OpenPBL-Role',
      ETag: etag,
    };
    if (runtimeAssetMatchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, { headers });
  } catch (error) {
    log.error(
      `Classroom retrieval failed [id=${request.nextUrl.searchParams.get('id') ?? 'unknown'}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to retrieve classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export const GET = withReadApiBoundary(withHttpMetrics("GET", "/api/openmaic/classroom", getMeasured));

export const OPTIONS = readApiOptionsFor(["GET"]);
export const POST = readApiMethodNotAllowed;
export const PUT = readApiMethodNotAllowed;
export const PATCH = readApiMethodNotAllowed;
export const DELETE = readApiMethodNotAllowed;
