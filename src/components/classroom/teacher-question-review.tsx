"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Check, ChevronLeft, ChevronRight, Eye, EyeOff, List, X } from "lucide-react";
import type { Course } from "@/lib/session/types";
import type { QuizQuestion } from "@openmaic/lib/types/stage";
import { useKnowledgeReviewResources } from "@/hooks/use-knowledge-review-resources";
import { renderQuizMathText } from "@/lib/openmaic/quiz/math-text";
import {
  buildTeacherQuestionReview, questionAnswerNeedsReview, reviewAnswerDistribution, reviewAnswerText, reviewAnswerValues,
  teacherQuestionSourceInput, verifyTeacherQuestionSource,
  type QuestionSourceResolution, type TeacherQuestionReviewRow,
} from "@/lib/classroom/teacher-question-review";
import styles from "./teacher-question-review.module.css";

type Filter = { range: "wrong" | "all"; sectionId: string; pointId: string };
type QuestionSelection = { id: string; revealed: boolean; answersOpen: boolean };
const EMPTY_SELECTION: QuestionSelection = { id: "", revealed: false, answersOpen: false };
const INITIAL_FILTER: Filter = { range: "wrong", sectionId: "", pointId: "" };
const SOURCE_NOTICES: Record<Exclude<QuestionSourceResolution["status"], "verified">, string> = {
  "missing-fingerprint": "历史作答未保存原题版本，无法核验标准答案。以下仅显示当时保存的参考说明与解析。",
  "missing-source": "未找到这份作答对应的原题，无法核验标准答案。以下保留当时保存的参考说明与解析。",
  mismatch: "原题或采用的资料已更新，当前标准答案与这份作答版本不一致。以下保留当时保存的参考说明与解析。",
  unavailable: "暂时无法核验原题版本。以下仅显示当时保存的参考说明与解析。",
};
const TYPE_LABELS: Record<string, string> = {
  single: "单选题", single_choice: "单选题", multiple: "多选题", multiple_choice: "多选题", true_false: "判断题",
  matching: "匹配题", fill_blank: "填空题", short_answer: "简答题", scenario_task: "情境题",
};

function QuestionText({ text }: { text: string }) {
  const segments = useMemo(() => renderQuizMathText(text), [text]);
  return <span className={styles.text}>{segments.map((segment, index) => segment.type === "text"
    ? <span key={index}>{segment.value}</span>
    : <span className={segment.displayMode ? styles.displayMath : styles.inlineMath} key={index} dangerouslySetInnerHTML={{ __html: segment.html }} />)}</span>;
}

function matches(row: TeacherQuestionReviewRow, filter: Filter) {
  return (filter.range === "all" || row.incorrectCount > 0) && (!filter.sectionId || row.sectionId === filter.sectionId)
    && (!filter.pointId || row.knowledgePointIds.includes(filter.pointId));
}

function questionSelectorLabel(row: TeacherQuestionReviewRow) {
  const characters = Array.from(row.snapshot.prompt.replace(/\s+/g, " ").trim());
  const excerpt = characters.slice(0, 12).join("") + (characters.length > 12 ? "…" : "");
  const historical = row.sourceStatus && row.sourceStatus !== "current" && row.sourceStatus !== "verified";
  return `第 ${row.questionNumber} 题 · ${excerpt}${historical ? "（历史版本）" : ""}`;
}

export function TeacherQuestionReview(props: { course: Course; active: boolean; onBack: () => void }) {
  return <StandaloneQuestionReview key={`${props.course.id}:${props.course.aiLearningClassroomId ?? props.course.content._openmaicClassroomId}`} {...props} />;
}

type QuestionReviewResources = ReturnType<typeof useKnowledgeReviewResources>;
export type TeacherQuestionReviewScope = { pointId?: string; sectionId?: string };
type TeacherQuestionReviewContentProps = {
  course: Course;
  active: boolean;
  resources: QuestionReviewResources;
  rows?: TeacherQuestionReviewRow[];
  scope?: TeacherQuestionReviewScope;
  focus?: { sequence: number; questionId: string };
  onKnowledgePoint?: (pointId: string) => void;
  onCourseware?: (knowledgePointIds: string[]) => void;
  onQuestionChange?: (questionId: string) => void;
  simplified?: boolean;
};

/** Embedded question content shares the classroom resource request with the review container. */
export function TeacherQuestionReviewContent(props: TeacherQuestionReviewContentProps) {
  return <QuestionReviewContent {...props} embedded />;
}

