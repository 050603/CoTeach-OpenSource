"use client";

import { useEffect, useId, useRef, type CSSProperties } from "react";
import { Check, Info } from "lucide-react";
import { groupExperimentQuestions, type ExperimentQuestionGroup } from "@/lib/platform/experiment";
import { designPromptParts, parseDesignAnswer, serializeDesignAnswer } from "@/lib/platform/experiment-design-answer";
import styles from "./experiment-assessment.module.css";

export type ExperimentDisplayQuestion = {
  id: string;
  prompt: string;
  type: "single-choice" | "multiple-choice" | "true-false" | "short-answer" | "scale";
  options?: string[];
  category?: string;
  scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
  group?: ExperimentQuestionGroup;
  optional?: boolean;
  skipReasonRequired?: boolean;
};

export type ExperimentDisplayAnswer = string | string[];

const typeLabel: Record<ExperimentDisplayQuestion["type"], string> = {
  "single-choice": "单选题",
  "multiple-choice": "多选题",
  "true-false": "判断题",
  "short-answer": "简答题",
  scale: "量表题",
};

const categoryLabel: Record<string, string> = {
  knowledge: "知识理解",
  "micro-design": "微设计能力",
  confidence: "学习信心",
  collaboration: "协作体验",
  other: "其他",
};

function promptParagraphs(prompt: string) {
  return (prompt.trim().replace(/\r\n?/g, "\n") || "未填写题干").split(/\n\s*\n/);
}

// Older assigned snapshots and copied questions can still contain template codes.
function displayPrompt(prompt: string) {
  return prompt.trim().replace(/^(?:K|CoI|CY|S)\d{1,3}(?:\s+|[.．、:：]\s*)/i, "");
}

function displayInstruction(instruction?: string) {
  return instruction?.split(/\n\s*\n/).filter((paragraph) => !/^量表[：:]\s*Chinese System Usability Scale\b/i.test(paragraph.trim())).join("\n\n");
}

function ReferenceNote({ note, id, onReadReference, compact = false }: { note: string; id: string; onReadReference?: () => void; compact?: boolean }) {
  if (compact) return <div className={styles.reference} id={id}>
    <div className={styles.referenceHeading}><span>指代说明 · 请先阅读</span>{onReadReference ? <button onClick={onReadReference} type="button">重新阅读说明</button> : null}</div>
    <p>{note}</p>
  </div>;
  return <div className="mt-4 rounded-xl border border-orange-200 bg-orange-50 p-4 text-orange-950 sm:p-5" id={id}>
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="inline-flex items-center gap-2 text-sm font-bold text-orange-800"><Info aria-hidden="true" className="shrink-0" size={20} />指代说明 · 请先阅读</p>
      {onReadReference ? <button className="min-h-11 rounded-lg px-3 text-sm font-semibold text-orange-800 underline decoration-orange-300 underline-offset-4 hover:bg-orange-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700" onClick={onReadReference} type="button">重新阅读说明</button> : null}
    </div>
    <p className="mt-2 whitespace-pre-wrap text-base font-semibold leading-8 [overflow-wrap:anywhere]">{note}</p>
  </div>;
}

function ScaleScoreGuide({ scale, id }: { scale: NonNullable<ExperimentDisplayQuestion["scale"]>; id: string }) {
  const scores = Array.from({ length: scale.max - scale.min + 1 }, (_, offset) => scale.min + offset);
  return <div aria-label="分值含义" className={styles.scoreLabels} id={id} role="list" style={{ "--score-columns": Math.min(scores.length, 5) } as CSSProperties}>
    {scores.map((score) => {
      const meaning = score === scale.min ? scale.minLabel || "最低" : score === scale.max ? scale.maxLabel || "最高" : "";
      return <span aria-label={`${score} 分${meaning ? ` · ${meaning}` : ""}`} className={styles.scoreCaption} key={score} role="listitem">
        <span className={styles.scoreMeaning}>{meaning || "\u00a0"}</span>
        <span>{score} 分</span>
      </span>;
    })}
  </div>;
}

