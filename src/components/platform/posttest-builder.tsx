"use client";

import { useId, useState } from "react";
import { ExperimentQuestionBuilder, prepareExperiment } from "./experiment-question-builder";
import { ExperimentQuestionList, type ExperimentDisplayAnswer } from "./experiment-question-card";
import { groupExperimentQuestions, publicExperimentQuestions, type ExperimentConfig } from "@/lib/platform/experiment";
import { COTEACH_POSTTEST_TEMPLATE, createCoTeachPostTestTemplate, type PostTestConfig } from "@/lib/platform/posttest";

function experimentDraft(value: PostTestConfig): ExperimentConfig {
  return { enabled: true, sharedQuestions: [], pretest: [], posttest: value.questions, randomizeQuestionOrder: false, randomizeOptionOrder: false };
}

export function preparePostTest(value: PostTestConfig): PostTestConfig {
  return { ...value, content: value.content.trim(), questions: groupExperimentQuestions(prepareExperiment(experimentDraft(value)).posttest).flatMap((section) => section.questions) };
}

export function PostTestBuilder({ value, onChange }: { value: PostTestConfig; onChange: (next: PostTestConfig) => void }) {
  const [preview, setPreview] = useState(false);
  const [beforeTemplate, setBeforeTemplate] = useState<PostTestConfig | null>(null);
  const [answers, setAnswers] = useState<Record<string, ExperimentDisplayAnswer>>({});
  const previewId = useId();
  const button = "inline-flex min-h-11 items-center justify-center rounded-lg border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-4 text-sm font-semibold";
  return <div className="min-w-0 space-y-4 [&_button]:min-h-11 [&_fieldset]:min-w-0 [&_input]:min-w-0 [&_select]:min-h-11 [&_textarea]:min-w-0">
    <section aria-label="后测模板" className="space-y-3 rounded-lg border border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] p-4">
      <h3 className="text-base font-semibold">{COTEACH_POSTTEST_TEMPLATE.title}</h3>
      <p className="text-sm leading-6">{COTEACH_POSTTEST_TEMPLATE.description}</p>
      <p className="text-xs leading-5 text-[var(--pbl-text-muted)]">知识题未预设答案键。可以直接记录作答，或补充参考答案后自动计分。应用会替换当前后测草稿，保存前可撤销。</p>
      <div className="flex flex-wrap gap-2">
        <button className={button} onClick={() => { setBeforeTemplate(value); onChange(createCoTeachPostTestTemplate()); setAnswers({}); }} type="button">应用 CoTeach 后测模板</button>
        {beforeTemplate ? <button className={button} onClick={() => { onChange(beforeTemplate); setBeforeTemplate(null); setAnswers({}); }} type="button">撤销应用模板</button> : null}
      </div>
    </section>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm">共 {value.questions.length} 题 · {value.questions.filter((question) => !question.optional).length} 题必答</p>
      <button aria-pressed={preview} className={button} onClick={() => setPreview(!preview)} type="button">{preview ? "继续编辑题目" : "预览学生题目"}</button>
    </div>
    {preview ? <section aria-label="后测题目预览" className="space-y-4">
      <p className="text-xs text-[var(--pbl-text-muted)]">可以试选和填写答案；预览中的作答不会保存或提交。</p>
      <ExperimentQuestionList answers={answers} inputNamePrefix={previewId} onAnswerChange={(id, answer) => setAnswers((current) => ({ ...current, [id]: answer }))} questions={publicExperimentQuestions(value.questions)} />
    </section> : <ExperimentQuestionBuilder onChange={(next) => onChange({ ...value, questions: next.posttest })} standalone value={experimentDraft(value)} />}
    <label className="block space-y-2 text-sm"><span>建议时长（分钟，可选）</span><input aria-label="后测建议时长" className="min-h-11 w-28 rounded-lg border border-[var(--pbl-border)] px-3" max={120} min={1} onChange={(event) => onChange({ ...value, minutes: event.target.value ? Number(event.target.value) : undefined })} type="number" value={value.minutes ?? ""} /></label>
    {value.questions.some((question) => question.skipReasonRequired) ? <label className="block space-y-2 text-sm"><span>跳题原因提示</span><input aria-label="后测跳题原因提示" className="min-h-11 w-full rounded-lg border border-[var(--pbl-border)] px-3" maxLength={300} onChange={(event) => onChange({ ...value, skipReasonPrompt: event.target.value })} value={value.skipReasonPrompt ?? ""} /></label> : null}
  </div>;
}
