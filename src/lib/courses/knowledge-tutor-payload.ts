import type { KnowledgeLectureBoardNote } from '@/lib/session/types';

export const TUTOR_EXECUTION_MS = 150_000;
export const TUTOR_LEASE_MS = 180_000;
export const TUTOR_PROMPT_VERSION = 'knowledge-tutor-v2';
export const TUTOR_SYSTEM = `你是知识讲授阶段的伴学助教。围绕具体题目清楚、简短、有层次地讲解，并回应追问。依据给定的题目、标准答案与参考资料，不能虚构知识。回答正确时解释关键判断依据，回答错误时指出具体误区，再补充一个最小例子。answer 是聊天区中自然完整的口头回答。boardNotes 只记录值得保留的核心概念、判断依据或可复用方法，不重复全文或已有板书，每次最多2条，也可以为空。严格返回 JSON：{"answer":"给学生的回答","boardNotes":[{"title":"简短板书标题","body":"精炼的核心内容","kind":"concept|evidence|correction|example"}]}。`;

export type TutorSyntaxRepair = 'removed-extra-object-close-before-board-notes'
  | 'joined-complete-answer-and-board-notes-objects'
  | 'inserted-missing-board-notes-key-separator';

// Called only after JSON.parse succeeds. Distinct object keys are required for
// a structural repair to be lossless, including inside individual notes.
function hasDuplicateObjectKeys(json: string): boolean {
  const tokens = json.match(/"(?:[^"\\]|\\.)*"|[{}[\]:]/g) ?? [];
  const scopes: Array<Set<string> | null> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '{') scopes.push(new Set());
    else if (token === '[') scopes.push(null);
    else if (token === '}' || token === ']') scopes.pop();
    else if (tokens[index + 1] === ':') {
      const key = JSON.parse(token) as string;
      const scope = scopes.at(-1);
      if (scope?.has(key)) return true;
      scope?.add(key);
    }
  }
  return false;
}

export function parseTutorPayload(raw: string, now: string): { answer: string; notes: KnowledgeLectureBoardNote[]; syntaxRepair?: TutorSyntaxRepair } {
  let parsed: { answer?: unknown; boardNotes?: unknown };
  let syntaxRepair: TutorSyntaxRepair | undefined;
  const trimmed = raw.trim();
  const candidate = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  try { parsed = JSON.parse(candidate); }
  catch {
    // Correct only these observed, complete shapes: an extra close before
    // boardNotes, one answer-only object followed by one boardNotes-only
    // object, or missing comma/open quote before the boardNotes key. Never
    // extract partial JSON, discard roots or invent fields.
    const extraClose = candidate.match(/^\{\s*("answer"\s*:\s*"(?:[^"\\]|\\.)*")\s*}\s*,\s*("boardNotes"\s*:\s*\[[\s\S]*\])\s*}$/);
    const splitRoots = extraClose ? null : candidate.match(/^\{\s*("answer"\s*:\s*"(?:[^"\\]|\\.)*")\s*}\s*\{\s*("boardNotes"\s*:\s*\[[\s\S]*\])\s*}$/);
    const missingSeparator = extraClose || splitRoots ? null : candidate.match(/^(\{\s*"answer"\s*:\s*"(?:[^"\\]|\\.)*"\s*)(boardNotes"\s*:\s*\[[\s\S]*\]\s*})$/);
    const match = extraClose ?? splitRoots ?? missingSeparator;
    if (!match) throw new Error('TUTOR_INVALID_OUTPUT');
    const repaired = missingSeparator ? `${match[1]},"${match[2]}` : `{${match[1]},${match[2]}}`;
    try { parsed = JSON.parse(repaired); }
    catch { throw new Error('TUTOR_INVALID_OUTPUT'); }
    if ((splitRoots || missingSeparator) && (Object.keys(parsed).length !== 2 || hasDuplicateObjectKeys(repaired))) throw new Error('TUTOR_INVALID_OUTPUT');
    // This new repair must preserve every note exactly: reject shapes that
    // would otherwise be dropped, truncated, defaulted or normalized below.
    if (missingSeparator && (!Array.isArray(parsed.boardNotes) || parsed.boardNotes.length > 2
      || parsed.boardNotes.some((note: unknown) => {
        if (!note || typeof note !== 'object' || Array.isArray(note)) return true;
        const item = note as Record<string, unknown>;
        return Object.keys(item).length !== 3
          || typeof item.title !== 'string' || !item.title || item.title !== item.title.trim() || item.title.length > 80
          || typeof item.body !== 'string' || !item.body || item.body !== item.body.trim() || item.body.length > 500
          || typeof item.kind !== 'string' || !['concept', 'evidence', 'correction', 'example'].includes(item.kind);
      }))) throw new Error('TUTOR_INVALID_OUTPUT');
    syntaxRepair = extraClose ? 'removed-extra-object-close-before-board-notes'
      : splitRoots ? 'joined-complete-answer-and-board-notes-objects'
        : 'inserted-missing-board-notes-key-separator';
  }
  if (!parsed || typeof parsed.answer !== 'string' || !parsed.answer.trim()
    || (parsed.boardNotes !== undefined && !Array.isArray(parsed.boardNotes))) throw new Error('TUTOR_INVALID_OUTPUT');
  const notes = (Array.isArray(parsed.boardNotes) ? parsed.boardNotes : []).slice(0, 2).flatMap((item, index) => {
    if (!item || typeof item.title !== 'string' || typeof item.body !== 'string') return [];
    const title = item.title.trim().slice(0, 80); const body = item.body.trim().slice(0, 500);
    if (!title || !body) return [];
    const kind: KnowledgeLectureBoardNote['kind'] = ['concept', 'evidence', 'correction', 'example'].includes(item.kind) ? item.kind : 'concept';
    return [{ id: `board-${now}-${index}`, title, body, kind, createdAt: now }];
  });
  return { answer: parsed.answer, notes, ...(syntaxRepair ? { syntaxRepair } : {}) };
}
