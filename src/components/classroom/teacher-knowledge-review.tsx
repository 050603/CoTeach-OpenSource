"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, Popover } from "radix-ui";
import { ChevronLeft, ChevronRight, BookOpen, CircleAlert, FileQuestion, MonitorUp, Presentation, RefreshCw, Settings2, Square, X } from "lucide-react";
import { OpenMaicResourcePlayer } from "@/components/openmaic-bridge/openmaic-resource-player";
import { useKnowledgeReviewResources } from "@/hooks/use-knowledge-review-resources";
import { useKnowledgeReviewProjection } from "@/hooks/use-knowledge-review-projection";
import { findTeachingScene, initialKnowledgeReviewOrder, knowledgeReviewDetail, masteryStatusLabel, teachingOutlines } from "@/lib/classroom/knowledge-review";
import { buildTeacherQuestionCatalog, buildTeacherQuestionReview, type TeacherQuestionReviewRow } from "@/lib/classroom/teacher-question-review";
import { classroomReviewChapters, initialClassroomReviewChapter } from "@/lib/classroom/classroom-review";
import { TeacherQuestionReviewContent } from "./teacher-question-review";
import type { Course, OpenMaicSceneOutlineSnapshot } from "@/lib/session/types";
import styles from "./teacher-knowledge-review.module.css";

type BrowseMode = "knowledge" | "chapters";
type ContentMode = "overview" | "questions" | "slides";
export type ClassroomReviewFocus = { sequence: number; pointId?: string; content?: "questions" | "slides"; mode?: BrowseMode; chapterId?: string; questionId?: string };
type Resources = ReturnType<typeof useKnowledgeReviewResources>;
type ProjectionControl = ReturnType<typeof useKnowledgeReviewProjection>;

