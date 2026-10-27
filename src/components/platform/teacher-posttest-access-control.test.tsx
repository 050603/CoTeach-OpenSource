import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/platform/client", () => ({ teacherPlatformFetch: mocks.request }));
import { TeacherPosttestAccessControl } from "./teacher-posttest-access-control";
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

it("opens the selected run with its observed version and refreshes confirmed state", async () => {
  mocks.request.mockResolvedValue({ ok: true, json: async () => ({ access: { status: "open", version: 5 } }) });
  const onChanged = vi.fn(async () => undefined);
  render(<TeacherPosttestAccessControl instanceId="run" access={{ status: "closed", version: 4 }} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("button", { name: "开放后测" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({ status: "open", version: 4 });
  expect(mocks.request.mock.calls[0][0]).toBe("/api/platform/classroom-instances/run/experiment/access");
});

it("reports a stale control without claiming that access changed", async () => {
  mocks.request.mockResolvedValue({ ok: false, json: async () => ({ message: "后测开放状态已变化，请刷新后再试" }) });
  const onChanged = vi.fn(async () => undefined);
  render(<TeacherPosttestAccessControl instanceId="run" access={{ status: "open", version: 4 }} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("button", { name: "关闭后测" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("后测开放状态已变化");
  expect(onChanged).toHaveBeenCalledOnce();
  expect(screen.getByText("实验拓展 · 后测已开放")).toBeVisible();
});
