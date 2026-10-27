import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ActionEnvelope, ActionAck } from "@/lib/courses/contracts";
import type { Course } from "@/lib/session/types";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { createClassroomTimingState } from "@/lib/classroom/timing";
import { nextClassroomStageVersion } from "@/lib/classroom/stage-version";

const route = vi.hoisted(() => ({ pathname: "/teacher/teach/course-1/classroom" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
import { SessionProvider, useSession } from "./store";

const initialTime = "2026-10-17T00:00:00.000Z";
const newerTime = "2026-10-17T00:01:00.000Z";
const eventCursor = initialTime + "~00000000-0000-4000-8000-000000000001";
function makeCourse(): Course {
  const course = createPblTemplateCourse("course-1");
  return { ...course, status: "teaching", version: 31, stageVersion: 4, currentStageIndex: 0, uiState: {} };
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
function Probe({ nonce = 0 }: { nonce?: number }) {
  const session = useSession();
  const { initializeClassroomTiming } = session;
  const course = session.courses.find(item => item.id === "course-1");
  useEffect(() => { session.connectWebSocket("course-1"); return () => session.disconnectWebSocket(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (course?.status === "teaching" && !course.uiState?.classroomTiming) void initializeClassroomTiming(course.id);
  }, [course, nonce, initializeClassroomTiming]);
  return <><span data-testid="clock">{course?.uiState?.classroomTiming?.sessionStartedAt ?? "missing"}</span>
    <span data-testid="stage">{course?.currentStageIndex}</span><span data-testid="save">{session.saveState}</span>
    <span data-testid="actor">{session.user.name}</span><span data-testid="version">{course?.version}</span>
    <span data-testid="stage-token">{course?.stageVersion ?? 1}</span>
    <button onClick={() => void session.refresh("teacher")}>refresh</button>
    <button onClick={() => void session.retrySave()}>retry</button>
    <button onClick={() => {
      if (!course) return;
      const next = { ...course, currentStageIndex: 1,
        uiState: { ...course.uiState, classroomTiming: createClassroomTimingState({
          stages: course.stages, totalMinutes: 60, activeStageKey: course.stages[1]!.key, now: newerTime,
        }) } };
      session.updateCourse(course.id, { currentStageIndex: next.currentStageIndex, uiState: next.uiState,
        stageVersion: nextClassroomStageVersion(course, next) });
    }}>new stage</button>
    <button onClick={() => {
      if (!course) return;
      const next = { ...course,
        uiState: { ...course.uiState, classroomTiming: createClassroomTimingState({
          stages: course.stages, totalMinutes: 60, activeStageKey: course.stages[course.currentStageIndex]!.key, now: newerTime,
        }) } };
      session.updateCourse(course.id, { uiState: next.uiState, stageVersion: nextClassroomStageVersion(course, next) });
    }}>manual clock</button></>;
}
async function flush() {
  await act(async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); });
}
function transport({ legacyStageVersion = false }: { legacyStageVersion?: boolean } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(new Date(initialTime));
  window.history.replaceState({}, "", route.pathname);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  let server = makeCourse();
  if (legacyStageVersion) server = { ...server, stageVersion: undefined };
  let actorName = "Teacher A";
  const sent: ActionEnvelope[] = [];
  const stateReads: Array<{ version: number | undefined; stageVersion: number; clock?: string }> = [];
  const sockets: Array<{ onmessage: ((event: { data: string }) => void) | null }> = [];
  const admitted = deferred();
  let nextBootstrap: (ReturnType<typeof deferred> & { response?: Response }) | undefined;
  let nextState: (ReturnType<typeof deferred> & { response?: Response }) | undefined;
  let retrySucceeds = false;
  let nextBootstrapFailure: number | undefined;
  const ack = (request: ActionEnvelope, overrides: Partial<ActionAck> = {}) => Response.json({ requestId: request.requestId,
    courseVersion: server.version, stageVersion: server.stageVersion ?? 1, eventCursor, ...overrides });
  const installClock = () => {
    const before = server;
    const after = { ...server, version: server.version! + 1, uiState: { ...server.uiState,
      classroomTiming: createClassroomTimingState({ stages: server.stages, totalMinutes: 60,
        activeStageKey: server.stages[server.currentStageIndex]!.key, now: initialTime }) } };
    server = { ...after, stageVersion: nextClassroomStageVersion(before, after) };
  };
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/courses?")) {
      if (nextBootstrapFailure !== undefined) {
        const status = nextBootstrapFailure;
        nextBootstrapFailure = undefined;
        return Promise.resolve(Response.json({ error: "Session read rejected" }, { status }));
      }
      const response = Response.json({ courses: [server], user: { role: "teacher", name: actorName }, updatedAt: initialTime });
      const held = nextBootstrap;
      if (held) { nextBootstrap = undefined; held.response = response; return held.promise; }
      return Promise.resolve(response);
    }
    if (url.endsWith("/state")) {
      stateReads.push({ version: server.version, stageVersion: server.stageVersion ?? 1,
        clock: server.uiState?.classroomTiming?.sessionStartedAt });
      const response = Response.json({ course: server, eventCursor });
      const held = nextState;
      if (held) { nextState = undefined; held.response = response; return held.promise; }
      return Promise.resolve(response);
    }
    if (url.endsWith("/projection")) return Promise.resolve(Response.json({ courseId: server.id,
      courseVersion: server.version, projectionVersion: 0, projectionUpdatedAt: initialTime, serverTime: initialTime }));
    if (url.includes("/events?")) return Promise.resolve(Response.json({ events: [], nextCursor: eventCursor, hasMore: false }));
    if (url.endsWith("/actions")) {
      const body = JSON.parse(String(init?.body)) as ActionEnvelope;
      sent.push(structuredClone(body));
      if (body.action.type === "SET_UI_STATE" && body.action.payload.intent) {
        if (sent.length === 1) return admitted.promise;
        if (retrySucceeds) { installClock(); return Promise.resolve(ack(body)); }
        throw new Error("Unexpected extra initialization POST");
      }
      if (body.action.type === "UPDATE_COURSE") {
        const after = { ...server, ...body.action.payload.patch, version: server.version! + 1 };
        server = { ...after, stageVersion: nextClassroomStageVersion(server, after) };
        return Promise.resolve(ack(body));
      }
    }
    throw new Error("Unexpected request " + url);
  }));
  class Socket {
    static CONNECTING = 0; static OPEN = 1;
    readyState = 0; onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor() { sockets.push(this); }
    send() {} close() { this.readyState = 3; }
  }
  vi.stubGlobal("WebSocket", Socket);
  return { sent, stateReads,
    accept(overrides: Partial<ActionAck> = {}) { installClock(); admitted.resolve(ack(sent[0]!, overrides)); },
    commitBeforeAck() {
      installClock();
      const response = ack(sent[0]!);
      const socket = sockets.at(-1);
      if (!socket?.onmessage) throw new Error("Subscribed websocket message handler was not installed");
      // This is the actual course-updated hint shape, not an injected HYDRATE.
      socket.onmessage({ data: JSON.stringify({ type: "course-event", courseId: server.id,
        event: { type: "course-updated", payload: { actionType: "SET_UI_STATE", scope: "course",
          courseVersion: server.version, eventCursor } } }) });
      return () => admitted.resolve(response);
    },
    reject() { admitted.resolve(Response.json({ code: "INVALID_TIMING_INITIALIZATION", message: "Initial intent rejected" }, { status: 400 })); },
    enableRetry() { retrySucceeds = true; },
    holdNextState() {
      const held = { ...deferred(), response: undefined as Response | undefined };
      nextState = held;
      return () => {
        if (!held.response) throw new Error("The authoritative state read did not start");
        held.resolve(held.response);
      };
    },
    failNextBootstrap(status: number) { nextBootstrapFailure = status; },
    holdNextBootstrap() {
      const held = { ...deferred(), response: undefined as Response | undefined };
      nextBootstrap = held;
      return () => {
        if (!held.response) throw new Error("The new authenticated bootstrap did not start");
        held.resolve(held.response);
      };
    },
    switchActor({ name = "Teacher B", version = 50, stageIndex = 0 } = {}) {
      actorName = name;
      server = { ...makeCourse(), version, currentStageIndex: stageIndex, stageVersion: stageIndex === 0 ? 4 : 5,
        uiState: { classroomTiming: createClassroomTimingState({
          stages: server.stages, totalMinutes: 60, activeStageKey: server.stages[stageIndex]!.key, now: newerTime,
        }) } };
    },
    resolveRetiredAck() { admitted.resolve(Response.json({ requestId: sent[0]!.requestId, courseVersion: 32,
      stageVersion: 4, eventCursor })); },
  };
}
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  window.history.replaceState({}, "", "/"); route.pathname = "/teacher/teach/course-1/classroom";
});