export function TeacherClassroomReview({ course, active, degraded = false, focus }: {
  course: Course; active: boolean; degraded?: boolean; focus?: ClassroomReviewFocus;
}) {
  const review = useMemo(() => buildTeacherQuestionReview(course), [course]);
  const [visited, setVisited] = useState(active);
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  const resources = useKnowledgeReviewResources(classroomId, visited);
  const [catalog, setCatalog] = useState<{ classroomId?: string; value: typeof review; error?: boolean }>();
  useEffect(() => {
    if (!visited || !resources.ready || resources.error) return;
    let current = true;
    void buildTeacherQuestionCatalog(course, resources.scenes).then((value) => {
      if (current) setCatalog({ classroomId, value });
    }).catch(() => { if (current) setCatalog({ classroomId, value: review, error: true }); });
    return () => { current = false; };
  }, [course, classroomId, resources.scenes, resources.ready, resources.error, visited, review]);
  const rows = !resources.error && !catalog?.error && catalog && catalog.classroomId === classroomId ? catalog.value.rows : review.rows;
  const chapters = useMemo(() => classroomReviewChapters(course, { ...review, rows }), [course, review, rows]);
  const initial = initialClassroomReviewChapter(chapters);
  const recommendedOrder = useMemo(() => initialKnowledgeReviewOrder(course), [course]);
  const [pointOrder, setPointOrder] = useState(() => active ? recommendedOrder : []);
  const [pointId, setPointId] = useState(() => active ? recommendedOrder[0] : undefined);
  const [chapterId, setChapterId] = useState(() => active ? initial.id : "");
  const [browseMode, setBrowseMode] = useState<BrowseMode>("knowledge");
  const [contents, setContents] = useState<Record<BrowseMode, ContentMode>>({ knowledge: "overview", chapters: "questions" });
  const content = contents[browseMode];
  const [mobileDetails, setMobileDetails] = useState({ knowledge: false, chapters: false });
  const [relatedPointIds, setRelatedPointIds] = useState<string[]>();
  const [previews, setPreviews] = useState<Record<string, { outlineId: string; all: boolean }>>({});
  const [appliedFocus, setAppliedFocus] = useState<ClassroomReviewFocus>();
  const [questionFocus, setQuestionFocus] = useState<{ sequence: number; questionId: string }>();
  const [chapterFocus, setChapterFocus] = useState<{ sequence: number; questionId: string }>();
  const [chapterQuestionId, setChapterQuestionId] = useState<string>();
  const [chapterReturn, setChapterReturn] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const [beforeSlides, setBeforeSlides] = useState<Record<BrowseMode, ContentMode>>({ knowledge: "overview", chapters: "questions" });
  const [mode, setMode] = useState<"forced" | "optional">("forced");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lectureIds, setLectureIds] = useState<string[]>([]);
  const [projectionOpen, setProjectionOpen] = useState(false);
  if (active && !visited) {
    setVisited(true); setPointOrder(recommendedOrder); setPointId(recommendedOrder[0]); setChapterId(initial.id);
  }
  const focusChapter = focus?.questionId ? chapters.find((chapter) => chapter.questions.some((row) => row.id === focus.questionId)) : undefined;
  if (focus && focus !== appliedFocus && (!focus.questionId || focusChapter)) {
    setAppliedFocus(focus); setProjectionOpen(false);
    if (focus.pointId) {
      if (focus.questionId) setQuestionFocus({ sequence: focus.sequence, questionId: focus.questionId });
      setPointId(focus.pointId); setBrowseMode("knowledge"); setContents((previous) => ({ ...previous, knowledge: focus.questionId ? "questions" : "overview" }));
      setMobileDetails((previous) => ({ ...previous, knowledge: true })); setChapterReturn(false);
    } else if (focus.mode === "chapters" || focus.chapterId || focus.questionId) {
      setBrowseMode("chapters"); setChapterId(focusChapter?.id ?? focus.chapterId ?? initial.id);
      setMobileDetails((previous) => ({ ...previous, chapters: true }));
      if (focus.questionId) setChapterFocus({ sequence: focus.sequence, questionId: focus.questionId });
      setContents((previous) => ({ ...previous, chapters: "questions" }));
    }
  }
  const order = [...pointOrder, ...course.content.knowledgePoints.map((point) => point.id).filter((id) => !pointOrder.includes(id))];
  const points = order.flatMap((id) => review.mastery.find((point) => point.knowledgePointId === id) ?? []);
  const point = points.find((item) => item.knowledgePointId === pointId) ?? points[0];
  const pointDefinition = course.content.knowledgePoints.find((item) => item.id === point?.knowledgePointId);
  const detail = point && knowledgeReviewDetail(course, point, []);
  const teachingDescription = pointDefinition?.description || detail?.pages[0]?.outline.teachingObjective
    || detail?.pages[0]?.outline.description || detail?.pages[0]?.outline.keyPoints?.join("、");
  const teachingItems = [
    { label: "内容", text: teachingDescription },
    { label: "要点", text: pointDefinition?.keyInfo },
    { label: "目标", text: pointDefinition?.masteryBoundary },
  ].filter((item, index, items) => item.text && items.findIndex((other) => other.text === item.text) === index);
  const selected = chapters.find((chapter) => chapter.id === chapterId) ?? initial;
  const outlines = useMemo(() => teachingOutlines(course), [course]);
  const control = useKnowledgeReviewProjection(course, active || Boolean(course.uiState?.teacherResourceProjection));
  const scopePointIds = browseMode === "knowledge" ? point ? [point.knowledgePointId] : [] : relatedPointIds;
  const associatedPages = outlines.filter((outline) => scopePointIds
    ? outline.knowledgePointIds?.some((id) => scopePointIds.includes(id)) : selected.pageIds.includes(outline.id));
  const pageScope = JSON.stringify([browseMode, browseMode === "knowledge" ? point?.knowledgePointId : selected.id, scopePointIds]);
  const preview = previews[pageScope];
  const pages = preview?.all ? outlines : associatedPages;
  const previewOutline = preview ? outlines.find((outline) => outline.id === preview.outlineId) : pages[0];
  const scene = previewOutline && findTeachingScene(resources.scenes, previewOutline);
  const pageIndex = pages.findIndex((outline) => outline.id === previewOutline?.id);
  const isShowingProjection = projectionOpen && Boolean(control.projection && control.projection.classroomId === course.aiLearningClassroomId && resources.scenes.some((item) => item.id === control.projection?.sceneId));
  const pointRows = point ? rows.filter((row) => row.knowledgePointIds.includes(point.knowledgePointId)) : [];
  const directoryIncomplete = Boolean(classroomId && (!resources.ready || resources.error || catalog?.error || !catalog));

  function setContent(next: ContentMode) { setContents((previous) => ({ ...previous, [browseMode]: next })); }
  function selectChapter(id: string) {
    setChapterId(id); setRelatedPointIds(undefined); setContents((previous) => ({ ...previous, chapters: "questions" }));
    setMobileDetails((previous) => ({ ...previous, chapters: true }));
  }
  function selectChapterQuestion(id: string, row: TeacherQuestionReviewRow) {
    selectChapter(id);
    setChapterFocus((previous) => ({ sequence: (previous?.sequence ?? 0) + 1, questionId: row.id }));
    setChapterQuestionId(row.id);
  }
  function selectPoint(id: string, fromChapter = false) {
    setPointId(id); setBrowseMode("knowledge"); setChapterReturn(fromChapter);
    setContents((previous) => ({ ...previous, knowledge: "overview" }));
    setMobileDetails((previous) => ({ ...previous, knowledge: true }));
  }
  function showCourseware(pointIds?: string[]) {
    setBeforeSlides((previous) => ({ ...previous, [browseMode]: content }));
    if (browseMode === "chapters") setRelatedPointIds(pointIds?.length ? [...new Set(pointIds)].sort() : undefined);
    setContent("slides"); setMobileDetails((previous) => ({ ...previous, [browseMode]: true }));
  }
  function choosePage(outline: OpenMaicSceneOutlineSnapshot, all: boolean) {
    if (content !== "slides") setBeforeSlides((previous) => ({ ...previous, [browseMode]: content }));
    setPreviews((previous) => ({ ...previous, [pageScope]: { outlineId: outline.id, all } }));
    setContent("slides"); setDrawerOpen(false); setMobileDetails((previous) => ({ ...previous, [browseMode]: true }));
  }
  function openQuestion(row?: TeacherQuestionReviewRow) {
    if (row) setQuestionFocus((previous) => ({ sequence: (previous?.sequence ?? 0) + 1, questionId: row.id }));
    setContent("questions");
  }
  function startProjection() {
    if (!scene) return;
    setLectureIds(pages.map((outline) => outline.id)); setProjectionOpen(true); control.project(scene, mode);
  }
  const drawerRelatedIds = new Set(associatedPages.map((outline) => outline.id));
  function pageChoice(outline: OpenMaicSceneOutlineSnapshot, all: boolean) {
    return <button type="button" key={outline.id} aria-label={`预览第 ${outlines.indexOf(outline) + 1} 页：${outline.title}`}
      aria-pressed={previewOutline?.id === outline.id} onClick={() => choosePage(outline, all)}>
      <span>第 {outlines.indexOf(outline) + 1} 页</span><strong>{outline.title}</strong>
    </button>;
  }
  return <section className={styles.root} aria-label="课堂讲解" hidden={!active}>
    <nav className={styles.modeTabs} aria-label="课堂讲解方式">
      <button type="button" aria-pressed={browseMode === "knowledge"} onClick={() => { setBrowseMode("knowledge"); setProjectionOpen(false); }}>按知识点补讲</button>
      <button type="button" aria-pressed={browseMode === "chapters"} onClick={() => { setBrowseMode("chapters"); setProjectionOpen(false); }}>按章节查题</button>
    </nav>
    {degraded ? <p className={styles.notice} role="status">数据同步延迟，当前显示最近收到的课堂记录。</p> : null}
    <div className={styles.grid} data-mobile-detail={mobileDetails[browseMode] || (browseMode === "knowledge" && !points.length)} hidden={isShowingProjection}>
      <aside className={styles.sidebar} aria-label="讲解目录">
        <div hidden={browseMode !== "knowledge"} className={styles.directoryPane}>
          <div className={styles.directoryHeader}><p className={styles.directoryHeading}>选择知识点</p><button type="button" aria-label="更新推荐排序" onClick={() => setPointOrder(recommendedOrder)}><RefreshCw size={16} />更新排序</button></div>
          <div className={styles.knowledgeList}>{points.map((item) => <button type="button" key={item.knowledgePointId} aria-label={item.name} title={item.name} aria-pressed={point?.knowledgePointId === item.knowledgePointId} onClick={() => selectPoint(item.knowledgePointId)}>
            <strong>{item.name}</strong><span data-attention={item.status === "confirmed"}>{masteryStatusLabel(item)}</span>
          </button>)}</div>
        </div>
        <div hidden={browseMode !== "chapters"} className={styles.directoryPane}>
          <p className={styles.directoryHeading}>选择章节与题目</p>
          <div className={styles.questionLegend}><span><i data-kind="good" />答对/达标</span><span><i data-kind="wrong" />答错/未达标</span><span><i />未评</span><span>错/已评</span></div>
          <div className={styles.chapterList}>{chapters.map((chapter) => <div className={styles.chapterGroup} key={chapter.id}>
            <button className={styles.chapterChoice} type="button" aria-label={chapter.title} aria-pressed={selected.id === chapter.id} onClick={() => selectChapter(chapter.id)}>
              <strong>{chapter.title}</strong><span>{chapter.questions.length} 题</span>
            </button>
            <div className={styles.chapterQuestions}>{chapter.questions.map((row) => <QuestionPreview key={row.id} row={row}
              current={selected.id === chapter.id && chapterQuestionId === row.id} onClick={() => selectChapterQuestion(chapter.id, row)} />)}</div>
          </div>)}</div>
        </div>
      </aside>
      <div className={styles.detail}>
        <button className={styles.mobileBack} type="button" onClick={() => setMobileDetails((previous) => ({ ...previous, [browseMode]: false }))}><ChevronLeft size={16} />返回{browseMode === "knowledge" ? "知识点" : "章节"}列表</button>
        <header className={styles.contentToolbar}>
          <h3>{browseMode === "knowledge" ? point?.name ?? "知识点补讲" : selected.title}</h3>
          <div>{content === "slides" ? <><button type="button" onClick={() => setContent(browseMode === "chapters" ? "questions" : beforeSlides[browseMode] === "questions" ? "questions" : "overview")}><ChevronLeft size={16} />{browseMode === "chapters" || beforeSlides[browseMode] === "questions" ? "返回题目" : "返回知识点"}</button><button ref={chooseButton} type="button" onClick={() => setDrawerOpen(true)}><Presentation size={16} />选择课件</button></>
            : browseMode === "knowledge" && content === "questions" ? <button type="button" onClick={() => setContent("overview")}><ChevronLeft size={16} />返回知识点</button>
            : browseMode === "knowledge" && chapterReturn ? <button type="button" onClick={() => { setBrowseMode("chapters"); setChapterReturn(false); }}><ChevronLeft size={16} />返回题目</button> : null}</div>
        </header>
        <div className={styles.knowledgeOverview} hidden={browseMode !== "knowledge" || content !== "overview"}>
          {point && detail ? <>
            <div className={styles.overviewGrid}>
              <section className={styles.panel} aria-label="补讲重点">
                <header className={styles.panelHeading}><h4><BookOpen size={18} />讲解要点</h4></header>
                {teachingItems.length ? <dl className={styles.teachingItems}>{teachingItems.map((item) => <div key={`${point.knowledgePointId}:${item.label}`}><dt>{item.label}</dt><dd><TeachingText text={item.text!} /></dd></div>)}</dl> : <p className={styles.emptyLine}>暂无讲解要点</p>}
                <div className={styles.teachingMethod}><h5>建议讲法</h5><p>{detail.teachingStrategy}</p></div>
              </section>
              <section className={styles.panel} aria-label="评阅提示">
                <header className={styles.panelHeading}><h4><CircleAlert size={18} />易错点</h4></header>
                {point.misconceptionGroups.length ? <div className={styles.errorRows}>{point.misconceptionGroups.map((group) => <details key={group.code}>
                  <summary aria-label={`查看评阅反馈：${group.label}`}><span>{group.label}</span><strong>{group.studentCount} 人</strong><ChevronRight size={15} /></summary>
                  <div className={styles.feedbackEvidence}>{group.examples.map((example) => <blockquote key={example}>{example}</blockquote>)}{!group.examples.length ? <p>未保存评阅原文</p> : null}</div>
                </details>)}</div> : <p className={styles.emptyLine}>暂无评阅反馈</p>}
              </section>
            </div>
            <div className={styles.overviewGrid}>
              <section className={styles.panel} aria-label="知识点关联题目">
                <header className={styles.panelHeading}><h4><FileQuestion size={18} />关联题目 <span>{pointRows.length}</span></h4><button className={styles.outlinedAction} type="button" disabled={!pointRows.length} onClick={() => openQuestion()}>查看关联题目<ChevronRight size={16} /></button></header>
                {pointRows.length ? <div className={styles.resourceList}>{pointRows.slice(0, 4).map((row) => <button className={styles.resourceChoice} type="button" key={row.id} onClick={() => openQuestion(row)}>
                  <span><small>{row.sectionTitle} · 第 {row.questionNumber} 题{row.submittedCount && !row.authoredSource ? " · 历史版本" : ""}</small><strong>{shortQuestionText(row.snapshot.prompt)}</strong></span><ChevronRight size={16} />
                </button>)}{pointRows.length > 4 ? <span className={styles.remaining}>另有 {pointRows.length - 4} 题</span> : null}</div> : <p className={styles.emptyLine}>暂无关联题目</p>}
              </section>
              <section className={styles.panel} aria-label="知识点关联课件">
                <header className={styles.panelHeading}><h4><Presentation size={18} />讲解课件 <span>{associatedPages.length}</span></h4><button className={styles.filledAction} type="button" onClick={() => showCourseware()}>查看相关课件<ChevronRight size={16} /></button></header>
                {associatedPages.length ? <div className={styles.resourceList}>{associatedPages.slice(0, 3).map((outline) => <button className={styles.resourceChoice} type="button" key={outline.id} aria-label={`预览第 ${outlines.indexOf(outline) + 1} 页：${outline.title}`} onClick={() => choosePage(outline, false)}>
                  <span><small>第 {outlines.indexOf(outline) + 1} 页</small><strong>{outline.title}</strong></span><ChevronRight size={16} />
                </button>)}{associatedPages.length > 3 ? <span className={styles.remaining}>另有 {associatedPages.length - 3} 页</span> : null}</div> : <p className={styles.emptyLine}>暂无关联课件</p>}
                <button ref={chooseButton} className={styles.browseAction} type="button" onClick={() => setDrawerOpen(true)}>浏览全部课件</button>
              </section>
            </div>
          </> : <div className={styles.placeholder}><p>当前课程暂无知识点，可按章节查看题目或自主选择课件。</p><button type="button" onClick={() => setBrowseMode("chapters")}>按章节查看题目</button><button ref={chooseButton} type="button" onClick={() => setDrawerOpen(true)}>浏览全部课件</button></div>}
        </div>
        <div className={styles.questionScroll} hidden={browseMode !== "knowledge" || content !== "questions"}>
          <TeacherQuestionReviewContent course={course} rows={rows} focus={questionFocus} active={active && browseMode === "knowledge" && content === "questions" && !isShowingProjection} scope={{ pointId: point?.knowledgePointId }} resources={resources} simplified onKnowledgePoint={(id) => selectPoint(id)} onCourseware={showCourseware} />
        </div>
        <div className={styles.questionScroll} hidden={browseMode !== "chapters" || content !== "questions"}>
          <TeacherQuestionReviewContent course={course} rows={selected.questions} focus={chapterFocus} onQuestionChange={setChapterQuestionId} active={active && browseMode === "chapters" && content === "questions" && !isShowingProjection} scope={{ sectionId: selected.sectionId }} resources={resources} simplified onKnowledgePoint={(id) => selectPoint(id, true)} onCourseware={showCourseware} />
          {!selected.questions.length ? <button type="button" onClick={() => showCourseware()}>查看本章课件</button> : null}
        </div>
        <div className={styles.courseware} hidden={content !== "slides"}>
          <div className={styles.detailContent}>
            <div className={styles.previewHeading}><strong>{previewOutline?.title ?? "暂无关联课件"}</strong>{pages.length > 1 ? <div className={styles.pageNavigation} role="group" aria-label="课件预览翻页"><button type="button" aria-label="上一页课件" disabled={pageIndex <= 0} onClick={() => choosePage(pages[pageIndex - 1], Boolean(preview?.all))}><ChevronLeft size={16} /></button><span>{pageIndex + 1}/{pages.length}</span><button type="button" aria-label="下一页课件" disabled={pageIndex < 0 || pageIndex >= pages.length - 1} onClick={() => choosePage(pages[pageIndex + 1], Boolean(preview?.all))}><ChevronRight size={16} /></button></div> : null}</div>
            <div className={styles.preview} role="region" aria-label="课件预览">{active && content === "slides" && !isShowingProjection && scene && classroomId ? <OpenMaicResourcePlayer key={scene.id} classroomId={classroomId} sceneId={scene.id} experience="teacher-resource" className={styles.previewPlayer} /> : <div className={styles.placeholder}><Presentation aria-hidden="true" size={24} /><p>{!classroomId ? "知识讲授课堂尚未生成。" : resources.error ? resources.error : !resources.ready ? "正在加载课件…" : previewOutline ? "未找到该课件的可用页面，请重新选择。" : "暂无关联课件，可点击“选择课件”自主选讲。"}</p>{resources.error ? <button type="button" onClick={resources.retry}>重试加载课件</button> : null}</div>}</div>
          </div>
          <div className={styles.startActions}><Popover.Root open={active && content === "slides" && !isShowingProjection && settingsOpen} onOpenChange={setSettingsOpen}><Popover.Trigger asChild><button type="button" className={styles.settings}><Settings2 size={16} />投屏设置</button></Popover.Trigger><Popover.Portal container={typeof document !== "undefined" ? document.fullscreenElement : undefined}><Popover.Content className={styles.settingsPanel} side="top" align="start" sideOffset={8}><label>学生端展示方式<select aria-label="学生端展示方式" value={mode} onChange={(event) => { setMode(event.target.value === "optional" ? "optional" : "forced"); setSettingsOpen(false); }}><option value="forced">强制全屏</option><option value="optional">自主查看</option></select></label></Popover.Content></Popover.Portal></Popover.Root>
            <button className={styles.primary} type="button" disabled={!scene || !course.aiLearningClassroomId || course.status !== "teaching" || control.pending} onClick={startProjection}><MonitorUp size={16} />{control.needsTakeover ? "接管并投屏" : "投屏"}</button></div>
        </div>
        {directoryIncomplete ? <p className={styles.notice} role="status">{resources.error || catalog?.error ? "完整题目目录未加载，已保存的作答仍可查看。" : "正在加载完整题目目录，已保存的作答仍可查看。"}{resources.error || catalog?.error ? <button type="button" onClick={resources.retry}>重试加载题目目录</button> : null}</p> : null}
      </div>
    </div>
    <ProjectionToolbar course={course} control={control} resources={resources} outlines={outlines} lectureIds={lectureIds} active={active} open={projectionOpen} onOpenChange={(open) => { setProjectionOpen(open); if (!open && content === "slides") setContent(beforeSlides[browseMode]); }} />
    <Dialog.Root open={active && drawerOpen} onOpenChange={setDrawerOpen}><Dialog.Portal container={typeof document !== "undefined" ? document.fullscreenElement : undefined}><Dialog.Overlay className={styles.drawerOverlay} /><Dialog.Content className={styles.drawer} onCloseAutoFocus={(event) => { event.preventDefault(); chooseButton.current?.focus(); }}><header><Dialog.Title>选择讲解课件</Dialog.Title><Dialog.Close aria-label="关闭课件选择"><X size={20} /></Dialog.Close></header><Dialog.Description>选中后先预览，点击“投屏”再同步给学生。</Dialog.Description><div className={styles.drawerPages}>{associatedPages.length ? <><h3>相关课件</h3>{associatedPages.map((outline) => pageChoice(outline, false))}</> : null}{outlines.some((outline) => !drawerRelatedIds.has(outline.id)) ? <><h3>{associatedPages.length ? "其他课件" : "全部课件"}</h3>{outlines.filter((outline) => !drawerRelatedIds.has(outline.id)).map((outline) => pageChoice(outline, true))}</> : null}{!outlines.length ? <p className={styles.caption}>当前课程暂无可用课件。</p> : null}</div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}

