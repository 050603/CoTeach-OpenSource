import { createHash } from 'node:crypto';
import type { QuizQuestion } from '@openmaic/lib/types/stage';
import { authoredQuestionFingerprintInput, type TutorEvidence } from './knowledge-tutor-evidence-shared';
export { knowledgeTutorEvidence, type TutorEvidence } from './knowledge-tutor-evidence-shared';

export function authoredQuestionFingerprint(question: QuizQuestion, evidence: TutorEvidence): string {
  return createHash('sha256').update(authoredQuestionFingerprintInput(question, evidence)).digest('hex');
}
export function tutorEvidencePrompt(evidence: TutorEvidence | undefined): string {
  if (!evidence || (!evidence.items.length && !evidence.authoredQuotes.length)) return '原始资料：当前题目没有可用的原文证据；仅按已提供的题目与参考讲解解释，不声称引自教材，不扩写未提供的事实。';
  return `实际采用的原始资料（版本 ${evidence.version ?? '作者引用'}，指纹 ${evidence.fingerprint ?? '作者引用'}）：\n${JSON.stringify(evidence)}`;
}
