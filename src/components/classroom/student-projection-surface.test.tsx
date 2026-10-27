import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudentProjectionSurface } from "./student-projection-surface";

vi.mock("@/components/ui", () => ({ Pill: ({ children }: { children: ReactNode }) => <span>{children}</span> }));

afterEach(cleanup);

describe("student projection keyboard ownership", () => {
  it("moves focus into projection and prevents focus from escaping to the underlying classroom", async () => {
    render(<><button>Background</button><StudentProjectionSurface title="Courseware"><button>Previous page</button><button>Next page</button></StudentProjectionSurface></>);
    const dialog = screen.getByRole("dialog", { name: "教师投屏：Courseware" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const background = screen.getByText("Background");
    background.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const first = screen.getByRole("button", { name: "Previous page" });
    const last = screen.getByRole("button", { name: "Next page" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("returns focus to an existing entry and removes its scroll lock when the projection ends", async () => {
    const previousOverflow = document.body.style.overflow;
    const entry = document.createElement("button");
    document.body.append(entry);
    entry.focus();
    const view = render(<StudentProjectionSurface title="PDF"><button>Page</button></StudentProjectionSurface>);
    try {
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Page" })));
      expect(document.body.style.overflow).toBe("hidden");
      view.unmount();
      await waitFor(() => expect(document.activeElement).toBe(entry));
      expect(document.body.style.overflow).toBe(previousOverflow);
    } finally { view.unmount(); entry.remove(); }
  });

  it("keeps teacher controlled projection open on Escape and when its contents change", async () => {
    const view = render(<StudentProjectionSurface title="First" projectionVersion={1}><button>First page</button></StudentProjectionSurface>);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "First page" })));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "教师投屏：First" })).toBeTruthy();
    view.rerender(<StudentProjectionSurface title="Second" projectionVersion={2}><button>Second page</button></StudentProjectionSurface>);
    expect(screen.getByRole("dialog", { name: "教师投屏：Second" })).toHaveAttribute("data-projection-version", "2");
    expect(document.body.style.overflow).toBe("hidden");
  });
});
