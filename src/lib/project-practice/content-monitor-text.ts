/** Retain offsets so source matches remove only their own text, including mixed pastes. */
function csvFormattingOffsets(value: string): Set<number> {
  const rows: Array<{ count: number; formatting: number[] }> = [];
  for (const line of value.matchAll(/[^\r\n]+/g)) {
    let quoted = false;
    let count = 1;
    const formatting: number[] = [];
    for (let index = 0; index < line[0].length; index++) {
      const char = line[0][index];
      if (char === '"') {
        if (quoted && line[0][index + 1] === '"') { index++; continue; }
        if (!quoted && index > 0 && line[0][index - 1] !== ',') return new Set();
        if (quoted && index + 1 < line[0].length && line[0][index + 1] !== ',') return new Set();
        quoted = !quoted;
        formatting.push(line.index + index);
      } else if (char === ',' && !quoted) {
        count++; formatting.push(line.index + index);
      }
    }
    if (quoted || count < 2) return new Set();
    rows.push({ count, formatting });
  }
  return rows.length >= 2 && rows.every(row => row.count === rows[0].count)
    ? new Set(rows.flatMap(row => row.formatting)) : new Set();
}

function markdownFormatting(value: string): { formatting: Set<number>; code: Set<number> } {
  const formatting = new Set<number>();
  const code = new Set<number>();
  const mark = (set: Set<number>, start: number, length: number) => { for (let i = start; i < start + length; i++) set.add(i); };
  const lines = [...value.matchAll(/[^\r\n]+/g)];
  const tableLines = lines.filter(line => line[0].includes('|') && !/[=;{}]|=>/.test(line[0]));
  const isTable = tableLines.length >= 2;
  let fence: string | undefined;
  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line[0]);
    if (fenceMatch && (!fence || fenceMatch[1][0] === fence[0])) {
      mark(formatting, line.index, line[0].length);
      fence = fence ? undefined : fenceMatch[1];
      continue;
    }
    if (fence || /^\s*(?:const |let |var |function |return |def |class |import |from |if\s*\(|for\s*\(|while\s*\()/.test(line[0])) {
      mark(code, line.index, line[0].length); continue;
    }
    if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line[0])) {
      mark(formatting, line.index, line[0].length); continue;
    }
    if (isTable && tableLines.includes(line)) {
      for (let i = 0; i < line[0].length; i++) if (line[0][i] === '|') formatting.add(line.index + i);
    }
    const prefix = /^\s{0,3}(?:#{1,6}\s+|>\s+|[-+*]\s+|\d+[.)]\s+)/.exec(line[0]);
    if (prefix) mark(formatting, line.index, prefix[0].length);
    for (const match of line[0].matchAll(/(^|[\s([（【])(\*\*|__|~~|\*|_)(\S(?:.*?\S)?)\2(?=$|[\s.,，。!?！？;；:：)\]）】])/g)) {
      const start = line.index + match.index + match[1].length;
      mark(formatting, start, match[2].length);
      mark(formatting, start + match[2].length + match[3].length, match[2].length);
    }
    for (const match of line[0].matchAll(/`([^`\n]+)`/g)) {
      formatting.add(line.index + match.index);
      formatting.add(line.index + match.index + match[0].length - 1);
      mark(code, line.index + match.index + 1, match[1].length);
    }
  }
  return { formatting, code };
}

function comparable(value: string, csv = false): { text: string; offsets: number[] } {
  const parts: string[] = [];
  const offsets: number[] = [];
  const csvFormatting = csv ? csvFormattingOffsets(value) : new Set<number>();
  const markdown = markdownFormatting(value);
  const tokens = /<\/?(?:p|div|span|br|h[1-6]|strong|em|b|i|u|s|pre|code|blockquote|ul|ol|li|table|thead|tbody|tr|th|td|a)\b[^>]*>|&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);|[\s\S]/giu;
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  for (const match of value.matchAll(tokens)) {
    if (csvFormatting.has(match.index)) continue;
    if (markdown.formatting.has(match.index) && !markdown.code.has(match.index)) continue;
    let character = match[0];
    const code = markdown.code.has(match.index);
    if (!code && character.startsWith("<") && character.length > 1) continue;
    if (!code && character.startsWith("&") && character.length > 1) {
      const entity = character.slice(1, -1).toLowerCase();
      const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : entity.startsWith("#") ? parseInt(entity.slice(1), 10) : NaN;
      character = entities[entity] ?? (Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : character);
    }
    // Formatting changes (including CSV/TSV/Markdown table copies) are not new authorship.
    if (/^[\s\u200b-\u200d\ufeff]+$/u.test(character)) continue;
    for (let index = 0; index < character.length; index++) {
      parts.push(character[index]);
      offsets.push(match.index + (code ? index : 0));
    }
  }
  return { text: parts.join(""), offsets };
}

export function normalizeMonitorText(value: string): string {
  return comparable(value).text;
}

/** Exact contiguous matches only: shared phrases shorter than 48 characters cannot exempt answers. */
export function stripKnownSourceText(text: string, knownSources: string[]): string {
  if (!knownSources.length || !text) return text;
  // CSV punctuation is formatting only when the accessible source is actually
  // a table. Ordinary prose and code keep their commas and string quotes.
  const tableSource = knownSources.some(source => /<table\b|^\s*\|.+\|\s*$|^.*\t.+$/im.test(source));
  const candidate = comparable(text, tableSource);
  const sources = knownSources.map(normalizeMonitorText).filter(Boolean).join("\u0000");
  if (!candidate.text || !sources) return text;
  if (candidate.text.length >= 24 && sources.includes(candidate.text)) return "";
  const ranges: Array<[number, number]> = [];
  const seedLength = 48;
  for (let offset = 0; offset <= candidate.text.length - seedLength;) {
    const seed = candidate.text.slice(offset, offset + seedLength);
    let matchAt = sources.indexOf(seed);
    let longest = 0;
    // Repeated templates should not turn matching into unbounded quadratic work.
    for (let occurrence = 0; matchAt >= 0 && occurrence < 8; occurrence++) {
      let length = seedLength;
      while (offset + length < candidate.text.length && sources[matchAt + length] === candidate.text[offset + length]) length++;
      longest = Math.max(longest, length);
      matchAt = sources.indexOf(seed, matchAt + 1);
    }
    if (!longest) { offset++; continue; }
    ranges.push([candidate.offsets[offset], candidate.offsets[offset + longest - 1] + 1]);
    offset += longest;
  }
  let cursor = 0;
  const remaining: string[] = [];
  for (const [start, end] of ranges) { remaining.push(text.slice(cursor, start)); cursor = end; }
  remaining.push(text.slice(cursor));
  return remaining.join("\n").trim();
}
