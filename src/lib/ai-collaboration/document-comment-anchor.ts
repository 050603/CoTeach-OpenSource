import type { DocumentAiCommentThread, DocumentBlockCandidate } from './document-comment-types';

export const DOCUMENT_BLOCK_ID_ATTRIBUTE = 'data-openpbl-block-id';
export const DOCUMENT_COMMENT_ANCHOR_VERSION = 1 as const;
const validId = /^[A-Za-z0-9_-]{1,160}$/;
export function isDocumentBlockId(value: unknown): value is string {
  return typeof value === 'string' && validId.test(value);
}

const blockTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'tr', 'td', 'th', 'pre', 'img', 'hr']);
const rawTextTags = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const attributes = /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** A conservative tokenizer for identity evidence, not a document parser. It
 * consumes EVERY outer tag (including quoted attributes) before filtering.
 * Comments and raw/inert text are opaque; incomplete markup fails closed. */
function* openingTags(html: string): Generator<{ start: number; end: number; name: string; text: string }> {
  let offset = 0; let templateDepth = 0;
  while (offset < html.length) {
    const start = html.indexOf('<', offset);
    if (start < 0) return;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) return;
      offset = end + 3; continue;
    }
    if (html.startsWith('<![CDATA[', start)) {
      const end = html.indexOf(']]>', start + 9);
      if (end < 0) return;
      offset = end + 3; continue;
    }
    const head = /^<(\/?)([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(html.slice(start));
    if (!head && !/^<[!?]/.test(html.slice(start, start + 2))) { offset = start + 1; continue; }
    let quote = ''; let end = start + (head?.[0].length ?? 2);
    for (; end < html.length; end++) {
      const character = html[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === html.length) return;
    offset = end + 1;
    if (!head) continue;
    const name = head[2].toLowerCase();
    if (name === 'template') {
      templateDepth = Math.max(0, templateDepth + (head[1] ? -1 : 1));
      continue;
    }
    if (head[1]) continue;
    if (name === 'plaintext') return;
    if (rawTextTags.has(name)) {
      const close = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
      close.lastIndex = offset;
      const match = close.exec(html);
      if (!match) return;
      offset = match.index; continue;
    }
    if (templateDepth === 0) yield { start, end: offset, name, text: html.slice(start, offset) };
  }
}

/** Only unique bounded ID attributes on actual block tags are authoritative. */
export function persistedDocumentBlockIds(html: string): Set<string> {
  const counts = new Map<string, number>();
  for (const tag of openingTags(html)) {
    if (!blockTags.has(tag.name)) continue;
    const ids = [...tag.text.matchAll(attributes)]
      .filter(match => match[1].toLowerCase() === DOCUMENT_BLOCK_ID_ATTRIBUTE)
      .map(match => match[2] ?? match[3] ?? match[4]);
    if (ids.length !== 1 || !isDocumentBlockId(ids[0])) {
      for (const id of ids) if (isDocumentBlockId(id)) counts.set(id, 2);
      continue;
    }
    const id = ids[0];
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([id]) => id));
}

/** ID hydration/normalization is metadata, never a student edit by itself. */
export function withoutDocumentBlockIds(html: string): string {
  const parts: string[] = []; let offset = 0;
  for (const tag of openingTags(html)) {
    if (!blockTags.has(tag.name)) continue;
    parts.push(html.slice(offset, tag.start), tag.text.replace(attributes,
      (full, name: string, double: string, single: string, bare: string) =>
        name.toLowerCase() === DOCUMENT_BLOCK_ID_ATTRIBUTE && isDocumentBlockId(double ?? single ?? bare) ? '' : full));
    offset = tag.end;
  }
  parts.push(html.slice(offset));
  return parts.join('');
}

type Anchor = Pick<DocumentAiCommentThread, 'blockId' | 'anchorVersion' | 'blockIndex' | 'blockText' | 'targetText'>;
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Shared by comment display, invalidation, and edit selection. The full block
 * and a unique target must still agree even when an ID survives a move.
 * Pre-v1 IDs were volatile across HTML reloads: only those old threads may use
 * a single exact full-paragraph match when their original ID is absent. */
export function resolveDocumentCommentAnchor(anchor: Anchor, candidates: DocumentBlockCandidate[]): number {
  const expected = normalize(anchor.blockText ?? anchor.targetText);
  const matches = (candidate: DocumentBlockCandidate) => candidate.text.includes(anchor.targetText)
    && normalize(candidate.text) === expected
    && candidate.text.indexOf(anchor.targetText, candidate.text.indexOf(anchor.targetText) + anchor.targetText.length) < 0;
  if (!anchor.targetText || !expected
    || (anchor.anchorVersion === DOCUMENT_COMMENT_ANCHOR_VERSION && !anchor.blockId)) return -1;
  if (anchor.blockId) {
    const owned = candidates.filter(candidate => candidate.blockId === anchor.blockId);
    if (owned.length) return owned.length === 1 && matches(owned[0]) ? owned[0].blockIndex : -1;
    // New identity was confirmed in the actual reviewed HTML. Deletion is final
    // for that anchor, even if an identical new paragraph exists elsewhere.
    if (anchor.anchorVersion === DOCUMENT_COMMENT_ANCHOR_VERSION) return -1;
    if (!anchor.blockText) return -1;
  }
  const exact = candidates.filter(matches);
  return exact.length === 1 ? exact[0].blockIndex : -1;
}