it("joins repeated renders while the timer is absent, then reads only the authoritative clock after its own ACK", async () => {
  const network = transport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  expect(network.sent).toHaveLength(1);
  expect(screen.getByTestId("clock").textContent).toBe("missing");
  for (let nonce = 1; nonce <= 12; nonce++) {
    mounted.rerender(<SessionProvider><Probe nonce={nonce} /></SessionProvider>);
    await flush();
  }
  expect(network.sent).toHaveLength(1);
  expect(network.sent[0]!.action).toMatchObject({ type: "SET_UI_STATE", payload: { courseId: "course-1", patch: {},
    intent: { type: "initialize-classroom-timing", baseStageVersion: 4 } } });
  const originalIntent = structuredClone(network.sent[0]!.action);
  const readsBeforeAck = network.stateReads.length;
  network.accept(); await flush();
  expect(network.sent).toHaveLength(1);
  expect(network.sent[0]!.action).toEqual(originalIntent);
  expect(screen.getByTestId("stage-token").textContent).toBe("5");
  expect(network.stateReads.slice(readsBeforeAck)).toEqual([{ version: 32, stageVersion: 5, clock: initialTime }]);
  expect(screen.getByTestId("clock").textContent).toBe(initialTime);
  expect(screen.getByTestId("save").textContent).toBe("saved");
  mounted.unmount();
});

