import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@/lib/session/types";
import { KnowledgeGraphFlow } from "./knowledge-graph-flow";

const graph: KnowledgeGraph = {
  nodes: [
    { id: "source", label: "观察事实", description: "提取事实", level: "foundation" },
    { id: "target", label: "形成解释", description: "形成解释", level: "application" },
  ],
  edges: [{ id: "edge", source: "source", target: "target", label: "提供依据" }],
};

describe("KnowledgeGraphFlow", () => {
  it("renders safely when points are omitted and keeps the graph accessible", () => {
    render(<KnowledgeGraphFlow graph={graph} height={360} showMiniMap={false} />);

    expect(screen.getByRole("application")).toBeTruthy();
    expect(screen.getByText("依赖方向")).toBeTruthy();
    expect(screen.getByText("学习进阶")).toBeTruthy();
  });

  it("uses the quiet classroom appearance without editing controls", () => {
    render(
      <KnowledgeGraphFlow
        activeNodeId="target"
        appearance="teaching-rail"
        autoRestoreView
        focusActiveNode
        graph={graph}
        height={164}
        showControls={false}
        showMiniMap={false}
      />,
    );

    const application = screen.getByRole("application");
    expect(application).toBeTruthy();
    expect(application.closest(".knowledge-graph-canvas")?.className).toContain("bg-transparent");
    expect(application.closest(".knowledge-graph-canvas")?.getAttribute("data-auto-restore-view")).toBe("true");
    expect(screen.queryByText("依赖方向")).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom In" })).toBeNull();
  });

  it("can inherit a proportionally sized teaching region without a fixed minimum height", () => {
    render(
      <KnowledgeGraphFlow
        fillAvailableHeight
        graph={graph}
        showMiniMap={false}
      />,
    );

    const canvas = screen.getByRole("application").closest(".knowledge-graph-canvas") as HTMLElement;
    expect(canvas.style.minHeight).toBe("");
  });
});
