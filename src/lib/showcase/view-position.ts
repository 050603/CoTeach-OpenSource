import type { ShowcaseViewStatePatch } from "@/components/showcase/showcase-artifact-viewer";

/** Stable indices belong to one immutable submitted artifact version. */
export function indexDocumentBlocks(container: HTMLElement): void {
  const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-slate-node="element"]'))
    .filter(element => !element.parentElement?.closest('[data-slate-node="element"]'));
  const blocks = elements.length ? elements : Array.from(container.querySelector<HTMLElement>("[data-document-preview]")?.children ?? []) as HTMLElement[];
  blocks.forEach((element, index) => { element.dataset.showcaseBlock = `block-${index}`; });
}

export function readViewPosition(container: HTMLElement, kind: "document" | "pdf"): ShowcaseViewStatePatch {
  const top = container.getBoundingClientRect().top;
  const items = Array.from(container.querySelectorAll<HTMLElement>(kind === "document" ? "[data-showcase-block]" : "[data-showcase-page]"));
  const anchor = items.find(item => item.getBoundingClientRect().bottom > top + 1) ?? items.at(-1);
  const bounds = anchor?.getBoundingClientRect();
  const offset = bounds ? Math.min(1, Math.max(0, (top - bounds.top) / Math.max(1, bounds.height))) : 0;
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  // Browsers can round scroll geometry differently at fractional zoom levels.
  const scrollRatio = container.scrollTop <= 1 || maxScrollTop === 0 ? 0
    : container.scrollTop >= maxScrollTop - 1 ? 1 : container.scrollTop / maxScrollTop;
  return { scrollRatio, ...(anchor ? kind === "document" ? { blockId: anchor.dataset.showcaseBlock, blockOffset: offset }
    : { page: Number(anchor.dataset.showcasePage), pageOffset: offset } : {}) };
}

export function applyViewPosition(container: HTMLElement, view: ShowcaseViewStatePatch, kind: "document" | "pdf"): void {
  // At either boundary, preserve the boundary across viewport sizes and reflow.
  // Aligning only the top block can otherwise leave the final content offscreen.
  if (view.scrollRatio === 0 || view.scrollRatio === 1) {
    container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight) * view.scrollRatio;
    return;
  }
  const anchor = Array.from(container.querySelectorAll<HTMLElement>(kind === "document" ? "[data-showcase-block]" : "[data-showcase-page]"))
    .find(item => kind === "document" ? item.dataset.showcaseBlock === view.blockId : Number(item.dataset.showcasePage) === view.page);
  if (anchor) {
    const bounds = anchor.getBoundingClientRect();
    container.scrollTop += bounds.top - container.getBoundingClientRect().top + bounds.height * (kind === "document" ? view.blockOffset ?? 0 : view.pageOffset ?? 0);
  } else container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight) * Math.min(1, Math.max(0, view.scrollRatio ?? 0));
}
