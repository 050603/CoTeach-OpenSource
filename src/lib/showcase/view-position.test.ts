import { describe, expect, it, vi } from "vitest";
import { applyViewPosition, indexDocumentBlocks, readViewPosition } from "./view-position";

function geometry(element: HTMLElement, top: number, height: number) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) });
}
describe("showcase content positions", () => {
  it("follows the same document block despite different font size and viewport height", () => {
    const teacher = document.createElement("div");
    teacher.innerHTML = '<div data-document-preview><div data-slate-editor><p data-slate-node="element">First</p><p data-slate-node="element">Second</p></div></div>';
    indexDocumentBlocks(teacher);
    Object.defineProperties(teacher, { scrollHeight: { value: 2000 }, clientHeight: { value: 600 } });
    teacher.scrollTop = 400;
    geometry(teacher, 100, 600);
    const teacherBlocks = teacher.querySelectorAll<HTMLElement>("p");
    geometry(teacherBlocks[0], -200, 200); geometry(teacherBlocks[1], 0, 400);
    const position = readViewPosition(teacher, "document");
    expect(position).toMatchObject({ blockId: "block-1", blockOffset: .25 });
    const student = teacher.cloneNode(true) as HTMLElement;
    geometry(student, 50, 300); student.scrollTop = 80;
    geometry(student.querySelectorAll<HTMLElement>("p")[1], 300, 200);
    applyViewPosition(student, position, "document");
    expect(student.scrollTop).toBe(380);
  });
  it("uses PDF page and within-page position instead of whole-document ratios", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div data-showcase-page="1"></div><div data-showcase-page="2"></div>';
    geometry(container, 0, 500);
    geometry(container.children[0] as HTMLElement, -900, 700);
    geometry(container.children[1] as HTMLElement, -150, 600);
    expect(readViewPosition(container, "pdf")).toMatchObject({ page: 2, pageOffset: .25 });
  });
  it("falls back to normalized position for older snapshots without anchors", () => {
    const container = document.createElement("div");
    Object.defineProperties(container, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } });
    applyViewPosition(container, { scrollRatio: .5 }, "document");
    expect(container.scrollTop).toBe(800);
  });
  it.each(["document", "pdf"] as const)("keeps the end of %s visible despite a matching anchor and a shorter viewport", (kind) => {
    const container = document.createElement("div");
    container.innerHTML = '<p data-showcase-block="block-2" data-showcase-page="3">Final content</p>';
    Object.defineProperties(container, { scrollHeight: { value: 3000 }, clientHeight: { value: 400 } });
    geometry(container, 0, 400);
    geometry(container.firstElementChild as HTMLElement, 100, 600);
    applyViewPosition(container, { scrollRatio: 1, blockId: "block-2", blockOffset: .2, page: 3, pageOffset: .2 }, kind);
    expect(container.scrollTop).toBe(2600);
  });
  it("keeps the top margin visible when returning to the first block", () => {
    const container = document.createElement("div");
    container.innerHTML = '<p data-showcase-block="block-0">First content</p>';
    Object.defineProperties(container, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } });
    geometry(container, 0, 400);
    geometry(container.firstElementChild as HTMLElement, 40, 200);
    container.scrollTop = 100;
    applyViewPosition(container, { scrollRatio: 0, blockId: "block-0", blockOffset: 0 }, "document");
    expect(container.scrollTop).toBe(0);
  });
  it("treats fractional scroll rounding as the end of the document", () => {
    const container = document.createElement("div");
    Object.defineProperties(container, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } });
    container.scrollTop = 1599.5;
    expect(readViewPosition(container, "document").scrollRatio).toBe(1);
    container.scrollTop = 800;
    expect(readViewPosition(container, "document").scrollRatio).toBe(.5);
  });
});
