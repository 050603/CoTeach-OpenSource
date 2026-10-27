// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), events: vi.fn(), projection: vi.fn() }));
vi.mock('@/lib/courses/course-read-worker-pool', () => ({ dispatchCourseRead: mocks.dispatch }));
vi.mock('@/lib/courses/http-realtime-read-handlers', () => ({ getCourseEvents: mocks.events, getProjectionState: mocks.projection }));
vi.mock('@/lib/observability/http', () => ({ withHttpMetrics: (_method: string, _route: string, handler: unknown) => handler }));
import { GET as events } from '@/app/api/courses/[courseId]/events/route';
import { GET as projection } from '@/app/api/courses/[courseId]/projection/route';
const context = { params: Promise.resolve({ courseId: 'course' }) };
beforeEach(() => vi.resetAllMocks());

it.each([{ operation: 'events', get: events }, { operation: 'projection', get: projection }])(
  '$operation retains disabled-pool local behavior and returns worker headers/body without a second local read', async ({ operation, get }) => {
    const local = operation === 'events' ? mocks.events : mocks.projection;
    const makeRequest = () => new Request(`https://class.test/api/courses/course/${operation}`);
    mocks.dispatch.mockResolvedValue(null);
    local.mockResolvedValue(Response.json({ local: true }));
    expect(await (await get(makeRequest(), context)).json()).toEqual({ local: true });
    expect(local).toHaveBeenCalledOnce();
    const response = Response.json({ code: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    response.headers.append('set-cookie', 'student=; Path=/; Max-Age=0');
    response.headers.append('set-cookie', 'legacy=; Path=/; Max-Age=0');
    mocks.dispatch.mockResolvedValue(response);
    const result = await get(makeRequest(), context);
    expect(result.status).toBe(401); expect(await result.json()).toEqual({ code: 'UNAUTHORIZED' });
    expect(result.headers.getSetCookie()).toEqual(response.headers.getSetCookie());
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(local).toHaveBeenCalledOnce();
    expect(mocks.dispatch).toHaveBeenLastCalledWith(operation, expect.any(Request), 'course');
  },
);
