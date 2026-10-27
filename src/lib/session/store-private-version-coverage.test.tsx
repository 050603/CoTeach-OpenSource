import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/student/ai-collaboration/course" }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
import { SessionProvider, useSession } from "./store";

const at = "2026-10-16T00:00:00.000Z";
const cursor = (version: number) => `${at}~11111111-1111-4111-8111-${String(version).padStart(12, "0")}`;
const course = { id: "course", name: "课堂", status: "teaching", version: 1, updatedAt: at, students: [], stages: [],
  currentStageIndex: 0, resources: [], groups: [], submissions: [], activityLog: [], uiState: {},
  content: { lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } } };
const sockets: Socket[] = [];
class Socket {
  static CONNECTING = 0; static OPEN = 1; readyState = 0;
  onopen?: () => void; onmessage?: (event: { data: string }) => void;
  constructor() { sockets.push(this); }
  send() {}
  close() { this.readyState = 3; }
  emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
let api: ReturnType<typeof useSession>;
function Probe() {
  const session = useSession();
  useEffect(() => { api = session; }, [session]);
  useEffect(() => { session.connectWebSocket("course"); return () => session.disconnectWebSocket();
    // The provider owns transport callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
const settle = async () => { await act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); }); };
beforeEach(() => {
  sockets.length = 0; localStorage.clear(); window.history.replaceState({}, "", "/student/ai-collaboration/course");
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

function transport() {
  let actor = "student-a"; let version = 1;
  let events: Record<string, unknown> = { events: [], nextCursor: cursor(1), hasMore: false, courseVersion: 1 };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/courses") return Response.json({ courses: [course], user: { role: "student", name: actor },
      studentId: actor, joinedCourseId: "course", updatedAt: at, bootstrap: { courseId: "course", eventCursor: cursor(1) } });
    if (url.pathname.endsWith("/projection")) return Response.json({ courseId: "course", courseVersion: 1, projectionVersion: 0,
      projectionUpdatedAt: at, serverTime: at });
    if (url.pathname.endsWith("/state")) return Response.json({ course: { ...course, version, currentStageIndex: 2 }, eventCursor: cursor(version) });
    if (url.pathname.endsWith("/events")) return Response.json({ ...events, privateVersionCoverage:
      events.privateVersionCoverage === undefined ? undefined : { protocol: "student-private-versions-v1", after: url.searchParams.get("after"),
        through: events.nextCursor, ...(events.privateVersionCoverage as object) } });
    throw new Error(`Unexpected ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, setActor: (value: string) => { actor = value; },
    setEvents: (value: Record<string, unknown>, savedVersion = Number(value.courseVersion)) => { events = value; version = savedVersion; },
    stateReads: () => fetcher.mock.calls.filter(([url]) => String(url).endsWith("/state")),
  };
}
async function mount() {
  render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(api.studentId).toBe("student-a")); await settle();
  sockets.at(-1)!.readyState = Socket.OPEN;
}
async function catchUp() { act(() => { api.connectWebSocket("course"); }); await settle(); }
const hidden = (version: number, ranges: unknown) => ({ events: [], nextCursor: cursor(version), hasMore: false,
  requiresReconciliation: true, courseVersion: version, privateVersionCoverage: { ranges } });

it("consumes consecutive peer-only pages without changing the snapshot version or reading private state", async () => {
  const server = transport(); await mount();
  server.setEvents(hidden(31, [[2, 31]])); await catchUp();
  server.setEvents(hidden(61, [[32, 61]])); await catchUp();
  expect(server.stateReads()).toHaveLength(0);
  expect(api.courses[0].version).toBe(1);
  expect(server.fetcher.mock.calls.some(([url]) => String(url).includes(`after=${encodeURIComponent(cursor(31))}`))).toBe(true);
  server.setEvents({ events: [{ type: "COURSE_ACTION", courseVersion: 62, cursor: cursor(62) }], nextCursor: cursor(62), hasMore: false,
    requiresReconciliation: true, courseVersion: 62, privateVersionCoverage: { ranges: [] } });
  await catchUp();
  expect(server.stateReads()).toHaveLength(1); expect(api.courses[0].version).toBe(62);
  expect(api.courses[0].currentStageIndex).toBe(2);
});

it.each([
  { ranges: [[2, 2], [4, 31]] }, { ranges: [[2, 502]] }, { ranges: [["2", 31]] },
  { ranges: [[2, 31]], protocol: "unknown" }, { ranges: [[2, 31]], after: "wrong" },
  { ranges: [[2, 31]], through: "wrong" }, undefined,
])("retains full reconciliation for missing versions or unknown coverage: %j", async coverage => {
  const server = transport(); await mount();
  server.setEvents({ ...hidden(31, []), privateVersionCoverage: coverage }); await catchUp();
  expect(server.stateReads()).toHaveLength(1); expect(api.courses[0].version).toBe(31);
});

it("does not mistake a newer projection receipt for an already reconciled course snapshot", async () => {
  const server = transport(); await mount();
  act(() => sockets.at(-1)!.emit({ type: "course-event", courseId: "course", event: { type: "projection-changed", payload: {
    courseId: "course", courseVersion: 31, projectionVersion: 1, projectionUpdatedAt: at, serverTime: at,
    resourceProjection: null, teacherResourceProjection: null,
  } } })); await settle();
  expect(api.courses[0].version).toBe(31);
  server.setEvents(hidden(61, [[32, 61]])); await catchUp();
  expect(server.stateReads()).toHaveLength(1); expect(api.courses[0].version).toBe(61);
});

it("retires another account's peer coverage in the same classroom", async () => {
  const server = transport(); await mount();
  server.setEvents(hidden(31, [[2, 31]])); await catchUp(); expect(server.stateReads()).toHaveLength(0);
  server.setActor("student-b");
  server.setEvents({ events: [], nextCursor: cursor(1), hasMore: false, courseVersion: 1 });
  await act(async () => { await api.refresh(); }); await settle();
  expect(api.studentId).toBe("student-b");
  sockets.at(-1)!.readyState = Socket.OPEN;
  server.setEvents(hidden(61, [[32, 61]])); await catchUp();
  expect(server.stateReads()).toHaveLength(1); expect(api.courses[0].version).toBe(61);
});

it("still reads shared group changes whose hidden notification cannot explain the next version", async () => {
  const server = transport(); await mount();
  server.setEvents(hidden(31, [[2, 31]])); await catchUp();
  expect(server.stateReads()).toHaveLength(0);
  server.setEvents(hidden(32, [])); await catchUp();
  expect(server.stateReads()).toHaveLength(1); expect(api.courses[0].currentStageIndex).toBe(2);
  expect(api.courses[0].version).toBe(32);
});

it("reconciles a backwards server version and reseeds from its accepted full snapshot", async () => {
  const server = transport(); await mount();
  server.setEvents(hidden(31, [[2, 31]])); await catchUp(); expect(server.stateReads()).toHaveLength(0);
  server.setEvents(hidden(1, [])); await catchUp();
  expect(server.stateReads()).toHaveLength(1); expect(api.courses[0].version).toBe(1);
  server.setEvents(hidden(61, [[32, 61]])); await catchUp();
  expect(server.stateReads()).toHaveLength(2); expect(api.courses[0].version).toBe(61);
});
