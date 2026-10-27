"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { ArrowRight, BookOpen, Download, Edit3, FileText, PlayCircle } from "lucide-react";
import { OpenMaicResourcePlayer } from "@/components/openmaic-bridge/openmaic-resource-player";
import { StudentPdfResourceViewer } from "@/components/classroom/simple-stage-resources";
import { ResilientImage } from "@/components/resilient-image";
import type { CourseGenerationInputSummary } from "@/lib/course-design/generation-input-summary";
import { courseDetailHref, courseEditorHref } from "@/lib/courses/preparation-navigation";
import { resourcesForStage } from "@/lib/classroom/stage-resources";
import { getTeacherResourcesForStage } from "@/lib/openmaic-bridge/teacher-resources";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import { DocumentContentMonitorSetting } from "@/components/teacher/document-content-monitor-setting";
import { courseResourceTypeLabel } from "@/lib/user-facing-labels";
import type { Course, CourseResource, OpenMaicSceneOutlineSnapshot, TeacherResourceScene } from "@/lib/session/types";
import type { ResourcePackageStage } from "@/lib/resource-package/types";
import styles from "./page.module.css";

export function courseDetailStages(course: Course): Array<ResourcePackageStage | {
  key: string; title: string; durationMin: null; requirements: string; outputs: string; teacherActions: string; aiActions: string;
}> {
  if (course.content.stagePlan?.stages.length) return course.content.stagePlan.stages;
  return course.stages.map((stage) => ({ key: stage.key, title: stage.label, durationMin: null,
    requirements: stage.description, outputs: "", teacherActions: "", aiActions: "" }));
}

function Panel({ title, description, editHref, children }: {
  title: string; description?: string; editHref?: string; children: ReactNode;
}) {
  return <section className={styles.panel}>
    <header className={styles.panelHeading}>
      <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>
      {editHref ? <Link className={styles.textAction} href={editHref}><Edit3 size={15}/>编辑{title}</Link> : null}
    </header>
    {children}
  </section>;
}

function ReadValue({ label, value }: { label: string; value?: string }) {
  return <div className={styles.readValue}><h3>{label}</h3><p>{value?.trim() || "尚未填写"}</p></div>;
}

export function CourseDetailOverview({ course, returnTo, onSelectStage }: {
  course: Course; returnTo: string; onSelectStage: (key: string) => void;
}) {
  const stages = courseDetailStages(course);
  const objectives = course.learningObjectives ?? [];
  const minutes = course.content.stagePlan?.totalMinutes;
  const studentPages = (course.content._openmaicSceneOutlines ?? []).filter((item) => item.audience !== "teacher");
  return <div className={styles.panelStack}>
    <Panel title="这门课要做什么" editHref={courseEditorHref(course.id, "design", { section: "materials", returnTo })}>
      {course.summary ? <p className={styles.lead}>{course.summary}</p> : null}
      <dl className={styles.metrics}>
        <div><dt>教学对象</dt><dd>{course.grade || "尚未填写"}</dd></div>
        <div><dt>课程时长</dt><dd>{minutes ? `${minutes} 分钟` : course.hours ? `${Math.round(course.hours * 60)} 分钟` : "尚未规划"}</dd></div>
        <div><dt>教学阶段</dt><dd>{stages.length ? `${stages.length} 个` : "尚未规划"}</dd></div>
        <div><dt>知识讲授页面</dt><dd>{studentPages.length ? `${studentPages.length} 页` : "尚未生成"}</dd></div>
      </dl>
      <div className={styles.readGrid}>
        <ReadValue label="驱动问题" value={course.drivingQuestion}/>
        <ReadValue label="预期成果" value={course.expectedOutcome}/>
      </div>
      <div className={styles.readValue}><h3>学习目标</h3>{objectives.length ? <ol className={styles.objectives}>{objectives.map((objective, index) => <li key={`${index}-${objective}`}>{objective}</li>)}</ol> : <p>尚未填写</p>}</div>
    </Panel>
    <Panel title="教学流程" description="按授课顺序浏览任务、师生分工与课前资源。">
      {stages.length ? <ol className={styles.stageOverview}>{stages.map((stage, index) => <li key={stage.key}>
        <button type="button" onClick={() => onSelectStage(stage.key)}>
          <span className={styles.stageNumber}>{String(index + 1).padStart(2, "0")}</span>
          <span className={styles.stageOverviewCopy}><strong>{stage.title}</strong><span>{stage.requirements || "查看本阶段教学内容"}</span></span>
          <span className={styles.stageDuration}>{stage.durationMin ? `${stage.durationMin} 分钟` : "未分配时长"}</span><ArrowRight size={17}/>
        </button>
      </li>)}</ol> : <p className={styles.empty}>教学安排尚未生成。可返回课程生成页继续备课。</p>}
    </Panel>
    <div className={styles.quickLinks}>
      <Link href={courseDetailHref(course.id, { view: "materials" })}><BookOpen size={19}/><span><strong>课程资料</strong><span>资源包、教材依据与教师补充</span></span><ArrowRight size={16}/></Link>
      <Link href={courseDetailHref(course.id, { view: "settings" })}><FileText size={19}/><span><strong>课程设置</strong><span>时间安排、成果与评价要求</span></span><ArrowRight size={16}/></Link>
    </div>
  </div>;
}