function StandaloneQuestionReview(props: { course: Course; active: boolean; onBack: () => void }) {
  const [visited, setVisited] = useState(props.active);
  if (props.active && !visited) setVisited(true);
  const classroomId = props.course.aiLearningClassroomId || props.course.content._openmaicClassroomId;
  const resources = useKnowledgeReviewResources(classroomId, visited);
  return <QuestionReviewContent {...props} resources={resources} />;
}

function QuestionReviewContent({ course, active, resources, rows, scope, focus, onKnowledgePoint, onCourseware, onQuestionChange, onBack, embedded = false, simplified = false }: TeacherQuestionReviewContentProps & { onBack?: () => void; embedded?: boolean }) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  const data = useMemo(() => buildTeacherQuestionReview(course), [course]);
  const reviewRows = rows ?? data.rows;
  const [localFilter, setFilter] = useState<Filter>(INITIAL_FILTER);
  const filter = embedded ? { ...localFilter, sectionId: scope?.sectionId ?? "", pointId: scope?.pointId ?? "" } : localFilter;
  const scopeKey = embedded ? JSON.stringify([filter.sectionId, filter.pointId]) : "standalone";
  const [selections, setSelections] = useState<Record<string, QuestionSelection>>({});
  const selection = selections[scopeKey] ?? EMPTY_SELECTION;
  function setSelection(value: QuestionSelection | ((current: QuestionSelection) => QuestionSelection)) {
    setSelections((current) => ({ ...current, [scopeKey]: typeof value === "function" ? value(current[scopeKey] ?? EMPTY_SELECTION) : value }));
  }
  const [appliedFocus, setAppliedFocus] = useState<string>();
  const focusKey = focus ? JSON.stringify([focus.sequence, focus.questionId]) : undefined;
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const directoryButton = useRef<HTMLButtonElement>(null);
  const reviewRoot = useRef<HTMLElement>(null);
  const questionContext = useRef<HTMLDivElement>(null);
  const filteredRows = reviewRows.filter((row) => matches(row, filter));
  const scopedRows = reviewRows.filter((row) => matches(row, { ...filter, range: "all" }));
  const wrongRows = scopedRows.filter((row) => row.incorrectCount > 0);
  const preferredRows = simplified ? wrongRows.length ? wrongRows : scopedRows : filteredRows;
  const focusedRow = focus && focusKey !== appliedFocus ? scopedRows.find((row) => row.id === focus.questionId) : undefined;
  // Once selected, live grading cannot silently replace the question being explained.
  const selected = simplified && !visited && !active ? undefined : focusedRow ?? scopedRows.find((row) => row.id === selection.id) ?? preferredRows[0];
  if (focusedRow && selected) setAppliedFocus(focusKey);
  if (selected && selected.id !== selection.id) setSelection({ id: selected.id, revealed: false, answersOpen: false });
  const notifiedSelection = useRef<{ active: boolean; id?: string }>({ active: false });
  useEffect(() => {
    const previous = notifiedSelection.current;
    notifiedSelection.current = { active, id: selected?.id };
    if (active && selected?.id && (!previous.active || previous.id !== selected.id)) onQuestionChange?.(selected.id);
  }, [active, selected?.id, onQuestionChange]);
  const navigationRows = simplified ? scopedRows : reviewRows.filter((row) => matches(row, filter) || row.id === selected?.id);
  const selectorRows = simplified ? scopedRows : navigationRows;
  const positionRows = simplified ? scopedRows : navigationRows;
  const index = positionRows.findIndex((row) => row.id === selected?.id);
  const previous = navigationRows.filter((row) => positionRows.indexOf(row) < index).at(-1);
  const next = navigationRows.find((row) => positionRows.indexOf(row) > index);
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  const resourcesReady = resources.ready || !classroomId;
  const sourceInput = selected ? teacherQuestionSourceInput(selected, course.content, resources.scenes) : undefined;
  const fingerprint = selected?.snapshot.authoredQuestionFingerprint;
  const verificationScope = JSON.stringify([selected?.id, sourceInput, fingerprint]);
  const [verification, setVerification] = useState<{ scope: string; value: QuestionSourceResolution }>();
  useEffect(() => {
    if (!visited || !resourcesReady || selected?.sourceStatus) return;
    let current = true;
    void verifyTeacherQuestionSource(sourceInput, fingerprint).then((value) => {
      if (current) setVerification({ scope: verificationScope, value });
    });
    return () => { current = false; };
  }, [visited, resourcesReady, sourceInput, fingerprint, verificationScope, selected?.sourceStatus]);
  const resolution = selected?.sourceStatus && selected.sourceStatus !== "current" && selected.sourceStatus !== "verified"
    ? { status: selected.sourceStatus } : verification?.scope === verificationScope ? verification.value : undefined;
  const source = selected?.authoredSource ?? (resolution?.status === "verified" ? resolution.question : undefined);
  const historical = Boolean(selected?.sourceStatus && selected.sourceStatus !== "current" && selected.sourceStatus !== "verified");
  const revealed = selection.id === selected?.id && selection.revealed;

  function choose(row: TeacherQuestionReviewRow | undefined) {
    setSelection({ id: row?.id ?? "", revealed: false, answersOpen: false });
    setDirectoryOpen(false);
    if (row) window.requestAnimationFrame(() => {
      const context = simplified ? reviewRoot.current : questionContext.current;
      if (context && !context.closest("[hidden]")) context.scrollIntoView?.({ block: "start" });
    });
  }
  function changeFilter(next: Filter, close = false) {
    setFilter(next);
    const first = reviewRows.find((row) => matches(row, next));
    setSelection({ id: first?.id ?? "", revealed: false, answersOpen: false });
    if (close) setDirectoryOpen(false);
  }

  return <section ref={reviewRoot} className={`${styles.root}${embedded ? ` ${styles.embedded}` : ""}${simplified ? ` ${styles.simplified}` : ""}`} aria-label="题目讲解" hidden={!active}>
    {!simplified || selectorRows.length > 1 || Boolean(selected && onCourseware) ? <header className={styles.header}>
      {!embedded ? <div className={styles.titleRow}><button className={styles.back} type="button" onClick={onBack}><ChevronLeft size={20} />返回班级学情</button><h2>题目讲解</h2></div> : null}
      <div className={styles.toolbar}>
        {!simplified ? <div className={styles.tabs} role="group" aria-label="讲解题目范围">
          <button type="button" aria-pressed={filter.range === "wrong"} onClick={() => changeFilter({ ...filter, range: "wrong" })}>错题 <span>{scopedRows.filter((row) => row.incorrectCount > 0).length}</span></button>
          <button type="button" aria-pressed={filter.range === "all"} onClick={() => changeFilter({ ...filter, range: "all" })}>全部题目 <span>{scopedRows.length}</span></button>
        </div> : null}
        {embedded && (!simplified || selectorRows.length > 1) ? <label className={styles.inlineSelector}>选择题目
          <select aria-label="选择讲解题目" value={selected?.id ?? ""} disabled={!selectorRows.length} onChange={(event) => choose(selectorRows.find((row) => row.id === event.target.value))}>
            {!selectorRows.length ? <option value="">暂无题目</option> : selectorRows.map((row) => <option key={row.id} value={row.id}>{simplified ? "" : `${row.sectionTitle} · `}{questionSelectorLabel(row)}</option>)}
          </select>
        </label> : !embedded ? <button ref={directoryButton} type="button" onClick={() => setDirectoryOpen(true)}><List size={20} />选择题目</button> : null}
        {simplified && selected && onCourseware ? <button className={styles.relatedCourseware} type="button" onClick={() => onCourseware([...selected.knowledgePointIds])}>查看相关课件</button> : null}
      </div>
    </header> : null}
    {!embedded && (filter.sectionId || filter.pointId) ? <div className={styles.filterNotice}>
      <span>当前范围：{data.sections.find((section) => section.id === filter.sectionId)?.title}{filter.sectionId && filter.pointId ? " · " : ""}{data.mastery.find((point) => point.knowledgePointId === filter.pointId)?.name}</span>
      <button type="button" onClick={() => changeFilter({ ...filter, sectionId: "", pointId: "" })}>清除筛选</button>
    </div> : null}
    {selected ? <>
      {!simplified ? <div ref={questionContext} className={styles.questionContext}><span>{selected.sectionTitle} · 第 {selected.questionNumber} 题</span><span>{TYPE_LABELS[selected.snapshot.questionFormat ?? selected.snapshot.questionType ?? ""] ?? "课堂小测"}</span></div> : null}
      {simplified ? <div className={styles.summary} aria-label="本题作答情况">
        <span>第 {selected.questionNumber} 题 · {TYPE_LABELS[selected.snapshot.questionFormat ?? selected.snapshot.questionType ?? ""] ?? "课堂小测"}</span>
        {!selected.submittedCount ? <span>未作答</span> : null}
        {historical ? <span>历史作答版本</span> : null}
        <span>已提交 {selected.submittedCount} 人</span>
        {selected.gradedCount ? <><span>{selected.objective ? "答错" : "未达标"} {selected.incorrectCount}/{selected.gradedCount} 人</span><span>{selected.objective ? "正确率" : "平均得分率"} {(selected.objective ? selected.accuracy : selected.scoreRate) === undefined ? "—" : `${selected.objective ? selected.accuracy : selected.scoreRate}%`}</span></> : <span>暂无有效评分</span>}
        {selected.pendingCount ? <span>待评 {selected.pendingCount} 人</span> : null}{selected.failedCount ? <span>评分失败 {selected.failedCount} 人</span> : null}{selected.unverifiedCount ? <span>待核验 {selected.unverifiedCount} 人</span> : null}
      </div> : null}
      {historical && resolution ? <p role="status" className={styles.notice}>{SOURCE_NOTICES[resolution.status as Exclude<QuestionSourceResolution["status"], "verified">]}</p> : null}
      <div className={styles.content}>
        <div className={styles.question}>
          <h3><QuestionText text={selected.snapshot.prompt} /></h3>
          {selected.snapshot.options?.length ? <OptionDistribution row={selected} source={source} revealed={revealed} /> : selected.snapshot.matchingOptions ? <MatchingQuestion row={selected} source={source} /> : null}
          {selected.knowledgePointNames.length ? <div className={styles.knowledgePoints}>知识点：{selected.knowledgePointIds.map((pointId, pointIndex) => onKnowledgePoint
            ? <button type="button" key={pointId} onClick={() => onKnowledgePoint(pointId)} aria-label={`${simplified ? "补讲知识点" : "查看知识点课件"}：${selected.knowledgePointNames[pointIndex]}`}>{selected.knowledgePointNames[pointIndex]}</button>
            : <span key={pointId}>{pointIndex ? " · " : ""}{selected.knowledgePointNames[pointIndex]}</span>)}</div> : null}
          <section className={styles.explanation} aria-label="答案与解析">
            <button className={styles.reveal} aria-expanded={revealed} type="button" onClick={() => setSelection((value) => ({ ...value, revealed: !value.revealed }))}>
              {revealed ? <EyeOff size={21} /> : <Eye size={21} />}{revealed ? "隐藏答案与解析" : "显示答案与解析"}
            </button>
            {revealed ? <div className={styles.explanationBody}>
              {source ? <VerifiedExplanation question={source} /> : <>
                {!historical ? <p role="status" className={styles.notice}>{resources.error ? "原题加载失败，暂时无法核验标准答案。以下保留当时保存的参考说明与解析。" : resolution ? SOURCE_NOTICES[resolution.status as Exclude<QuestionSourceResolution["status"], "verified">] : !fingerprint ? SOURCE_NOTICES["missing-fingerprint"] : "正在核验原题版本；当时保存的参考说明与解析仍可查看。"}</p> : null}
                {resources.error ? <button type="button" onClick={resources.retry}>重试加载原题</button> : null}
                {selected.snapshot.referenceAnswer ? <div><h4>原记录参考说明</h4><QuestionText text={selected.snapshot.referenceAnswer} /></div> : null}
                {selected.snapshot.authoredAnalysis && selected.snapshot.authoredAnalysis !== selected.snapshot.referenceAnswer ? <div><h4>原题解析</h4><QuestionText text={selected.snapshot.authoredAnalysis} /></div> : null}
                {!selected.snapshot.referenceAnswer && !selected.snapshot.authoredAnalysis ? <p>这份作答记录未保存参考答案或原题解析。</p> : null}
              </>}
            </div> : null}
          </section>
          {simplified ? <>{selected.gradedCount > 0 && !selected.snapshot.options?.length ? <AnswerDistribution row={selected} source={source} compact /> : null}
            <SubmittedAnswers row={selected} source={source} revealed={revealed} open={selection.answersOpen} onToggle={() => setSelection((value) => ({ ...value, answersOpen: !value.answersOpen }))} />
          </> : null}
        </div>
        {!simplified ? <aside className={styles.statistics} aria-label="本题作答情况">
          <h3>本题作答情况</h3>
          <dl className={styles.metrics}>
            <div><dt>{selected.objective ? "答错人数" : "未达标人数"}</dt><dd className={styles.attention}>{selected.incorrectCount}<small> / {selected.gradedCount}</small></dd></div>
            <div><dt>{selected.objective ? "正确率" : "平均得分率"}</dt><dd>{(selected.objective ? selected.accuracy : selected.scoreRate) === undefined ? "—" : `${selected.objective ? selected.accuracy : selected.scoreRate}%`}</dd></div>
          </dl>
          <p className={styles.caption}>本题已提交 {selected.submittedCount} 人 · 已评分 {selected.gradedCount} 人</p>
          <p className={styles.caption}>{selected.objective ? "仅统计本场首次作答的有效服务端评分。" : "未达标指得分低于本题满分的 80%；仅统计本场首次作答的有效服务端评分。"}</p>
          {selected.pendingCount || selected.failedCount || selected.unverifiedCount ? <p className={styles.notice}>{[
            selected.pendingCount ? `待评 ${selected.pendingCount} 人` : "", selected.failedCount ? `评分失败 ${selected.failedCount} 人` : "", selected.unverifiedCount ? `待核验 ${selected.unverifiedCount} 人` : "",
          ].filter(Boolean).join(" · ")}，不计入错误人数。</p> : null}
          {!selected.gradedCount ? <p className={styles.empty}>本题暂无有效评分。</p> : selected.snapshot.options?.length ? <p className={styles.caption}>选项旁显示已评分作答的选择人数。{selected.snapshot.questionType === "multiple" ? "多选题可同时选择多项，各项占比之和可能超过 100%。" : ""}</p> : <AnswerDistribution row={selected} source={source} />}
          <SubmittedAnswers row={selected} source={source} revealed={revealed} open={selection.answersOpen} onToggle={() => setSelection((value) => ({ ...value, answersOpen: !value.answersOpen }))} />
        </aside> : null}
      </div>
      <nav className={styles.navigation} aria-label="讲解题目翻页">
        <button type="button" disabled={!previous} onClick={() => choose(previous)}><ChevronLeft size={20} />上一题</button>
        <span role="status" aria-live="polite" aria-atomic="true" aria-label={`第 ${index + 1} 题，共 ${positionRows.length} 题`}>{index + 1} / {positionRows.length}</span>
        <button type="button" disabled={!next} onClick={() => choose(next)}>下一题<ChevronRight size={20} /></button>
      </nav>
    </> : <div className={styles.empty}>
      <h3>{simplified ? rows ? "当前章节暂无题目" : "当前章节暂无作答题目" : reviewRows.length ? filter.range === "wrong" ? "当前范围暂无错题" : "当前范围暂无作答题目" : "暂无作答题目"}</h3>
      <p>{simplified ? rows ? "当前范围没有可查看的原题或作答记录，可以在目录中选择其他章节。" : "学生提交本章小测后，可在这里查看题目与作答。" : reviewRows.length ? filter.range === "wrong" ? "错题包含客观题答错，以及主观题未达 80% 的有效评分。待评、评分失败与未核验作答不算错题。" : embedded ? "当前章节或知识点尚无已提交题目，可以在左侧选择其他范围。" : "可以清除筛选，查看其他小节或知识点的作答题目。" : "学生提交小测后，可在这里逐题查看首次作答与原题讲解。"}</p>
      {!simplified && (embedded ? scopedRows.length && filter.range === "wrong" : data.rows.length) ? <button type="button" onClick={() => changeFilter(embedded ? { ...filter, range: "all" } : { range: "all", sectionId: "", pointId: "" })}>查看全部作答题目</button> : null}
    </div>}

    {!embedded ? <Dialog.Root open={active && directoryOpen} onOpenChange={setDirectoryOpen}>
      <Dialog.Portal container={typeof document !== "undefined" ? document.fullscreenElement : undefined}>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.directory} onCloseAutoFocus={(event) => { event.preventDefault(); directoryButton.current?.focus({ preventScroll: true }); }}>
          <header className={styles.directoryHeader}><div><Dialog.Title>选择讲解题目</Dialog.Title><Dialog.Description>按知识点或小节定位已提交的题目，再逐题讲解。</Dialog.Description></div><Dialog.Close aria-label="关闭题目目录"><X size={24} /></Dialog.Close></header>
          <div className={styles.directoryContent}>
            <div className={styles.directoryFilters}>
              <details><summary>知识点未达标率排名</summary><p className={styles.caption}>未达 80% 人数 ÷ 有效作答人数</p>
                {data.mastery.filter((point) => point.answeredStudents).map((point) => <button type="button" key={point.knowledgePointId} aria-pressed={filter.pointId === point.knowledgePointId}
                  onClick={() => changeFilter({ ...filter, sectionId: "", pointId: filter.pointId === point.knowledgePointId ? "" : point.knowledgePointId })}>
                  <span>{point.name}<small>{point.incorrectStudents}/{point.answeredStudents} 人未达标</small></span><strong>{point.unmetRate}%</strong>
                </button>)}
                {!data.mastery.some((point) => point.answeredStudents) ? <p className={styles.caption}>暂无有效知识点评分。</p> : null}
              </details>
              <details open><summary>各小节测验情况</summary><button type="button" aria-pressed={!filter.sectionId} onClick={() => changeFilter({ ...filter, sectionId: "" })}>全部小节</button>
                {data.sections.map((section) => <button type="button" key={section.id} aria-pressed={filter.sectionId === section.id} onClick={() => changeFilter({ ...filter, sectionId: section.id, pointId: "" })}>
                  <span>{section.title}<small>已提交 {section.submittedCount}/{data.studentCount} 人 · 完成率 {data.studentCount ? Math.round(section.submittedCount / data.studentCount * 100) : 0}%</small></span>
                  <strong>{section.averageScore === undefined ? "待评分" : `均分 ${section.averageScore}${section.maxScore === undefined ? "" : `/${section.maxScore}`} 分`}</strong>
                </button>)}
              </details>
            </div>
            <nav className={styles.questionList} aria-label="讲解题目目录">
              <h3>{filter.range === "wrong" ? "错题与未达标题目" : "全部已提交题目"} · {filteredRows.length} 题</h3>
              {filteredRows.map((row) => <button type="button" key={row.id} aria-current={selected?.id === row.id ? "true" : undefined} onClick={() => choose(row)}>
                <span className={styles.listContext}>{row.sectionTitle} · 第 {row.questionNumber} 题</span><strong><QuestionText text={row.snapshot.prompt} /></strong>
                <span>{row.gradedCount ? `${row.incorrectCount}/${row.gradedCount} 人${row.objective ? "答错" : "未达标"}` : "暂无有效评分"}{data.rows.some((other) => other.id !== row.id && other.quizOutlineId === row.quizOutlineId && other.snapshot.questionId === row.snapshot.questionId) ? " · 独立题目版本" : ""}</span>
              </button>)}
              {!filteredRows.length ? <p className={styles.empty}>当前筛选下暂无作答题目。</p> : null}
            </nav>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root> : null}
  </section>;
}

