import { createHash } from "node:crypto";
import type { ShowcaseAnalysisCoverage, ShowcaseEvidenceBlock, ShowcaseQualityDimension, ShowcaseRecommendationReason } from "./recommendation-types";

export const SHOWCASE_DEBOUNCE_MS = 30_000;
export const SHOWCASE_MAX_DEBOUNCE_MS = 90_000;
export const SHOWCASE_COOLDOWN_MS = 180_000;
export const SHOWCASE_TEXT_BUDGET = 8_000;
export const SHOWCASE_CONTEXT_BUDGET = 2_000;
export const digestShowcaseContent = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function showcaseHtmlEvidence(html: string): ShowcaseEvidenceBlock[] {
  const safe = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  return safe.split(/<\/(?:p|h[1-6]|li|tr|blockquote|pre|figcaption|div)>/i).flatMap(part => {
    const heading = /<h[1-6]\b/i.test(part);
    const text = part.replace(/<[^>]*>/g, " ").replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const n = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
    }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[name] ?? " ")
      .replace(/\s+/g, " ").trim();
    return text ? [{ location: "", text, ...(heading ? { heading: true } : {}) }] : [];
  }).map((block, i) => ({ ...block, location: `段落 ${i + 1}` }));
}

export type ShowcaseContentSnapshot = { fingerprint: string; text: string; structure: string; blocks: ShowcaseEvidenceBlock[] };
export function showcaseContentSnapshot(blocks: ShowcaseEvidenceBlock[], html = "", binaryIdentity?: string): ShowcaseContentSnapshot {
  const normalize = (s: string) => s.replace(/\s/g, "");
  const text = blocks.map(b => normalize(b.text)).join("");
  // Keep structural facts and material identity; fonts, colors and layout attributes are irrelevant.
  const structural = [...html.matchAll(/<(h[1-6]|table|tr|td|th|pre|code)\b[^>]*>/gi)].map(m => m[1].toLowerCase());
  const structuredText = [...html.matchAll(/<(h[1-6]|table|pre|code)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)]
    .map(m => [m[1].toLowerCase(), normalize(showcaseHtmlEvidence(m[2]).map(b => b.text).join(""))]);
  const materials = [...html.matchAll(/<(img|video|audio|source|iframe|a)\b([^>]*)>/gi)].map(m => [m[1].toLowerCase(),
    [...m[2].matchAll(/\b(src|data-asset-id|poster|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
      .map(a => [a[1].toLowerCase(), (a[2] ?? a[3] ?? a[4]).replace(/&amp;/g, "&")]).sort((a, b) => a[0].localeCompare(b[0]))]);
  const numbers = text.match(/[-+]?\d+(?:[.,]\d+)*(?:%|℃)?/g) ?? [];
  const structure = digestShowcaseContent([structural, structuredText, materials, numbers, binaryIdentity ?? null]);
  return { fingerprint: digestShowcaseContent([text, structure]), text, structure, blocks };
}

/** Bounded Myers edit distance; stop once the absolute scheduling threshold is reached. */
export function showcaseChangedCharacters(a: string, b: string): number {
  let start = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const left = a.slice(start, endA), right = b.slice(start, endB);
  if (!left.length || !right.length) return Math.max(left.length, right.length);
  const limit = 300, offset = limit + 1, v = new Int32Array(limit * 2 + 3);
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      const at = offset + k;
      let x = k === -d || (k !== d && v[at - 1] < v[at + 1]) ? v[at + 1] : v[at - 1] + 1;
      let y = x - k;
      while (x < left.length && y < right.length && left[x] === right[y]) { x++; y++; }
      v[at] = x;
      if (x >= left.length && y >= right.length) return d;
    }
  }
  return limit;
}
export function showcaseContentChange(previous: ShowcaseContentSnapshot, current: ShowcaseContentSnapshot): "same" | "minor" | "significant" {
  if (previous.fingerprint === current.fingerprint) return "same";
  if (previous.structure !== current.structure) return "significant";
  const changed = showcaseChangedCharacters(previous.text, current.text);
  return changed >= 300 || changed / Math.max(1, previous.text.length, current.text.length) >= 0.15 ? "significant" : "minor";
}
export function showcaseAnalysisAvailableAt(now: number, pendingSince: number, lastRequestedAt?: number): Date {
  return new Date(Math.max(Math.min(now + SHOWCASE_DEBOUNCE_MS, pendingSince + SHOWCASE_MAX_DEBOUNCE_MS), (lastRequestedAt ?? 0) + SHOWCASE_COOLDOWN_MS));
}

export function remapShowcaseReasons(reasons: ShowcaseRecommendationReason[], blocks: ShowcaseEvidenceBlock[]): ShowcaseRecommendationReason[] {
  return reasons.flatMap(reason => {
    if (reason.kind !== "quality" || !reason.quote) return [];
    const matches = blocks.filter(b => b.text.includes(reason.quote!));
    // Ambiguous quotations do not get a made-up locator.
    return matches.length === 1 ? [{ ...reason, location: matches[0].location }] : [];
  });
}

export function sampleShowcaseEvidence(blocks: ShowcaseEvidenceBlock[], requirements: string): { blocks: ShowcaseEvidenceBlock[]; coverage: ShowcaseAnalysisCoverage } {
  const total = blocks.reduce((n, b) => n + b.text.length, 0);
  if (total <= SHOWCASE_TEXT_BUDGET) return { blocks, coverage: { mode: "full", sourceCharacters: total, analyzedCharacters: total } };
  const fragments = blocks.flatMap(b => Array.from({ length: Math.ceil(b.text.length / 500) }, (_, i) => ({ ...b, text: b.text.slice(i * 500, (i + 1) * 500) })));
  const keywords = requirements.match(/[\p{L}\p{N}]{2,12}/gu) ?? [];
  const order = new Set<number>();
  order.add(0); order.add(fragments.length - 1);
  fragments.map((b, i) => b.heading ? i : -1).filter(i => i >= 0).slice(0, 4).forEach(i => order.add(i));
  // Reserve most of the budget for distributed coverage, rather than only matching the opening section.
  for (let i = 1; i <= 9; i++) order.add(Math.round(i * (fragments.length - 1) / 10));
  fragments.forEach((b, i) => { if (keywords.some(word => b.text.includes(word))) order.add(i); });
  fragments.forEach((_, i) => order.add(i));
  let remaining = SHOWCASE_TEXT_BUDGET;
  const selected: Array<{ index: number; block: ShowcaseEvidenceBlock }> = [];
  for (const index of order) { if (!remaining) break; const b = fragments[index]; const text = b.text.slice(0, remaining); selected.push({ index, block: { ...b, text } }); remaining -= text.length; }
  return { blocks: selected.sort((a, b) => a.index - b.index).map(x => x.block), coverage: { mode: "sampled", sourceCharacters: total, analyzedCharacters: SHOWCASE_TEXT_BUDGET - remaining } };
}

export function boundedShowcaseContext(requirements: string, dimensions: ShowcaseQualityDimension[]) {
  // Preserve dimension identities and weights; descriptions share the remaining allowance.
  const compact = dimensions.map(d => ({ id: d.id, name: d.name, weight: d.weight, description: "" }));
  let remaining = Math.max(0, SHOWCASE_CONTEXT_BUDGET - JSON.stringify({ requirements: "", dimensions: compact }).length);
  const task = requirements.slice(0, Math.floor(remaining * 0.75)); remaining -= task.length;
  const each = Math.floor(remaining / Math.max(1, dimensions.length));
  return { requirements: task, dimensions: compact.map((d, i) => ({ ...d, description: dimensions[i].description.slice(0, each) })), requirementsTruncated: task.length < requirements.length };
}