function shortQuestionText(prompt: string) {
  const characters = Array.from(prompt.replace(/\s+/g, " ").trim());
  return characters.slice(0, 12).join("") + (characters.length > 12 ? "…" : "");
}

function TeachingText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 180) return <>{text}</>;
  return <details className={styles.longTeachingText} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{!open ? `${Array.from(text).slice(0, 90).join("")}… ` : ""}<span>{open ? "收起" : "展开"}</span></summary><p>{text}</p>
  </details>;
}

function QuestionPreview({ row, current, onClick }: { row: TeacherQuestionReviewRow; current: boolean; onClick: () => void }) {
  const correct = Math.max(0, row.gradedCount - row.incorrectCount);
  const unresolved = Math.max(0, row.submittedCount - row.gradedCount);
  const wrongLabel = row.objective ? "答错" : "未达标";
  const correctLabel = row.objective ? "答对" : "达标";
  const distribution = row.submittedCount ? `${correctLabel} ${correct} 人，${wrongLabel} ${row.incorrectCount} 人，未评 ${unresolved} 人` : "未作答";
  const status = row.gradedCount ? `${row.incorrectCount}/${row.gradedCount}` : !row.submittedCount ? "未作答" : row.failedCount ? "评阅失败" : row.unverifiedCount ? "待核验" : "待评";
  return <button type="button" className={styles.questionPreview} aria-label={`查看第 ${row.questionNumber} 题：${shortQuestionText(row.snapshot.prompt)}`} aria-current={current ? "true" : undefined} onClick={onClick}>
    <span className={styles.questionNumber}>{row.questionNumber}</span>
    <span className={styles.answerBar} role="img" aria-label={`第 ${row.questionNumber} 题作答分布：${distribution}`}>
      {row.submittedCount ? <><i data-kind="good" style={{ width: `${correct / row.submittedCount * 100}%` }} /><i data-kind="wrong" style={{ width: `${row.incorrectCount / row.submittedCount * 100}%` }} /></> : null}
    </span>
    <span className={styles.questionScore} data-attention={row.incorrectCount > 0}>{status}</span>
    <ChevronRight size={14} />
  </button>;
}