function SubmittedAnswers({ row, source, revealed, open, onToggle }: { row: TeacherQuestionReviewRow; source?: QuizQuestion; revealed: boolean; open: boolean; onToggle: () => void }) {
  if (!row.answers.length) return null;
  return <>
    <button className={styles.answerToggle} type="button" aria-expanded={open} onClick={onToggle}>{open ? "收起原始作答" : "查看原始作答"}</button>
    {open ? <div className={styles.answers} aria-label="本题原始作答">{row.answers.map((answer, answerIndex) => <article key={answer.studentId}>
      <div><strong>作答 {answerIndex + 1}</strong><span>{answer.status === "graded" ? `${answer.question.earned}/${answer.question.points} 分` : answer.status === "pending" ? "待评" : answer.status === "failed" ? "评分失败" : "待核验"}</span></div>
      <p><QuestionText text={reviewAnswerText(answer.question, source)} /></p>
      {revealed && answer.question.feedback ? <p className={styles.feedback}><strong>评阅反馈：</strong><QuestionText text={answer.question.feedback} /></p> : null}
      {answer.status === "graded" && questionAnswerNeedsReview(answer.question) ? <small>{row.objective ? "回答错误" : "未达 80%"}</small> : null}
    </article>)}</div> : null}
  </>;
}