export function CourseDetailContent({ course, stageKey, selectedOutline, sectionId, returnTo, onSelectStage, onSelectPage, preview }: {
  course: Course; stageKey: string; selectedOutline?: OpenMaicSceneOutlineSnapshot; sectionId?: string; returnTo: string;
  onSelectStage: (key: string) => void; onSelectPage: (outline: OpenMaicSceneOutlineSnapshot) => void; preview: ReactNode;
}) {
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const directoryToggle = useRef<HTMLButtonElement>(null);
  const stages = courseDetailStages(course);
  const stage = stages.find((item) => item.key === stageKey);
  const isLecture = stageKey === "ai-learning";
  const outlines = (course.content._openmaicSceneOutlines ?? []).filter((item) => item.audience !== "teacher"
    && (item.stageKey ? item.stageKey === stageKey : isLecture));
  const sections = course.content.knowledgeLectureSections ?? [];
  const grouped = sections.map((section) => ({ id: section.id, title: section.title,
    pages: outlines.filter((outline) => outline.lectureSectionId === section.id || section.sceneOutlineIds.includes(outline.id)) })).filter((section) => section.pages.length);
  const knownIds = new Set(grouped.flatMap((section) => section.pages.map((page) => page.id)));
  const remainder = outlines.filter((outline) => !knownIds.has(outline.id));
  if (remainder.length) grouped.push({ id: "remaining", title: grouped.length ? "其他学习页面" : "知识讲授", pages: remainder });
  const teacherResources = getTeacherResourcesForStage(course, stageKey);
  const teacherClassroomId = course.teacherClassroomId ?? course.content.teacherClassroomId;
  const resources = resourcesForStage(course.resources, stageKey);
  const responsibilities = <>
    {stage ? <div className={styles.readGrid}>
      <ReadValue label="学生任务" value={stage.requirements}/><ReadValue label="阶段成果" value={stage.outputs}/>
      <ReadValue label="教师做什么" value={stage.teacherActions}/><ReadValue label="AI 做什么" value={stage.aiActions}/>
    </div> : <p className={styles.empty}>本课程尚未保存阶段要求。</p>}
    {stage && "checkpoints" in stage && stage.checkpoints?.length ? <details className={styles.fold}><summary>过程检查点</summary><ul>{stage.checkpoints.map((point) => <li key={point}>{point}</li>)}</ul></details> : null}
  </>;
  return <div className={styles.panelStack}>
    <nav className={styles.stageNav} aria-label="教学阶段">{stages.map((item, index) => <button
      key={item.key} type="button" aria-current={item.key === stageKey ? "step" : undefined} onClick={() => onSelectStage(item.key)}>
      <span>{String(index + 1).padStart(2, "0")}</span>{item.title}
    </button>)}</nav>
    {isLecture ? <details className={styles.fold}><summary>知识讲授任务与分工{stage?.durationMin ? ` · ${stage.durationMin} 分钟` : ""}</summary>{responsibilities}
      <Link className={styles.textAction} href={courseEditorHref(course.id, "design", { section: "stage-plan", returnTo })}><Edit3 size={15}/>编辑阶段安排</Link>
    </details> : <Panel title={stage?.title ?? "教学内容"} description={stage?.durationMin ? `计划 ${stage.durationMin} 分钟` : undefined}
      editHref={courseEditorHref(course.id, "design", { section: "stage-plan", returnTo })}>
      {responsibilities}
    </Panel>}
    {isLecture ? <section className={styles.lessonWorkspace} aria-label="知识讲授课前预览">
      <button ref={directoryToggle} className={styles.lessonToggle} type="button" aria-expanded={directoryOpen} aria-controls="course-page-directory" onClick={() => setDirectoryOpen(!directoryOpen)}><BookOpen size={16}/>{directoryOpen ? "收起课程目录" : "展开课程目录"}<span>{outlines.length} 页</span></button>
      <aside id="course-page-directory" className={styles.lessonRail} data-expanded={directoryOpen} aria-label="小节与页面">
        <div className={styles.lessonRailHeading}><h2>小节与页面</h2><span>{outlines.length} 页</span></div>
        {grouped.length ? grouped.map((group) => <details key={`${group.id}-${sectionId ?? ""}`} open={group.id === sectionId || group.pages.some((page) => page.id === selectedOutline?.id) || grouped.length === 1}>
          <summary>{group.title}<span>{group.pages.length} 页</span></summary>
          <ol>{group.pages.map((outline) => <li key={outline.id}><button aria-current={selectedOutline?.id === outline.id ? "page" : undefined}
            onClick={() => {
              setDirectoryOpen(false);
              onSelectPage(outline);
              if (directoryToggle.current?.getClientRects().length) directoryToggle.current.focus({ preventScroll: true });
            }} type="button"><span>{outlines.indexOf(outline) + 1}</span><span>{outline.title}</span></button></li>)}</ol>
        </details>) : <p className={styles.empty}>学习页面尚未生成。</p>}
      </aside>
      <div className={styles.lessonMain}>
        {selectedOutline ? <div className={styles.previewHeading}><div><span>课前预览</span><h3>{selectedOutline.title}</h3></div><Link className={styles.textAction}
          href={courseEditorHref(course.id, "classroom", { sceneId: selectedOutline.id, returnTo })}><Edit3 size={15}/>编辑当前页</Link></div> : null}
        {preview}
        {selectedOutline ? <details className={styles.fold}><summary>查看本页教学要点</summary><p>{selectedOutline.description || "尚未填写说明"}</p>
          {selectedOutline.keyPoints?.length ? <ul>{selectedOutline.keyPoints.map((point, index) => <li key={`${index}-${point}`}>{point}</li>)}</ul> : null}
        </details> : null}
      </div>
    </section> : null}
    {!isLecture || resources.length || teacherResources.length ? <Panel title="本阶段授课资源">
      {resources.length ? <div className={styles.resourceList}>{resources.map((resource) => <CourseAttachment key={resource.id} courseId={course.id} resource={resource}/>)}</div> : null}
      {teacherResources.map((resource) => <TeacherResourcePreview key={resource.id} classroomId={teacherClassroomId} resource={resource}/>)}
      {!resources.length && !teacherResources.length ? <p className={styles.empty}>本阶段暂无独立课件，可按上方教学任务与要求开展活动。</p> : null}
    </Panel> : null}
  </div>;
}

