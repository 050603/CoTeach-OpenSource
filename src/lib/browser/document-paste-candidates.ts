import {
  CONTENT_MONITOR_MAX_TEXT,
  CONTENT_MONITOR_SINGLE_MIN,
  CONTENT_MONITOR_WINDOW_MIN,
  CONTENT_MONITOR_WINDOW_MS,
  nonWhitespaceLength,
  type ContentMonitorFragment,
} from '@/lib/project-practice/content-monitor-contract';
import { normalizeMonitorText, stripKnownSourceText } from '@/lib/project-practice/content-monitor-text';

export function normalizePasteText(text: string): string {
  return normalizeMonitorText(text.normalize('NFKC'));
}

export function documentHtmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style').forEach(node => node.remove());
  doc.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,tr,blockquote,pre,br').forEach(node => node.append('\n'));
  return doc.body.textContent ?? '';
}

/** Local observations only reduce duplicate work; the server verifies sources. */
export class DocumentPasteCandidates {
  private pending: Array<ContentMonitorFragment & { at: number; newCharacters: number }> = [];
  private checked: string[] = [];

  add(paste: ContentMonitorFragment & { internalTransfer?: boolean }, now = Date.now()): ContentMonitorFragment[][] {
    this.pending = this.pending.filter(fragment => now - fragment.at < CONTENT_MONITOR_WINDOW_MS);
    if (paste.text.length > CONTENT_MONITOR_MAX_TEXT) return [];
    const normalized = normalizePasteText(paste.text);
    if (!normalized || paste.internalTransfer
      || normalizePasteText(paste.beforeText).includes(normalized)
      || this.checked.some(previous => previous.includes(normalized))
      || this.pending.some(fragment => normalizePasteText(fragment.text).includes(normalized))) return [];
    const newText = stripKnownSourceText(paste.text, [paste.beforeText, ...this.checked, ...this.pending.map(fragment => fragment.text)]);
    const newCharacters = nonWhitespaceLength(newText);
    if (!newCharacters) return [];
    this.pending.push({ text: newText, beforeText: paste.beforeText, blockId: paste.blockId, at: now, newCharacters });
    if (newCharacters < CONTENT_MONITOR_SINGLE_MIN
      && this.pending.reduce((total, fragment) => total + fragment.newCharacters, 0) < CONTENT_MONITOR_WINDOW_MIN) return [];

    const candidates = this.pending;
    this.pending = [];
    this.checked = [...this.checked, ...candidates.map(fragment => normalizePasteText(fragment.text))].slice(-100);
    const batches: ContentMonitorFragment[][] = [];
    let batch: ContentMonitorFragment[] = [];
    let length = 0;
    for (const fragment of candidates) {
      if (length + fragment.text.length > CONTENT_MONITOR_MAX_TEXT || batch.length === 64) {
        batches.push(batch); batch = []; length = 0;
      }
      batch.push({ text: fragment.text, beforeText: fragment.beforeText.slice(0, CONTENT_MONITOR_MAX_TEXT), ...(fragment.blockId ? { blockId: fragment.blockId } : {}) });
      length += fragment.text.length;
    }
    if (batch.length) batches.push(batch);
    return batches;
  }
}