function OptionDistribution({ row, source, revealed }: { row: TeacherQuestionReviewRow; source?: QuizQuestion; revealed: boolean }) {
  const options = row.snapshot.options!;
  const values = row.answers.filter((answer) => answer.status === "graded").map((answer) => reviewAnswerValues(answer.question));
  const unmatchedCount = values.filter((answer) => answer.some((value) => !options.some((option) => option.value === value))).length;
  const blankCount = values.filter((answer) => !answer.length).length;
  return <><ul className={styles.options} aria-label="原题选项与作答分布">{options.map((option) => {
    const count = values.filter((answer) => answer.includes(option.value)).length;
    const percent = row.gradedCount ? Math.round(count / row.gradedCount * 100) : 0;
    const correct = revealed && source?.answer?.includes(option.value);
    return <li key={option.value} data-correct={correct || undefined}>
      <div className={styles.optionText}><span className={styles.optionKey}>{option.value}</span><QuestionText text={option.label} />{correct ? <span className={styles.correct}><Check size={18} />正确选项</span> : null}</div>
      <div className={styles.optionStats}><span className={styles.track} aria-hidden="true"><i style={{ width: `${percent}%` }} /></span><span>{count} 人 · {percent}%</span></div>
    </li>;
  })}</ul>
    {unmatchedCount ? <p className={styles.notice}>{unmatchedCount} 份已评分记录含无法匹配原选项的提交值，这些值未计入选项人数。可查看原始作答。</p> : null}
    {blankCount ? <p className={styles.caption}>另有 {blankCount} 份已评分的空白作答。</p> : null}
  </>;
}