export function ExperimentQuestionCard({ question, index, answer, onAnswerChange, inputName, id, invalid = false, grouped = false, descriptionId, readOnly = false, compact = false, sharedScale = false }: {
  question: ExperimentDisplayQuestion;
  index: number;
  answer?: ExperimentDisplayAnswer;
  onAnswerChange: (answer: ExperimentDisplayAnswer) => void;
  inputName: string;
  id?: string;
  invalid?: boolean;
  grouped?: boolean;
  descriptionId?: string;
  readOnly?: boolean;
  compact?: boolean;
  sharedScale?: boolean;
}) {
  const headingId = useId();
  const scaleGuideId = `${headingId}-scale-guide`;
  const prompt = displayPrompt(question.prompt);
  const referenceNoteId = `${headingId}-reference`;
  const standaloneReference = !grouped ? question.group?.referenceNote : undefined;
  const textArea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!textArea.current) return;
    textArea.current.style.height = "auto";
    textArea.current.style.height = `${Math.max(144, textArea.current.scrollHeight)}px`;
  }, [answer]);
  const choices = question.type === "true-false" ? ["true", "false"] : question.options ?? [];
  const scores = question.scale && question.scale.max > question.scale.min
    ? Array.from({ length: question.scale.max - question.scale.min + 1 }, (_, offset) => String(question.scale!.min + offset)) : [];
  const design = question.type === "short-answer" ? designPromptParts(prompt) : null;
  const designAnswer = design ? parseDesignAnswer(typeof answer === "string" ? answer : undefined) : null;

  if (compact && question.type === "scale" && scores.length) return <fieldset
    aria-invalid={invalid || undefined}
    aria-labelledby={headingId}
    aria-describedby={[descriptionId, !sharedScale ? scaleGuideId : undefined, standaloneReference ? referenceNoteId : undefined].filter(Boolean).join(" ") || undefined}
    className={`${styles.scaleRow} ${!grouped ? styles.scaleStandalone : ""} ${invalid ? styles.invalid : ""}`}
    id={id}
    onKeyDown={(event) => {
      if (readOnly || event.ctrlKey || event.metaKey || event.altKey || !/^\d$/.test(event.key) || !scores.includes(event.key)) return;
      event.preventDefault();
      onAnswerChange(event.key);
    }}
    tabIndex={-1}
  >
    <div className={styles.scalePrompt} id={headingId}>
      <span aria-hidden="true" className={styles.number}>{String(index + 1).padStart(2, "0")}</span>
      <span className="sr-only">第 {index + 1} 题，{question.optional ? "选答" : "必答"}：</span>
      <div>{promptParagraphs(prompt).map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}</div>
    </div>
    <div className={styles.scaleAnswer}>
      {!sharedScale ? <ScaleScoreGuide id={scaleGuideId} scale={question.scale!} /> : null}
      <div className={styles.scoreOptions} style={{ "--score-columns": Math.min(scores.length, 5) } as CSSProperties}>
        {scores.map((score) => <label className={styles.score} key={score}>
          <input aria-label={`${score} 分`} checked={answer === score} className="sr-only" disabled={readOnly} name={inputName} onChange={() => onAnswerChange(score)} type="radio" value={score} />
          {score}
        </label>)}
      </div>
    </div>
    {standaloneReference ? <div className={styles.rowDetails}><ReferenceNote compact id={referenceNoteId} note={standaloneReference} /></div> : null}
    <span aria-live="polite" className="sr-only">{answer ? `已选择 ${answer} 分` : "尚未选择"}</span>
    {question.optional && !readOnly ? <button className={`${styles.clearScore} ${styles.rowDetails} disabled:text-[var(--pbl-text-muted)] disabled:no-underline`} disabled={!answer} onClick={() => onAnswerChange("")} type="button">{answer ? "清除作答并跳过" : "可跳过"}</button> : null}
    {invalid ? <p className={`${styles.rowDetails} text-xs text-[var(--pbl-danger)]`}>请完成这道题后再提交。</p> : null}
  </fieldset>;

  return <fieldset
    aria-invalid={invalid || undefined}
    aria-labelledby={headingId}
    aria-describedby={[descriptionId, standaloneReference ? referenceNoteId : undefined].filter(Boolean).join(" ") || undefined}
    className={`min-w-0 scroll-mt-24 bg-white py-5 sm:py-6 ${grouped ? "border-b px-4 last:border-b-0 sm:px-6" : "rounded-[14px] border px-4 sm:px-6"} ${invalid ? "border-[var(--pbl-danger)]" : "border-[var(--pbl-border)]"} ${compact ? styles.compactCard : ""}`}
    id={id}
    tabIndex={-1}
  >
    <div className="flex min-w-0 items-start gap-3 sm:gap-4">
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[var(--pbl-student-soft)] text-sm font-bold tabular-nums text-[var(--pbl-student)]">{String(index + 1).padStart(2, "0")}</span>
      <div className="min-w-0 flex-1">
        {question.type !== "scale" ? <p className="text-xs font-semibold text-[var(--pbl-student)]">{typeLabel[question.type]}{question.category ? ` · ${categoryLabel[question.category] ?? question.category}` : ""}</p> : null}
        <div className={`${question.type === "scale" ? "" : "mt-2"} space-y-3 text-[16px] font-semibold leading-8 text-[var(--pbl-text-strong)] ${design ? "" : "max-w-[68ch]"}`} id={headingId}>
          <span className="sr-only">第 {index + 1} 题，{question.optional ? "选答" : "必答"}：</span>
          {design ? <p>情境设计：根据证据改进 8 分钟活动</p> : promptParagraphs(prompt).map((paragraph, paragraphIndex) => <p className="whitespace-pre-wrap [overflow-wrap:anywhere]" key={paragraphIndex}>{paragraph}</p>)}
        </div>
      </div>
      <span aria-hidden="true" className="hidden shrink-0 text-xs font-medium text-[var(--pbl-text-muted)] sm:block">{question.optional ? "可跳过" : "必答"}</span>
    </div>
    {standaloneReference ? <ReferenceNote id={referenceNoteId} note={standaloneReference} /> : null}
    <div className="mt-5 border-t border-[var(--pbl-border)] pt-5">
      {design && designAnswer ? <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] xl:gap-7">
        <section aria-label="题目情境" className="min-w-0 rounded-xl border border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)] p-4 sm:p-5">
          <p className="text-xs font-bold tracking-wider text-[var(--pbl-student)]">阅读情境</p>
          <div className="mt-4 space-y-3">{design.context.map((line, lineIndex) => <div className="rounded-lg border border-[var(--pbl-border)] bg-white p-3.5 sm:p-4" key={lineIndex}>
            <p className="text-xs font-bold text-[var(--pbl-student)]">{["任务与目标", "已有测试记录", "现有安排", "作答要求"][lineIndex] ?? "补充说明"}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm font-normal leading-7 text-[var(--pbl-text-strong)] [overflow-wrap:anywhere]">{line}</p>
          </div>)}</div>
        </section>
        <section aria-label="分项作答" className="min-w-0 space-y-4">
          <p className="text-xs font-bold tracking-wider text-[var(--pbl-student)]">按三点作答</p>
          {designAnswer.legacy && readOnly ? <div className="rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-bg)] p-4"><p className="text-xs font-semibold text-[var(--pbl-text-muted)]">此前提交的完整回答</p><p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--pbl-text-strong)] [overflow-wrap:anywhere]">{answer}</p></div> : <>
            {designAnswer.legacy ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">已载入旧版草稿。请把原回答拆分到下面三个答题框。</p> : null}
            {design.sections.map(({ label, guidance }, sectionIndex) => <div className="rounded-xl border border-[var(--pbl-border)] bg-white p-4" key={label}>
              <label className="flex items-center gap-2 text-sm font-bold text-[var(--pbl-text-strong)]" htmlFor={`${inputName}-${label}`}><span aria-hidden="true" className="grid size-7 place-items-center rounded-full bg-[var(--pbl-student-soft)] text-xs text-[var(--pbl-student)]">{sectionIndex + 1}</span>{label}</label>
              <p className="mt-2 text-sm leading-6 text-[var(--pbl-text-muted)]">{guidance}</p>
              <textarea aria-label={`${label}：${guidance}`} className="mt-3 min-h-28 w-full resize-y rounded-lg border border-[var(--pbl-border)] bg-[var(--pbl-bg)] px-4 py-3 text-sm leading-7 text-[var(--pbl-text-strong)] outline-none focus:border-[var(--pbl-student)] focus:ring-2 focus:ring-[var(--pbl-student-border)]" id={`${inputName}-${label}`} maxLength={3000} onChange={(event) => onAnswerChange(serializeDesignAnswer({ ...designAnswer.values, [label]: event.target.value }))} placeholder={`写下${label}部分…`} readOnly={readOnly} value={designAnswer.values[label]} />
            </div>)}
          </>}
        </section>
      </div> : question.type === "short-answer" ? <div>
        <label className="mb-2 block text-xs font-medium text-[var(--pbl-text-muted)]" htmlFor={`${inputName}-text`}>你的回答</label>
        <textarea
          aria-label={prompt || `第 ${index + 1} 题简答`}
          className="min-h-36 w-full resize-y rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-bg)] px-4 py-3 text-sm leading-7 text-[var(--pbl-text-strong)] outline-none transition-colors placeholder:text-[var(--pbl-text-muted)] focus:border-[var(--pbl-student)] focus:ring-2 focus:ring-[var(--pbl-student-border)] motion-reduce:transition-none"
          readOnly={readOnly}
          ref={textArea}
          id={`${inputName}-text`}
          maxLength={10_000}
          onChange={(event) => onAnswerChange(event.target.value)}
          placeholder="结合题目情境，写下你的想法…"
          value={typeof answer === "string" ? answer : ""}
        />
      </div> : question.type === "scale" ? scores.length ? <div className="space-y-4">
        {!grouped || !descriptionId ? <p className="text-xs text-[var(--pbl-text-muted)]">请选择最符合你当前想法的分值</p> : null}
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(48px, 1fr))" }}>
          {scores.map((score) => {
            const selected = answer === score;
            return <label className={`flex min-h-12 cursor-pointer items-center justify-center rounded-[10px] border px-2 py-2 text-sm font-semibold tabular-nums transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--pbl-student)] motion-reduce:transition-none ${selected ? "border-[var(--pbl-student)] bg-[var(--pbl-student)] text-white" : "border-[var(--pbl-border)] bg-[var(--pbl-bg)] text-[var(--pbl-text-strong)] hover:border-[var(--pbl-student-border)] hover:bg-[var(--pbl-student-soft)]"}`} key={score}>
              <input aria-label={`${score} 分`} checked={selected} className="sr-only" disabled={readOnly} name={inputName} onChange={() => onAnswerChange(score)} type="radio" value={score} />{score}
            </label>;
          })}
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-dashed border-[var(--pbl-border)] pt-3 text-xs leading-5 text-[var(--pbl-text-muted)]">
          <span className="max-w-[45%] whitespace-pre-wrap [overflow-wrap:anywhere]">{question.scale?.min} 分 · {question.scale?.minLabel || "最低"}</span>
          <span className="max-w-[45%] whitespace-pre-wrap text-right [overflow-wrap:anywhere]">{question.scale?.max} 分 · {question.scale?.maxLabel || "最高"}</span>
        </div>
        {answer ? <p aria-live="polite" className="text-xs font-semibold text-[var(--pbl-student)]">已选择 {answer} 分</p> : null}
      </div> : <p className="text-xs text-[var(--pbl-text-muted)]">请先在题目设置中填写有效量表范围。</p> : choices.length ? <div className={question.type === "true-false" ? "grid gap-3 sm:grid-cols-2" : "grid gap-3"}>
        {choices.map((choice, choiceIndex) => {
          const multiple = question.type === "multiple-choice";
          const selected = multiple ? Array.isArray(answer) && answer.includes(choice) : answer === choice;
          const text = question.type === "true-false" ? choice === "true" ? "正确" : "错误" : choice;
          return <label className={`flex min-h-14 min-w-0 cursor-pointer items-start gap-3 rounded-[10px] border px-3.5 py-3 text-sm leading-6 transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--pbl-student)] motion-reduce:transition-none ${selected ? "border-[var(--pbl-student)] bg-[var(--pbl-student-soft)] text-[var(--pbl-text-strong)]" : "border-[var(--pbl-border)] bg-[var(--pbl-bg)] text-[var(--pbl-text)] hover:border-[var(--pbl-student-border)] hover:bg-white"}`} key={choice}>
            <input
              aria-label={text}
              checked={selected}
              className="sr-only"
              disabled={readOnly}
              name={inputName}
              onChange={() => onAnswerChange(multiple
                ? selected ? (Array.isArray(answer) ? answer.filter((item) => item !== choice) : []) : [...(Array.isArray(answer) ? answer : []), choice]
                : choice)}
              type={multiple ? "checkbox" : "radio"}
              value={choice}
            />
            <span aria-hidden="true" className={`grid size-7 shrink-0 place-items-center rounded-[7px] text-xs font-bold ${selected ? "bg-[var(--pbl-student)] text-white" : "border border-[var(--pbl-border)] bg-white text-[var(--pbl-text-muted)]"}`}>{question.type === "true-false" ? choice === "true" ? "对" : "错" : String.fromCharCode(65 + choiceIndex)}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
            <span aria-hidden="true" className={`mt-1 grid size-5 shrink-0 place-items-center border-2 ${multiple ? "rounded-[6px]" : "rounded-full"} ${selected ? "border-[var(--pbl-student)] bg-[var(--pbl-student)]" : "border-[var(--pbl-border)] bg-white"}`}>{selected ? multiple ? <Check size={13} strokeWidth={3} className="text-white" /> : <span className="size-2 rounded-full bg-white" /> : null}</span>
          </label>;
        })}
      </div> : <p className="text-xs text-[var(--pbl-text-muted)]">请先在题目设置中填写选项。</p>}
      {question.optional && !readOnly && (Array.isArray(answer) ? answer.length > 0 : Boolean(answer)) ? <button className="mt-3 text-xs font-semibold text-[var(--pbl-student)] underline" onClick={() => onAnswerChange(question.type === "multiple-choice" ? [] : "")} type="button">清除作答并跳过</button> : null}
      {invalid ? <p className="mt-3 text-xs font-semibold text-[var(--pbl-danger)]">请完成这道题后再提交。</p> : null}
    </div>
  </fieldset>;
}