it("keeps failed initialization visible without a render retry storm and manual retry preserves the original ID/intent", async () => {
  const network = transport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush(); network.reject(); await flush();
  expect(screen.getByTestId("save").textContent).toBe("error");
  for (let nonce = 1; nonce <= 8; nonce++) {
    mounted.rerender(<SessionProvider><Probe nonce={nonce} /></SessionProvider>);
    await flush();
  }
  expect(network.sent).toHaveLength(1);
  expect(screen.getByTestId("clock").textContent).toBe("missing");
  network.enableRetry(); fireEvent.click(screen.getByText("retry")); await flush();
  expect(network.sent).toHaveLength(2);
  expect(network.sent[1]!.requestId).toBe(network.sent[0]!.requestId);
  expect(network.sent[1]!.action).toEqual(network.sent[0]!.action);
  expect(screen.getByTestId("clock").textContent).toBe(initialTime);
  expect(screen.getByTestId("save").textContent).toBe("saved");
  mounted.unmount();
});

it("never uses an old initialization ACK to replace a newer stage/timer or enqueue another old-stage intent", async () => {
  const network = transport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  fireEvent.click(screen.getByText("new stage")); await flush();
  expect(screen.getByTestId("stage").textContent).toBe("1");
  expect(screen.getByTestId("clock").textContent).toBe(newerTime);
  network.accept(); await flush();
  expect(screen.getByTestId("stage").textContent).toBe("1");
  expect(screen.getByTestId("clock").textContent).toBe(newerTime);
  expect(network.sent.filter(row => row.action.type === "SET_UI_STATE" && row.action.payload.intent)).toHaveLength(1);
  mounted.unmount();
});

it("fences a previous actor's ACK across a normal login route epoch and only reads the new actor's state", async () => {
  const network = transport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  expect(network.sent).toHaveLength(1);
  route.pathname = "/login";
  window.history.replaceState({}, "", route.pathname);
  mounted.rerender(<SessionProvider><div data-testid="login">login</div></SessionProvider>);
  await flush();
  network.switchActor(); network.resolveRetiredAck(); await flush();
  const releaseAuthenticatedBootstrap = network.holdNextBootstrap();
  route.pathname = "/teacher/teach/course-1/classroom";
  window.history.replaceState({}, "", route.pathname);
  mounted.rerender(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  // Old retained role/course data must not enqueue a new-epoch command while
  // the existing current-auth read is still unresolved.
  expect(network.sent).toHaveLength(1);
  releaseAuthenticatedBootstrap(); await flush();
  expect(screen.getByTestId("clock").textContent).toBe(newerTime);
  expect(network.sent).toHaveLength(1);
  mounted.unmount();
});


it("does not treat an early websocket hint as confirmation and reads the committed clock after its original ACK", async () => {
  const network = transport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  const original = structuredClone(network.sent[0]!);
  const releaseAck = network.commitBeforeAck();
  await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(750); });
  await flush();
  expect(network.sent).toHaveLength(1);
  expect(screen.getByTestId("clock").textContent).toBe("missing");
  expect(screen.getByTestId("stage-token").textContent).toBe("4");
  const readsBeforeAck = network.stateReads.length;
  releaseAck(); await flush();
  expect(network.sent).toEqual([original]);
  expect(screen.getByTestId("clock").textContent).toBe(initialTime);
  expect(screen.getByTestId("stage-token").textContent).toBe("5");
  expect(network.stateReads.slice(readsBeforeAck)).toEqual([{ version: 32, stageVersion: 5, clock: initialTime }]);
  mounted.unmount();
});

