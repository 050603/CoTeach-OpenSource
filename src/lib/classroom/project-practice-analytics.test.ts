import { describe, expect, it } from "vitest";
import type { AiInteractionEvent, ClassroomSubmission, Course, StudentAiDecision } from "@/lib/session/types";
import { deriveAiCollaborationMetrics, derivePracticeDecisions, deriveProjectPracticeRows } from "./project-practice-analytics";

const at = (minute: number) => `2026-10-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
const course = (overrides: Partial<Course> = {}): Course => ({
  id: "classroom", students: ["s1", "s2"].map((id) => ({ id, name: id, joinedAt: at(0), stageProgress: {} })),
  groups: [], stages: [], ...overrides,
} as Course);
const event = (id: string, overrides: Partial<AiInteractionEvent> = {}): AiInteractionEvent => ({
  id, courseId: "classroom", studentId: "s1", stageKey: "make", source: "sidebar", eventType: "request", actorRole: "student",
  requestId: id, content: id, createdAt: at(0), ...overrides,
});
const artifact = (id: string, overrides: Partial<ClassroomSubmission> = {}): ClassroomSubmission => ({
  id, courseId: "classroom", studentId: "s1", stageKey: "make", type: "document", title: id, content: "<p>草稿</p>",
  createdAt: at(0), updatedAt: at(0), ...overrides,
});
const durable = (id: string, overrides: Partial<StudentAiDecision> = {}): StudentAiDecision => ({
  id, courseId: "classroom", studentId: "s1", stageKey: "make", contributionId: "suggestion", decision: "adopted",
  reason: "学生确认", resultingEvidenceIds: [], decidedAt: at(1), ...overrides,
});
const proposal = (overrides: Partial<AiInteractionEvent> = {}) => event("proposal", {
  requestId: "request", conversationId: "conversation", actorRole: "ai", eventType: "proposal", content: "建议说明",
  payload: { contributionId: "suggestion", suggestion: { title: "补充依据", targetText: "原文", replacement: "修改后正文" } }, ...overrides,
});

describe("project practice analytics", () => {
  it("recognizes submitted versions without a live draft and excludes failed/foreign records", () => {
    const rows = deriveProjectPracticeRows(course({
      submissions: [artifact("failed", { status: "failed" }), artifact("foreign", { courseId: "other" }), artifact("unknown", { studentId: "unknown" })],
      projectDocumentVersions: [
        { id: "submitted", courseId: "classroom", studentId: "s1", stageKey: "make", submissionId: "missing", sequence: 1, sourceVersion: 1, title: "定稿", sourceHtml: "", status: "submitted", createdAt: at(0), submittedAt: at(2) },
        { id: "failed-version", courseId: "classroom", studentId: "s2", stageKey: "make", submissionId: "failed", sequence: 1, sourceVersion: 1, title: "失败", sourceHtml: "", status: "failed", createdAt: at(0) },
        { id: "foreign-version", courseId: "other", studentId: "s2", stageKey: "make", submissionId: "foreign", sequence: 1, sourceVersion: 1, title: "其他课堂", sourceHtml: "", status: "submitted", createdAt: at(0) },
      ],
    }));
    expect(rows[0]).toMatchObject({ artifact: undefined, submitted: true, hasDraft: true, progressState: "submitted", submissionCount: 1, updatedAt: at(2) });
    expect(rows[1]).toMatchObject({ artifact: undefined, submitted: false, hasDraft: false, progressState: "not-started", submissionCount: 0 });
    expect(rows[1].documentVersions.map((item) => item.id)).toEqual(["failed-version"]);
  });

  it("keeps omitted archive bodies unknown as in includeSourceHtml:false classroom projections", () => {
    const row = deriveProjectPracticeRows(course({ projectDocumentVersions: [{
      id: "archive", courseId: "classroom", studentId: "s1", stageKey: "make", submissionId: "archived-draft", sequence: 1, sourceVersion: 1,
      title: "实际正文未进入课堂投影", sourceHtml: "", docxUploadId: "word-file", status: "submitted", createdAt: at(1), submittedAt: at(1),
    }] }))[0];
    expect(row).toMatchObject({ progressState: "submitted", contentCharacters: 0, contentCharactersKnown: false, submissionCount: 1 });
    const current = deriveProjectPracticeRows(course({ submissions: [artifact("current", { content: "<p><br></p>" })] }))[0];
    expect(current).toMatchObject({ progressState: "not-started", contentCharacters: 0, contentCharactersKnown: true });
    const noWriting = deriveProjectPracticeRows(course({ aiInteractionEvents: [event("dialogue-only")] }))[0];
    expect(noWriting).toMatchObject({ progressState: "not-started", contentCharacters: 0, contentCharactersKnown: true });
    const receiptOnly = deriveProjectPracticeRows(course({ aiInteractionEvents: [event("receipt", {
      source: "submission", eventType: "submit", payload: { versionId: "code-archive", submissionId: "missing-code" },
    })] }))[0];
    expect(receiptOnly).toMatchObject({ progressState: "submitted", contentCharacters: 0, contentCharactersKnown: false });
  });

  it("retains formal submissions when a newer working draft exists and supports group artifacts", () => {
    const rows = deriveProjectPracticeRows(course({
      groups: [{ id: "group", members: [{ studentId: "s2" }] }] as Course["groups"],
      submissions: [artifact("submitted", { status: "submitted" }), artifact("latest", { updatedAt: at(3) }),
        artifact("group", { studentId: undefined, groupId: "group", files: [{ name: "作品.zip", type: "application/zip" }] })],
    }));
    expect(rows[0]).toMatchObject({ artifact: { id: "latest" }, submitted: true, hasDraft: true });
    expect(rows[1]).toMatchObject({ artifact: { id: "group" }, submitted: false, hasDraft: true, progressState: "in-progress" });
  });

  it("accepts legacy submissions without a classroom ID but excludes explicit foreign submissions", () => {
    const rows = deriveProjectPracticeRows(course({ submissions: [
      artifact("legacy", { courseId: undefined } as unknown as Partial<ClassroomSubmission>),
      artifact("foreign", { courseId: "other", updatedAt: at(5) }),
    ] }));
    expect(rows[0]).toMatchObject({ artifact: { id: "legacy" }, hasDraft: true, submitted: false });
  });

  it.each(["document", "python", "c"] as const)("uses the document/code workspace events in %s mode", (makeArtifactMode) => {
    const rows = deriveProjectPracticeRows(course({
      pblConfig: { makeArtifactMode } as Course["pblConfig"],
      submissions: [artifact("external-brief", { type: "artifact-brief", updatedAt: at(1) }), artifact("code", { type: "code" })],
      aiInteractionEvents: [event("work"), event("external", { payload: { workspaceKind: "external-artifact" } })],
    }));
    expect(rows[0].artifact?.id).toBe("code");
    expect(rows[0].aiEvents.map((item) => item.id)).toEqual(["work"]);
  });

  it("uses external workspace conversations and immutable outcome versions in other mode", () => {
    const rows = deriveProjectPracticeRows(course({
      pblConfig: { makeArtifactMode: "other" } as Course["pblConfig"],
      submissions: [artifact("external", { type: "artifact-brief" })],
      aiInteractionEvents: [event("work"), event("external", { payload: { workspaceKind: "external-artifact" } })],
      projectPdfVersions: [{ id: "outcome", courseId: "classroom", studentId: "s2", stageKey: "make", sequence: 1, title: "模型", uploadId: "upload", kind: "file", status: "submitted", createdAt: at(1), submittedAt: at(1) }],
    }));
    expect(rows[0]).toMatchObject({ artifact: { id: "external" }, submitted: false, hasDraft: true });
    expect(rows[0].aiEvents.map((item) => item.id)).toEqual(["external"]);
    expect(rows[1]).toMatchObject({ artifact: undefined, submitted: true, hasDraft: true });
  });

  it("recovers saved dialogue without duplicating audited messages or accepting another classroom", () => {
    const rows = deriveProjectPracticeRows(course({
      aiInteractionEvents: [event("audit", { conversationId: "conversation", content: "问题" }),
        event("old-snapshot", { courseId: undefined, studentId: "s2" } as unknown as Partial<AiInteractionEvent>),
        event("foreign", { courseId: "other" }), event("unknown", { studentId: "unknown" }), event("wrong-stage", { stageKey: "showcase" })],
      companionThreads: [{ id: "thread", courseId: "classroom", studentId: "s1", stageKey: "ai-code-collaboration:make:python", createdAt: at(0), updatedAt: at(1), messages: [
        { id: "question", role: "student", conversationId: "conversation", content: "问题", createdAt: at(0), visibility: "student-and-teacher" },
        { id: "answer", role: "agent", conversationId: "conversation", content: "回答", createdAt: at(1), visibility: "student-and-teacher" },
      ] }, { id: "foreign-thread", courseId: "other", studentId: "s1", stageKey: "ai-collaboration:make", createdAt: at(0), updatedAt: at(1), messages: [
        { id: "foreign-message", role: "student", content: "不应出现", createdAt: at(0), visibility: "student-and-teacher" },
      ] }],
    }));
    expect(rows[0].aiEvents.map((item) => item.id)).toEqual(["audit", "thread:answer"]);
    expect(rows[0].turns[0].messages.map((message) => message.content)).toEqual(["问题", "回答"]);
    expect(rows[0]).toMatchObject({ artifact: undefined, submitted: false, hasDraft: false, dialogueRounds: 1 });
    expect(rows[1].aiEvents.map((item) => item.id)).toEqual(["old-snapshot"]);
  });

  it.each([
    ["document", "<p><br></p>"],
    ["document", "<p>&nbsp; &#160; &#x200b;</p><script>hidden()</script><style>body { color: red }</style>"],
    ["document", "<p data-placeholder=\"请填写\"></p><template>不可见模板</template>"],
    ["artifact-brief", "<p> </p>"],
    ["code", "{}"],
    ["code", JSON.stringify({ version: 1, language: "python", files: [] })],
    ["code", JSON.stringify({ version: 1, language: "python", files: [{ id: "main", path: "main.py", content: " \n\t " }] })],
  ] as const)("does not treat an empty %s shell or AI dialogue as writing", (type, content) => {
    const row = deriveProjectPracticeRows(course({
      pblConfig: { makeArtifactMode: "other" } as Course["pblConfig"],
      submissions: [artifact("empty", { type, content })],
      aiInteractionEvents: [event("question", { payload: { workspaceKind: "external-artifact" } })],
    }))[0];
    expect(row).toMatchObject({ progressState: "not-started", contentCharacters: 0, submissionCount: 0, submitted: false, hasDraft: false, participating: true });
  });

  it("counts visible Unicode document text and actual code rather than markup or JSON metadata", () => {
    const document = deriveProjectPracticeRows(course({ submissions: [artifact("text", {
      content: "<p title=\"属性不计入\">你 好 &amp; &#x1F600;</p><!--注释--><script>hidden()</script>",
    })] }))[0];
    expect(document).toMatchObject({ progressState: "in-progress", contentCharacters: 4, submissionCount: 0 });
    const code = deriveProjectPracticeRows(course({ submissions: [artifact("code", { type: "code", content: JSON.stringify({
      version: 1, language: "python", files: [{ id: "main", path: "main.py", content: "x = 1\n" }, { id: "extra", path: "extra.py", content: "y = 2" }],
    }) })] }))[0];
    expect(code).toMatchObject({ progressState: "in-progress", contentCharacters: 6, submissionCount: 0 });
    const brief = deriveProjectPracticeRows(course({ pblConfig: { makeArtifactMode: "other" } as Course["pblConfig"], submissions: [artifact("brief", { type: "artifact-brief", content: "<p>模型说明</p>" })] }))[0];
    expect(brief).toMatchObject({ progressState: "in-progress", contentCharacters: 4 });
  });

  it("treats valid draft uploads as work in progress without inventing a formal submission", () => {
    const rows = deriveProjectPracticeRows(course({ submissions: [
      artifact("placeholder", { content: "", files: [{ name: "未完成.zip", type: "application/zip" }] }),
      artifact("uploaded", { studentId: "s2", content: "", files: [{ name: "材料.zip", type: "application/zip", url: "/api/uploads/asset" }] }),
    ] }));
    expect(rows[0]).toMatchObject({ progressState: "not-started", contentCharacters: 0, submissionCount: 0 });
    expect(rows[1]).toMatchObject({ progressState: "in-progress", contentCharacters: 0, submissionCount: 0, submitted: false });
  });

  it.each(["document", "artifact-brief"] as const)("counts real uploaded images in %s as work without inventing text characters", (type) => {
    const input = (content: string) => course({ pblConfig: { makeArtifactMode: "other" } as Course["pblConfig"], submissions: [artifact("image", { type, content })] });
    expect(deriveProjectPracticeRows(input('<p><img src="/api/uploads/12345678-1234-1234-1234-123456789abc" /></p>'))[0])
      .toMatchObject({ progressState: "in-progress", contentCharacters: 0, contentCharactersKnown: true, submissionCount: 0 });
    for (const content of ['<p><img src="" /></p>', '<img data-placeholder="image" />', '<img src="data:image/gif;base64,placeholder" />', '<!-- <img src="/api/uploads/hidden" /> -->']) {
      expect(deriveProjectPracticeRows(input(content))[0]).toMatchObject({ progressState: "not-started", contentCharacters: 0, contentCharactersKnown: true });
    }
  });

  it("counts successful immutable versions once across projections while ongoing revisions stay submitted", () => {
    const documents: NonNullable<Course["projectDocumentVersions"]> = [
      { id: "v1", courseId: "classroom", studentId: "s1", stageKey: "make", submissionId: "work", sequence: 1, sourceVersion: 1, title: "第一版", sourceHtml: "原稿", status: "submitted", requestId: "r1", submittedAt: at(1), createdAt: at(1) },
      { id: "v2", courseId: "classroom", studentId: "s1", stageKey: "make", submissionId: "work", sequence: 2, sourceVersion: 3, title: "第二版", sourceHtml: "修订稿", status: "submitted", requestId: "r2", submittedAt: at(3), createdAt: at(3) },
      { id: "processing", courseId: "classroom", studentId: "s1", stageKey: "make", submissionId: "work", sequence: 3, sourceVersion: 5, title: "处理中", sourceHtml: "未成功", status: "processing", createdAt: at(5) },
      { id: "failed", courseId: "classroom", studentId: "s1", stageKey: "make", submissionId: "work", sequence: 4, sourceVersion: 6, title: "失败", sourceHtml: "失败稿", status: "failed", createdAt: at(6) },
    ];
    const source = course({ projectDocumentVersions: [...documents, documents[0]],
      submissions: [artifact("work", { status: "submitted", version: 4, submittedAt: at(3), updatedAt: at(4) })],
      projectPdfVersions: [
        { id: "v2", courseId: "classroom", studentId: "s1", stageKey: "make", sequence: 2, title: "重复投影", uploadId: "same", status: "submitted", submittedAt: at(3), createdAt: at(3), requestId: "r2" },
        { id: "file", courseId: "classroom", studentId: "s1", stageKey: "make", sequence: 1, kind: "file", title: "附件", uploadId: "file", status: "submitted", submittedAt: at(4), createdAt: at(4) },
      ],
    });
    expect(deriveProjectPracticeRows(source)[0]).toMatchObject({ progressState: "submitted", submissionCount: 3, submitted: true });
    source.submissions = [artifact("work", { status: "draft", version: 5, content: "<p>继续迭代的新稿</p>", updatedAt: at(7) })];
    expect(deriveProjectPracticeRows(source)[0]).toMatchObject({ progressState: "submitted", submissionCount: 3, submitted: true, contentCharacters: 7 });
  });

  it("recovers successful code submissions from committed audit receipts after the current draft changes", () => {
    const row = deriveProjectPracticeRows(course({
      submissions: [artifact("code", { type: "code", status: "draft", content: JSON.stringify({ version: 1, language: "python", files: [{ id: "main", path: "main.py", content: "x = 2" }] }) })],
      aiInteractionEvents: [
        event("submit", { eventType: "submit", source: "submission", requestId: "success", payload: { versionId: "code-v1", submissionId: "code", sourceVersion: 1, submissionVersion: 2, submittedAt: at(1) } }),
        event("replayed-submit", { eventType: "submit", source: "submission", requestId: "success", payload: { versionId: "code-v1", submissionId: "code", sourceVersion: 1, submissionVersion: 2, submittedAt: at(1) } }),
        event("unconfirmed", { eventType: "submit", payload: { status: "processing", versionId: "not-success" } }),
      ],
    }))[0];
    expect(row).toMatchObject({ progressState: "submitted", submissionCount: 1, submitted: true, contentCharacters: 3 });
  });

  it("deduplicates proposal/request/decision aliases and gives the latest durable choice priority", () => {
    const decisions = derivePracticeDecisions(course({
      aiInteractionEvents: [proposal(), event("event-decision", { requestId: "request", eventType: "decision", payload: { decision: "adopted" }, createdAt: at(5) }),
        event("duplicate", { requestId: "request", eventType: "decision", payload: { decision: "adopted", contributionId: "suggestion" } })],
      studentAiDecisions: [durable("older", { decidedAt: at(1) }), durable("latest", { decision: "modified", decidedAt: at(2), reason: "修改后采用" }),
        durable("foreign", { courseId: "other" }), durable("unknown", { studentId: "unknown" }), durable("wrong-stage", { stageKey: "showcase" })],
    }));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ key: "s1:suggestion", contributionId: "suggestion", decision: "modified", updatedAt: at(2), title: "补充依据", targetText: "原文", replacement: "修改后正文", summary: "修改后采用" });
  });

  it("keeps rejected, returned, undone and undecided suggestions distinct", () => {
    const decisions = derivePracticeDecisions(course({
      aiInteractionEvents: [proposal(), proposal({ id: "pending", requestId: "pending", payload: { contributionId: "pending", deliverable: { title: "待审阅交付", content: "交付正文", documentActions: [{ operation: "append" }] } } }),
        event("revision", { eventType: "decision", requestId: "revision", payload: { contributionId: "revision", decision: "rejected", reason: "revision" } }),
        event("undo", { eventType: "undo", payload: { contributionId: "suggestion" }, createdAt: at(3) })],
      studentAiDecisions: [durable("adopted"), durable("revision-durable", { contributionId: "returned", decision: "rejected", reason: "学生审阅后退回修改" }),
        durable("undo-durable", { contributionId: "restored", decision: "rejected", reason: "学生使用撤销恢复原文" }),
        durable("rejected", { contributionId: "rejected", decision: "rejected", reason: "保留原文" })],
    }));
    expect(Object.fromEntries(decisions.map((item) => [item.contributionId, item.decision]))).toEqual({
      suggestion: "undone", pending: "pending", revision: "revision", returned: "revision", restored: "undone", rejected: "rejected",
    });
    expect(decisions.find((item) => item.contributionId === "pending")).toMatchObject({ title: "待审阅交付", replacement: "交付正文", documentActions: [{ operation: "append" }] });
  });

  it("uses the latest persisted undo and later re-adoption without rewriting the source records", () => {
    const source = course({
      aiInteractionEvents: [proposal(), event("undo", { eventType: "undo", conversationId: "conversation", payload: { contributionId: "suggestion" }, createdAt: at(3) })],
      studentAiDecisions: [durable("undo", { decision: "rejected", reason: "学生使用撤销", decidedAt: at(3) }), durable("original", { decidedAt: at(1) })],
    });
    expect(derivePracticeDecisions(source)[0].decision).toBe("undone");
    source.studentAiDecisions!.push(durable("readopted", { decision: "modified", decidedAt: at(5) }));
    const snapshot = JSON.stringify(source);
    expect(derivePracticeDecisions(source)[0].decision).toBe("modified");
    const modification = deriveProjectPracticeRows(source)[0].turns[0].messages[0].modification;
    expect(modification).toMatchObject({ decision: "modified", decisionAt: at(5) });
    expect(modification?.undoneAt).toBeUndefined();
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it("shows recent conversations first, retains chronological messages and applies durable state to edits", () => {
    const rows = deriveProjectPracticeRows(course({
      aiInteractionEvents: [proposal({ conversationId: "older", createdAt: at(1) }),
        event("old-question", { conversationId: "older", createdAt: at(0) }),
        event("new-question", { conversationId: "newer", createdAt: at(4) }),
        event("new-answer", { conversationId: "newer", actorRole: "ai", eventType: "response", createdAt: at(5) })],
      studentAiDecisions: [durable("undo", { decision: "rejected", reason: "学生使用撤销", decidedAt: at(3) })],
    }));
    expect(rows[0].turns.map((turn) => turn.conversationId)).toEqual(["newer", "older"]);
    expect(rows[0].turns[1].messages.map((message) => message.id)).toEqual(["old-question", "proposal"]);
    expect(rows[0].turns[1].messages[1].modification).toMatchObject({ targetText: "原文", replacement: "修改后正文", decision: "undone", undoneAt: at(3) });
  });

  it("counts participation from student requests or completed decisions, excluding pending AI proposals", () => {
    const rows = deriveProjectPracticeRows(course({
      aiInteractionEvents: [proposal(), event("question", { studentId: "s2" })],
    }));
    expect(rows.map((row) => row.participating)).toEqual([false, true]);
    const decided = deriveProjectPracticeRows(course({ aiInteractionEvents: [proposal()], studentAiDecisions: [durable("decision")] }));
    expect(decided[0].participating).toBe(true);
  });

  it("counts real requests and boundary operations once per student, separately from proactive comments", () => {
    const events = [event("request-1", { requestId: "shared" }), event("duplicate", { requestId: "shared" }),
      event("other-student", { studentId: "s2", requestId: "shared" }),
      event("comment", { source: "proactive-comment", eventType: "comment", actorRole: "ai", conversationId: "comment" }),
      event("boundary", { eventType: "response", actorRole: "ai", requestId: "shared", payload: { kind: "boundary" } }),
      event("policy", { eventType: "policy", actorRole: "system", requestId: "shared", payload: { protectedCapability: "方案" } }),
      event("other-boundary", { studentId: "s2", eventType: "response", actorRole: "ai", requestId: "shared", payload: { kind: "boundary" } })];
    expect(deriveAiCollaborationMetrics(events)).toMatchObject({ dialogueRounds: 2, boundaryTriggers: 2, proactiveSuggestions: 1 });
  });
});