export function ExperimentQuestionList({ questions, answers, onAnswerChange, inputNamePrefix, questionIdPrefix, invalidQuestionId, startIndex = 0, readOnly = false, onReadReference, compact = false }: {
  questions: ExperimentDisplayQuestion[];
  answers: Record<string, ExperimentDisplayAnswer>;
  onAnswerChange: (questionId: string, answer: ExperimentDisplayAnswer) => void;
  inputNamePrefix: string;
  questionIdPrefix?: string;
  invalidQuestionId?: string | null;
  startIndex?: number;
  readOnly?: boolean;
  onReadReference?: () => void;
  compact?: boolean;
}) {
  const listId = useId();
  const sections = groupExperimentQuestions(questions);
  const ordered = sections.flatMap((section) => section.questions);

  return <div className={compact ? styles.questionList : "space-y-5"}>
    {sections.map((section, sectionIndex) => {
      const group = section.group;
      const instruction = displayInstruction(group?.instruction);
      const titleId = `${listId}-group-${sectionIndex}-title`;
      const instructionId = `${listId}-group-${sectionIndex}-instruction`;
      const referenceNoteId = `${listId}-group-${sectionIndex}-reference`;
      const scale = section.questions[0]?.scale;
      const sharedScale = compact && Boolean(group) && Boolean(scale) && section.questions.every((question) => question.type === "scale" && JSON.stringify(question.scale) === JSON.stringify(scale));
      const scaleId = `${listId}-group-${sectionIndex}-scale`;
      const content = section.questions.map((question) => <ExperimentQuestionCard
        answer={answers[question.id]}
        compact={compact}
        sharedScale={sharedScale}
        descriptionId={[instruction ? instructionId : undefined, group?.referenceNote ? referenceNoteId : undefined, sharedScale ? scaleId : undefined].filter(Boolean).join(" ") || undefined}
        grouped={Boolean(group)}
        id={questionIdPrefix ? `${questionIdPrefix}-${question.id}` : undefined}
        index={startIndex + ordered.findIndex((item) => item.id === question.id)}
        inputName={`${inputNamePrefix}-${question.id}`}
        invalid={invalidQuestionId === question.id}
        key={question.id}
        onAnswerChange={(next) => onAnswerChange(question.id, next)}
        question={question}
        readOnly={readOnly}
      />);
      if (!group) return <div key={`question-${section.questions[0].id}`}>{content}</div>;
      return <section aria-labelledby={titleId} className={compact ? styles.questionGroup : "overflow-hidden rounded-[14px] border border-[var(--pbl-student-border)] bg-white"} key={`group-${group.id}`}>
        <div className={compact ? styles.groupHeader : "border-b border-[var(--pbl-student-border)] bg-[var(--pbl-student-soft)] px-4 py-5 sm:px-6"}>
          {!compact ? <p className="text-xs font-semibold tracking-wider text-[var(--pbl-student)]">题组 · {section.questions.length} 题</p> : null}
          <h3 className={compact ? styles.groupTitle : "mt-1.5 whitespace-pre-wrap text-lg font-bold leading-7 text-[var(--pbl-text-strong)] [overflow-wrap:anywhere]"} id={titleId}>{group.title || "未填写题组标题"}</h3>
          {instruction ? <div className={compact ? styles.instruction : "mt-3 space-y-2 text-sm leading-7 text-[var(--pbl-text)]"} id={instructionId}>
            {promptParagraphs(instruction).map((paragraph, index) => <p className="whitespace-pre-wrap [overflow-wrap:anywhere]" key={index}>{paragraph}</p>)}
          </div> : null}
          {group.referenceNote ? <ReferenceNote compact={compact} id={referenceNoteId} note={group.referenceNote} onReadReference={onReadReference} /> : null}
          {sharedScale && scale ? <div className={styles.scaleGuide}><span className={styles.scaleGuideHint}>每行选择一个分值</span><ScaleScoreGuide id={scaleId} scale={scale} /></div> : null}
        </div>
        <div>{content}</div>
      </section>;
    })}
  </div>;
}