it("does not borrow a foreign request ACK to advance the pending timing scope", async () => {
  const network = transport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  const original = structuredClone(network.sent[0]!);
  const releaseState = network.holdNextState();
  network.accept({ requestId: "another-command" }); await flush();
  expect(network.sent).toEqual([original]);
  expect(screen.getByTestId("save").textContent).toBe("error");
  expect(screen.getByTestId("stage-token").textContent).toBe("4");
  // A subsequent real read may independently observe the server's clock.
  releaseState(); await flush();
  expect(screen.getByTestId("stage-token").textContent).toBe("5");
  mounted.unmount();
});

it("retires an old initialization ACK when a same-stage manual clock has already advanced the local token", async () => {
  const network = transport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  fireEvent.click(screen.getByText("manual clock")); await flush();
  expect(screen.getByTestId("stage").textContent).toBe("0");
  expect(screen.getByTestId("clock").textContent).toBe(newerTime);
  network.accept(); await flush();
  expect(screen.getByTestId("clock").textContent).toBe(newerTime);
  expect(network.sent.filter(row => row.action.type === "SET_UI_STATE" && row.action.payload.intent)).toHaveLength(1);
  mounted.unmount();
});

it.each(["Teacher B", "Teacher A"])("replaces a retained higher-version course on the first fresh teacher route epoch for %s", async (name) => {
  const network = transport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  expect(screen.getByTestId("version").textContent).toBe("31");
  expect(network.sent).toHaveLength(1);
  route.pathname = "/login";
  window.history.replaceState({}, "", route.pathname);
  mounted.rerender(<SessionProvider><div>login</div></SessionProvider>);
  await flush();
  network.switchActor({ name, version: 12, stageIndex: 1 });
  network.resolveRetiredAck(); await flush();
  const releaseAuthenticatedBootstrap = network.holdNextBootstrap();
  route.pathname = "/teacher/teach/course-1/classroom";
  window.history.replaceState({}, "", route.pathname);
  mounted.rerender(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  expect(network.sent).toHaveLength(1);
  releaseAuthenticatedBootstrap(); await flush();
  expect(screen.getByTestId("actor").textContent).toBe(name);
  expect(screen.getByTestId("version").textContent).toBe("12");
  expect(screen.getByTestId("stage").textContent).toBe("1");
  expect(screen.getByTestId("clock").textContent).toBe(newerTime);
  expect(network.sent).toHaveLength(1);
  mounted.unmount();
});

it.each([401, 503])("blocks a failed timer retry after a %s session read until fresh teacher hydration recovers", async (status) => {
  const network = transport();
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush(); network.reject(); await flush();
  expect(network.sent).toHaveLength(1);
  expect(screen.getByTestId("save").textContent).toBe("error");
  network.failNextBootstrap(status);
  fireEvent.click(screen.getByText("refresh")); await flush();
  fireEvent.click(screen.getByText("retry")); await flush();
  expect(network.sent).toHaveLength(1);
  network.enableRetry();
  fireEvent.click(screen.getByText("refresh")); await flush();
  fireEvent.click(screen.getByText("retry")); await flush();
  expect(network.sent).toHaveLength(2);
  expect(network.sent[1]!.requestId).toBe(network.sent[0]!.requestId);
  expect(network.sent[1]!.action).toEqual(network.sent[0]!.action);
  expect(screen.getByTestId("clock").textContent).toBe(initialTime);
  expect(screen.getByTestId("save").textContent).toBe("saved");
  mounted.unmount();
});

it("uses the legacy stageVersion default consistently for enqueue, dedupe and ACK readback", async () => {
  const network = transport({ legacyStageVersion: true });
  const mounted = render(<SessionProvider><Probe /></SessionProvider>);
  await flush();
  expect(network.sent).toHaveLength(1);
  expect(network.sent[0]!.action).toMatchObject({ type: "SET_UI_STATE", payload: {
    intent: { type: "initialize-classroom-timing", baseStageVersion: 1 },
  } });
  mounted.rerender(<SessionProvider><Probe nonce={1} /></SessionProvider>);
  await flush();
  expect(network.sent).toHaveLength(1);
  network.accept(); await flush();
  expect(screen.getByTestId("clock").textContent).toBe(initialTime);
  expect(screen.getByTestId("save").textContent).toBe("saved");
  expect(network.sent).toHaveLength(1);
  mounted.unmount();
});