function ProjectionToolbar({ course, control, resources, outlines, lectureIds, active, open, onOpenChange }: {
  course: Course; control: ProjectionControl; resources: Resources; outlines: OpenMaicSceneOutlineSnapshot[]; lectureIds: string[];
  active: boolean; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const projection = control.projection;
  const scene = projection && projection.classroomId === course.aiLearningClassroomId ? resources.scenes.find((scene) => scene.id === projection.sceneId) : undefined;
  const projectedOutline = scene && outlines.find((outline) => findTeachingScene(resources.scenes, outline)?.id === scene.id);
  const lecturePages = lectureIds.includes(projectedOutline?.id ?? "") ? outlines.filter((outline) => lectureIds.includes(outline.id)) : outlines;
  const projectedIndex = lecturePages.findIndex((outline) => outline.id === projectedOutline?.id);
  if (!projection && !control.pending && !control.error) return null;
  function turn(index: number) {
    const next = lecturePages[index] && findTeachingScene(resources.scenes, lecturePages[index]);
    if (next && control.controlsProjection) control.project(next, projection?.mode ?? "forced");
  }
  function stop() { control.stop(); onOpenChange(false); }
  function navigation() {
    return projection && projectedIndex >= 0 ? <div className={styles.pageNavigation} role="group" aria-label="投屏翻页"><button type="button" aria-label="上一页" disabled={!control.controlsProjection || control.pending || projectedIndex <= 0} onClick={() => turn(projectedIndex - 1)}><ChevronLeft size={16} /></button><span>{projectedIndex + 1}/{lecturePages.length}</span><button type="button" aria-label="下一页" disabled={!control.controlsProjection || control.pending || projectedIndex >= lecturePages.length - 1} onClick={() => turn(projectedIndex + 1)}><ChevronRight size={16} /></button></div> : null;
  }
  const status = <div className={styles.sync} role={control.error ? "alert" : "status"}>
    <span>{control.pending ? "正在确认投屏同步…" : control.error ?? (projection ? `${control.confirmed ? "投屏已提交" : "正在投屏"} · ${projection.mode === "optional" ? "自主查看" : "强制全屏"}` : "已停止投屏")}</span>
    {projection ? <span>当前投屏：{projection.title.replace(/^全班补讲 · /, "")}{!control.controlsProjection ? " · 由其他教师窗口控制" : ""}</span> : null}
  </div>;
  return <>
    <section className={styles.projectionSurface} aria-label="当前投屏课件" hidden={!active || !open || !scene}>
      <h3>{projectedOutline?.title ?? projection?.title}</h3>
      {scene && projection && course.aiLearningClassroomId ? <OpenMaicResourcePlayer key={`${scene.id}:${projection.startedAt}`} classroomId={course.aiLearningClassroomId} sceneId={scene.id}
        experience={control.controlsProjection ? "teacher-resource" : "projected-readonly"} className={styles.projectionPlayer}
        playbackState={!control.controlsProjection && projection.playback ? { version: projection.version ?? 0, engineMode: projection.engineMode ?? "idle", snapshot: projection.playback } : undefined}
        interactionState={!control.controlsProjection ? projection.interactionState : undefined} onPlaybackStateChange={control.syncPlayback} /> : null}
    </section>
    <div className={styles.projectionToolbar} aria-label="当前课件投屏">
      {status}
      {control.error && control.canRetry ? <button type="button" onClick={control.retry}>{control.needsTakeover ? "接管并重试投屏" : "重试投屏同步"}</button> : null}
      {scene ? <button type="button" onClick={() => onOpenChange(!open)}>{open ? <><ChevronLeft size={16} />返回分析</> : "查看投屏"}</button> : null}
      {navigation()}
      {projection && control.controlsProjection ? <button type="button" disabled={control.pending} onClick={stop}><Square size={16} />停止投屏</button> : null}
    </div>
  </>;
}