function TeacherResourcePreview({ classroomId, resource }: { classroomId?: string; resource: TeacherResourceScene }) {
  const [expanded, setExpanded] = useState(false);
  return <details className={styles.fold} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><PlayCircle size={16}/>{resource.title}</summary>
    {expanded ? classroomId ? <OpenMaicResourcePlayer className={styles.resourcePlayer} classroomId={classroomId} sceneId={resource.id} experience="projected-readonly"/> : <p>尚未关联可预览资源。</p> : null}
    {resource.script ? <div className={styles.readValue}><h3>授课讲稿</h3><p>{resource.script}</p></div> : null}
  </details>;
}

function CourseAttachment({ courseId, resource }: { courseId: string; resource: CourseResource }) {
  const [expanded, setExpanded] = useState(false);
  const url = resource.previewUrl || resource.url;
  const type = `${resource.previewType || resource.type} ${resource.previewUrl || resource.title}`.toLowerCase();
  const pdf = /pdf/.test(type);
  const video = /mp4|webm|mov|video/.test(type);
  const audio = /mp3|wav|ogg|m4a|audio/.test(type);
  const picture = /png|jpe?g|gif|webp|image/.test(type);
  const canPreview = Boolean(url && (pdf || video || audio || picture));
  return <div className={styles.attachment}>
    <div className={styles.attachmentHeading}><FileText size={19}/><div><strong>{resource.title}</strong><span>{courseResourceTypeLabel(resource.type)}{resource.size ? ` · ${resource.size}` : ""}</span></div>
      {canPreview ? <button className={styles.textAction} type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起预览" : "预览资料"}</button> : null}
      {resource.url ? <a className={styles.textAction} href={resource.url} target="_blank" rel="noreferrer"><Download size={15}/>打开文件</a> : null}
    </div>
    {resource.description ? <p className={styles.resourceDescription}>{resource.description}</p> : null}
    {expanded && url ? <div className={styles.attachmentPreview}>
      {pdf ? <StudentPdfResourceViewer url={url} title={resource.title} progressKey={`preparation:${courseId}:${resource.id}`} onReady={() => undefined}/>
        : video ? <video controls preload="metadata" src={url}/>
          : audio ? <audio controls preload="metadata" src={url}/>
            : picture ? <Image src={url} alt={resource.title} width={1200} height={800} unoptimized/> : null}
    </div> : null}
  </div>;
}

export function CourseDetailMaterials({ course, returnTo, generationInput, generationInputError }: {
  course: Course; returnTo: string; generationInput?: CourseGenerationInputSummary | null; generationInputError?: string;
}) {
  const collaborative = course.content.preparationSource === "collaborative-preparation";
  const preparation = collaborative ? course.content.confirmedPreparation : undefined;
  const pack = collaborative ? undefined : course.content.resourcePackage;
  const documents = pack ? Object.entries(pack.documents) : [];
  const documentLabels: Record<string, string> = { knowledge: "知识材料", lessonPlan: "教案", launchPresentation: "项目启动课件" };
  const evidence = course.content.courseEvidence;
  const textbookSources = [...new Map((evidence?.items ?? []).map((item) => [item.source.revisionId, item.source])).values()];
  const teacherRequirements = course.content.teachingRequirements?.items.filter((item) => item.source === "teacher") ?? [];
  const inputMatches = generationInput?.sourceStatus === "current" && (generationInput.source === "collaborative-preparation"
    ? collaborative && preparation?.sessionId === generationInput.preparationSessionId && preparation?.revision === generationInput.preparationRevision
    : !collaborative && pack?.id === generationInput.resourcePackageId && pack?.revision === generationInput.resourcePackageRevision);
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  const teacherClassroomId = course.teacherClassroomId || course.content.teacherClassroomId;
  const generatedResources = courseDetailStages(course).map((stage) => ({ ...stage,
    pages: stage.key === "ai-learning" && classroomId
      ? (course.content._openmaicSceneOutlines ?? []).filter((outline) => outline.audience !== "teacher").length : 0,
    teacherPages: teacherClassroomId ? getTeacherResourcesForStage(course, stage.key).length : 0,
  })).filter((stage) => stage.pages || stage.teacherPages || (stage.key === "ai-learning" && classroomId));
  const branches = course.content.adaptiveLearningPlan?.enabled
    ? course.content.adaptiveLearningPlan.branches.filter((branch) => branch.enabled !== false && branch.preparedResource?.classroomId) : [];
  return <div className={styles.panelStack}>
    <Panel title={collaborative ? "协同备课方案" : "资源包与原始资料"} description={collaborative ? "查看教师确认并用于生成的课程方案。" : "查看本课程实际采用的文件与解析结果。"} editHref={courseEditorHref(course.id, "design", { section: "materials", returnTo })}>
      {preparation ? <>
        <p className={styles.source}>通过 AI 协同备课形成 · 已由教师确认</p>
        <div className={styles.readGrid}><ReadValue label="课程主题" value={preparation.plan.courseName}/><ReadValue label="教学对象" value={preparation.plan.grade}/><ReadValue label="课程总时长" value={`${preparation.plan.totalMinutes} 分钟`}/><ReadValue label="学情描述" value={preparation.plan.learnerContext}/><ReadValue label="教学方式" value={preparation.plan.teachingApproach}/><ReadValue label="项目任务" value={preparation.plan.stagePlan.projectTask}/></div>
        <details className={styles.fold}><summary>查看已确认的目标与知识要求</summary><div className={styles.readValue}><h3>学习目标</h3><ul>{preparation.plan.learningObjectives.map((item, index) => <li key={index}>{item}</li>)}</ul><h3>知识范围与深度</h3><ul>{preparation.plan.knowledgePoints.map((item) => <li key={item.id}>{item.name}：{item.depth}；{item.teachingApproach}</li>)}</ul></div></details>
      </> : pack ? <>
        <div className={styles.attachmentHeading}><FileText size={20}/><div><strong>{pack.source.fileName}</strong><span>资源包修订 {pack.revision} · {pack.confirmedAt ? "已确认" : "尚未确认"}</span></div>
          <a className={styles.textAction} href={pack.source.url} target="_blank" rel="noreferrer"><Download size={15}/>下载原包</a></div>
        <ul className={styles.documentList}>{documents.map(([role, file]) => file ? <li key={role}><span>{documentLabels[role] ?? "课程资料"}</span><a href={file.url} target="_blank" rel="noreferrer">{file.fileName}<ArrowRight size={14}/></a></li> : null)}</ul>
        <details className={styles.fold}><summary>查看资源包识别内容</summary><div className={styles.readGrid}><ReadValue label="课程主题" value={pack.draft.courseName}/><ReadValue label="教学对象" value={pack.draft.grade}/><ReadValue label="项目任务" value={pack.draft.projectTask}/><ReadValue label="学情描述" value={pack.draft.learnerContext}/></div>
          {pack.draft.knowledgePoints.length ? <div className={styles.readValue}><h3>原始知识要求</h3><ul>{pack.draft.knowledgePoints.map((point, index) => <li key={point.id || index}>{point.name}{point.description ? `：${point.description}` : ""}</li>)}</ul></div> : null}
        </details>
      </> : <p className={styles.empty}>本课程没有关联资源包。</p>}
    </Panel>
    <Panel title="教材依据">
      {textbookSources.length ? <ul className={styles.documentList}>{textbookSources.map((source) => <li key={source.revisionId}><div><strong>{source.textbookTitle}</strong><p>教材版本 {source.revisionVersion}{course.content.textbookSelections?.find((item) => item.revisionId === source.revisionId)?.primary ? " · 主教材" : ""}</p></div><Link className={styles.textAction} href={`/teacher/textbooks/${encodeURIComponent(source.textbookId)}?returnTo=${encodeURIComponent(returnTo)}`}>查看教材<ArrowRight size={15}/></Link></li>)}</ul>
        : <p className={styles.empty}>{course.content.textbookSelections?.length ? `已选择 ${course.content.textbookSelections.length} 份教材版本，尚未保存采用证据。` : "本课程未选择教材库中的教材。"}</p>}
      {evidence?.items.length ? <details className={styles.fold}><summary>查看已采用的教材内容 · {evidence.items.length} 项</summary><ol className={styles.evidenceList}>{evidence.items.map((item) => <li key={item.id}><strong>{item.title}</strong><p className={styles.source}>{item.source.textbookTitle} · {item.source.sectionPath.join(" / ")}</p><p>{item.content}</p></li>)}</ol></details> : null}
    </Panel>
    <Panel title="最近生成任务的补充资料" description="查看生成时提供的文件与要求，实际课程内容请到教学内容中核对。">
      {generationInputError ? <p className={styles.empty}>{generationInputError}</p>
        : generationInput === undefined ? <p className={styles.empty}>正在读取补充资料…</p>
          : !generationInput ? <p className={styles.empty}>没有保存的生成任务补充资料。</p>
            : !inputMatches ? <p className={styles.empty}>{generationInput.source === "collaborative-preparation" || collaborative ? "当前备课方案与最近生成任务的来源不一致，历史补充资料不作为本课程依据。" : generationInput.sourceStatus === "unavailable" ? "历史任务未保存可核对的资源包来源，暂不展示其补充资料。" : "当前资源包与最近生成任务不一致，历史补充资料不作为本课程依据。"}</p>
              : <>
                <ReadValue label="最近生成任务的补充要求" value={generationInput.teacherBrief}/>
                {generationInput.referenceMaterials.length ? <ul className={styles.documentList}>{generationInput.referenceMaterials.map((material) => <li key={material.id}>
                  <div><strong>{material.fileName}</strong><p>{courseResourceTypeLabel(material.mimeType)}</p></div>
                  <a className={styles.textAction} href={`/api/uploads/${encodeURIComponent(material.id)}?download=1`} target="_blank" rel="noreferrer"><Download size={15}/>下载补充资料</a>
                </li>)}</ul> : <p className={styles.empty}>该生成任务没有额外上传补充文件。</p>}
              </>}
    </Panel>
    <Panel title="教师补充与学情">
      <div className={styles.readGrid}><ReadValue label="已有知识" value={course.learnerProfile?.priorKnowledge}/><ReadValue label="学习需求" value={course.learnerProfile?.learningNeeds}/><ReadValue label="熟悉的情境" value={course.learnerProfile?.familiarContexts}/></div>
      {teacherRequirements.length ? <ul className={styles.objectives}>{teacherRequirements.map((item) => <li key={item.id}>{item.text}</li>)}</ul> : <p className={styles.empty}>没有额外的教师要求。</p>}
    </Panel>
    <Panel title="生成的授课资源" description="按教学阶段进入已保存的课件与预览。">
      {generatedResources.length || branches.length ? <ul className={styles.documentList}>
        {generatedResources.map((stage) => <li key={stage.key}><div><strong>{stage.title}</strong><p>{[stage.pages ? `${stage.pages} 页知识讲授` : stage.key === "ai-learning" && classroomId ? "知识讲授课堂" : "", stage.teacherPages ? `${stage.teacherPages} 项教师授课资源` : ""].filter(Boolean).join(" · ")}</p></div>
          <Link className={styles.textAction} href={courseDetailHref(course.id, { view: "content", stage: stage.key })}>预览{stage.title}<ArrowRight size={15}/></Link></li>)}
        {branches.map((branch) => <li key={branch.id}><div><strong>{branch.title}</strong><p>个性化学习资源</p></div><Link className={styles.textAction}
          href={courseDetailHref(course.id, { view: "content", stage: "ai-learning", classroomId: branch.preparedResource!.classroomId })}>预览{branch.title}<ArrowRight size={15}/></Link></li>)}
      </ul> : <p className={styles.empty}>尚无已保存的授课资源。</p>}
    </Panel>
    {course.resources?.length ? <Panel title="课程附件"><div className={styles.resourceList}>{course.resources.map((resource) => <CourseAttachment key={resource.id} courseId={course.id} resource={resource}/>)}</div></Panel> : null}
  </div>;
}

export function CourseDetailSettings({ course, returnTo }: { course: Course; returnTo: string }) {
  const plan = course.content.stagePlan;
  const config = normalizePblCourseConfig(course.pblConfig);
  const rubric = plan?.evaluationRubric;
  const reflection = plan?.reflectionQuestionSet?.questions;
  const editStageHref = courseEditorHref(course.id, "design", { section: "stage-plan", returnTo });
  const adaptivePlan = course.content.adaptiveLearningPlan;
  const branches = adaptivePlan?.branches.filter((branch) => branch.enabled !== false) ?? [];
  return <div className={styles.panelStack}>
    <Panel title="基本信息与封面" editHref={courseEditorHref(course.id, "design", { section: "materials", returnTo })}>
      <div className={styles.basicsLayout}>
        <div className={styles.courseCover}>{course.coverImageUrl ? <ResilientImage src={course.coverImageUrl} alt={`${course.name}课程封面`} fill unoptimized sizes="280px"/> : <span>尚未设置课程封面</span>}</div>
        <div className={styles.readGrid}><ReadValue label="课程名称" value={course.name}/><ReadValue label="学科" value={course.subject}/><ReadValue label="教学对象" value={course.grade}/><ReadValue label="课程时长" value={course.hours ? `${Math.round(course.hours * 60)} 分钟` : undefined}/></div>
      </div>
      <ReadValue label="课程简介" value={course.summary}/>
      <div className={styles.readGrid}><ReadValue label="驱动问题" value={course.drivingQuestion}/><ReadValue label="预期成果" value={course.expectedOutcome}/></div>
      <div className={styles.readValue}><h3>学习目标</h3>{course.learningObjectives?.length ? <ol className={styles.objectives}>{course.learningObjectives.map((objective, index) => <li key={index}>{objective}</li>)}</ol> : <p>尚未填写</p>}</div>
    </Panel>
    <Panel title="时间安排" editHref={editStageHref}>
      <p className={styles.lead}>{plan ? `共 ${plan.totalMinutes} 分钟${plan.lessonCount ? ` · ${plan.lessonCount} 课次` : ""}${plan.minutesPerLesson ? ` · 每课次 ${plan.minutesPerLesson} 分钟` : ""}` : "尚未规划课程时长。"}</p>
      <dl className={styles.settingRows}>{courseDetailStages(course).map((stage) => <div key={stage.key}><dt>{stage.title}</dt><dd>{stage.durationMin ? `${stage.durationMin} 分钟` : "尚未分配"}</dd></div>)}</dl>
      <Link className={styles.textAction} href={courseEditorHref(course.id, "design", { section: "timing", returnTo })}>查看知识讲授时间规划<ArrowRight size={15}/></Link>
    </Panel>
    <Panel title="任务与成果" editHref={editStageHref}>
      <div className={styles.readGrid}><ReadValue label="项目任务" value={plan?.projectTask}/><ReadValue label="成果要求" value={course.expectedOutcome}/></div>
      {plan?.finalDeliverables?.length ? <ul className={styles.documentList}>{plan.finalDeliverables.map((item) => <li key={item.id}><div><strong>{item.name}{item.required ? " · 必交" : " · 可选"}</strong><p>{deliverableFormatLabel(item.format)} · {item.requirements}</p></div></li>)}</ul> : null}
      <div className={styles.readValue}><h3>成果形式默认值</h3><p>{{ document: "文档成果", other: "上传其他成果", python: "Python 代码", c: "C 语言代码" }[config.makeArtifactMode]}</p><p className={styles.source}>实际授课时可在对应课堂的班级配置中调整成果形式与人数。</p></div>
    </Panel>
    <Panel title="评价与反思" editHref={editStageHref}>
      <ReadValue label="评价要求" value={plan?.evaluationCriteria}/>
      {rubric ? <><dl className={styles.settingRows}>{rubric.dimensions.map((dimension) => <div key={dimension.id}><dt>{dimension.name}<p>{dimension.description}</p></dt><dd>{dimension.weight}%</dd></div>)}</dl><p className={styles.source}>教师评价 {rubric.sourceWeights.teacher}% · AI 评价 {rubric.sourceWeights.ai}%</p></> : null}
      <div className={styles.readValue}><h3>教案反思题</h3>{reflection?.length ? <ol className={styles.objectives}>{reflection.map((item) => <li key={item.id}>{item.prompt}{item.required ? "（必答）" : ""}</li>)}</ol> : plan?.reflectionQuestions?.length ? <ol className={styles.objectives}>{plan.reflectionQuestions.map((item, index) => <li key={index}>{item}</li>)}</ol> : <p>尚未配置</p>}</div>
      <p className={styles.source}>课堂活动的后测题目在教学班的测评配置中维护。</p>
    </Panel>
    <Panel title="学习路径">
      {adaptivePlan ? <><dl className={styles.settingRows}><div><dt>个性化学习</dt><dd>{adaptivePlan.enabled ? "已启用" : "未启用"}</dd></div><div><dt>课前检测</dt><dd>{adaptivePlan.pretest.questions.length} 题</dd></div><div><dt>启用的学习资源</dt><dd>{branches.length} 项</dd></div></dl>
        <Link className={styles.textAction} href={`${courseDetailHref(course.id, { view: "content", stage: "ai-learning" })}#course-learning-path`}>查看学习路径<ArrowRight size={15}/></Link></> : <p className={styles.empty}>本课程尚未配置个性化学习路径。</p>}
    </Panel>
    <Panel title="AI 与教学要求">
      <DocumentContentMonitorSetting course={course} scope="course-default" />
      <ReadValue label="AI 使用要求" value={plan?.aiUsagePolicy}/>
      <dl className={styles.settingRows}><div><dt>学习难度</dt><dd>{{ introductory: "入门", standard: "标准", advanced: "进阶" }[config.difficultyLevel]}</dd></div><div><dt>项目实践联网检索</dt><dd>{config.practiceWebSearchEnabled ? "教材依据不足时可用" : "未启用"}</dd></div></dl>
      <Link className={styles.textAction} href={courseEditorHref(course.id, "design", { section: "knowledge", returnTo })}>查看知识结构与教学范围<ArrowRight size={15}/></Link>
    </Panel>
  </div>;
}

function deliverableFormatLabel(format: string): string {
  const labels: Record<string, string> = { document: "文档", python: "Python 代码", c: "C 语言代码", other: "其他文件", presentation: "演示文稿", code: "代码", image: "图片", video: "视频", audio: "音频", report: "报告", pdf: "PDF", ppt: "PPT", pptx: "PPT", doc: "Word", docx: "Word" };
  return labels[format.toLowerCase()] || format;
}