function MatchingQuestion({ row, source }: { row: TeacherQuestionReviewRow; source?: QuizQuestion }) {
  const left = source?.matchingPairs?.map((pair) => pair.left) ?? row.snapshot.matchingOptions!.left;
  const originalRight = source?.matchingPairs?.map((pair) => pair.right) ?? row.snapshot.matchingOptions!.right;
  // The authoring arrays are aligned pairs. Never reveal that alignment before the teacher asks.
  const right = originalRight.length > 1 ? [...originalRight.slice(1), originalRight[0]] : originalRight;
  return <div className={styles.matching} aria-label="原题匹配项"><div><h4>左侧项目</h4><ul>{left.map((text, index) => <li key={index}><QuestionText text={text} /></li>)}</ul></div><div><h4>右侧候选</h4><ul>{right.map((text, index) => <li key={index}><QuestionText text={text} /></li>)}</ul></div></div>;
}

function AnswerDistribution({ row, source, compact = false }: { row: TeacherQuestionReviewRow; source?: QuizQuestion; compact?: boolean }) {
  const distribution = reviewAnswerDistribution(row, source);
  return <section className={styles.distribution} aria-label="已评分作答分布"><h4>{row.snapshot.questionType === "matching" ? "匹配作答分布" : "原回答分布"}</h4>
    {row.snapshot.questionType === "matching" && !source ? <p className={styles.caption}>原记录未保存匹配项标识；核验原题后可显示关系文字，当前保留原提交值。</p> : null}
    <ol>{distribution.slice(0, 5).map((item) => <li key={item.label}><p><QuestionText text={item.label} /></p><strong>{item.count} 人</strong></li>)}</ol>
    {!compact ? <p className={styles.caption}>按完全相同的已评分回答计数{distribution.length > 5 ? `，显示前 5 项，共 ${distribution.length} 项` : ""}。可查看全部原始作答。</p> : null}
  </section>;
}

function VerifiedExplanation({ question }: { question: QuizQuestion }) {
  const answers = question.type === "matching" ? (question.answer ?? []).map((value) => {
    const separator = value.indexOf(":");
    const left = question.matchingPairs?.find((pair) => pair.leftId === value.slice(0, separator));
    const right = question.matchingPairs?.find((pair) => pair.rightId === value.slice(separator + 1));
    return left && right ? `${left.left} → ${right.right}` : value;
  }) : (question.answer ?? []).map((value) => {
    const option = question.options?.find((item) => item.value === value);
    return option ? `${value}. ${option.label}` : value;
  });
  const answerText = question.type === "short_answer" ? question.referenceAnswer : answers.join("\n") || question.referenceAnswer;
  return <>
    <div><h4>{question.type === "short_answer" ? "参考答案" : "正确答案"}</h4>{answerText ? <QuestionText text={answerText} /> : <p>原题未提供参考答案。</p>}</div>
    {question.analysis ? <div><h4>题目解析</h4><QuestionText text={question.analysis} /></div> : <p className={styles.caption}>原题未提供文字解析。</p>}
  </>;
}
