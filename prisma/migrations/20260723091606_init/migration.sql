-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "hours" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "drivingQuestion" TEXT NOT NULL,
    "learningObjectives" JSONB,
    "expectedOutcome" TEXT,
    "learnerProfile" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currentStageIndex" INTEGER NOT NULL DEFAULT 0,
    "inviteCode" TEXT,
    "coverImageUrl" TEXT,
    "presentingGroupId" TEXT,
    "classConfig" JSONB,
    "pblConfig" JSONB,
    "stageWorkspacePolicies" JSONB,
    "content" JSONB,
    "stages" JSONB,
    "uiState" JSONB,
    "aiLearningProgress" JSONB,
    "aiLearningClassroomId" TEXT,
    "teacherClassroomId" TEXT,
    "resolvedInterventionSignalIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseSession" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "archivedData" JSONB NOT NULL,
    "studentCount" INTEGER NOT NULL DEFAULT 0,
    "submissionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourseSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lastSeenAt" TEXT,
    "progress" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassroomSubmission" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "studentName" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "groupId" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submittedAt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ClassroomSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherFeedback" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT,
    "groupId" TEXT,
    "stageKey" TEXT,
    "content" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TeacherFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RubricScore" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "groupId" TEXT,
    "stageKey" TEXT,
    "criteria" JSONB NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "RubricScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReflectionRecord" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "studentName" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ReflectionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityRecord" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "stageKey" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ActivityRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseAnnouncement" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "replies" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CourseAnnouncement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseTodo" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "stageKey" TEXT,
    "completedBy" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CourseTodo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseResource" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT,
    "downloadedBy" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CourseResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectGroup" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "goal" TEXT,
    "keywords" JSONB NOT NULL DEFAULT '[]',
    "selectedForms" JSONB NOT NULL DEFAULT '[]',
    "members" JSONB NOT NULL DEFAULT '[]',
    "proposal" JSONB,
    "teacherApproval" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ProjectGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupAnnouncement" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "GroupAnnouncement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkPlanItem" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "memberName" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "WorkPlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhiteboardNode" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "note" TEXT,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "WhiteboardNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupBoard" (
    "groupId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'mindmap',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "GroupBoard_pkey" PRIMARY KEY ("courseId","groupId")
);

-- CreateTable
CREATE TABLE "CourseUpload" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "groupId" TEXT,
    "studentId" TEXT,
    "studentName" TEXT,
    "stageKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CourseUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamContribution" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "studentId" TEXT,
    "studentName" TEXT NOT NULL,
    "percent" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TeamContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSupportRecord" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "groupId" TEXT,
    "studentId" TEXT,
    "studentName" TEXT,
    "kind" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "inputSummary" TEXT NOT NULL,
    "diagnosis" TEXT NOT NULL,
    "suggestions" JSONB NOT NULL DEFAULT '[]',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT,
    "editedContent" TEXT,
    "structuredPayload" JSONB,
    "adoption" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AiSupportRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherIntervention" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT,
    "groupId" TEXT,
    "stageKey" TEXT,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TeacherIntervention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningSignal" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "sceneId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "content" JSONB,
    "normalizedIssueKey" TEXT NOT NULL,
    "evidenceEventIds" JSONB NOT NULL DEFAULT '[]',
    "aiInterventionAttempts" INTEGER NOT NULL DEFAULT 0,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL,
    "handledAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "LearningSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassCommonIssue" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "affectedStudentIds" JSONB NOT NULL DEFAULT '[]',
    "thresholdMetAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ClassCommonIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherAgentDirective" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "targetId" TEXT,
    "stageKey" TEXT,
    "goal" TEXT NOT NULL,
    "content" TEXT,
    "constraints" JSONB,
    "issuedBy" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TeacherAgentDirective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineInterventionRecord" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT,
    "stageKey" TEXT,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "teacherName" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "OfflineInterventionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DynamicFacilitationScaffold" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "framework" JSONB NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DynamicFacilitationScaffold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageTransitionRecord" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "fromStageKey" TEXT NOT NULL,
    "toStageKey" TEXT NOT NULL,
    "gateStatus" TEXT NOT NULL,
    "blockers" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "overrideReason" TEXT,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "StageTransitionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationRecord" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT,
    "groupId" TEXT,
    "stageKey" TEXT,
    "kind" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "content" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "EvaluationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningEvent" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "sceneId" TEXT,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER,
    "expectedDurationSec" INTEGER,
    "ttsDurationSec" INTEGER,
    "plannedStudentActivitySec" INTEGER,
    "visible" BOOLEAN,
    "progressMarker" TEXT,
    "content" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "LearningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanionThread" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "openingSentAt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CompanionThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanionTask" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "companionId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" TEXT,
    "error" TEXT,
    "confirmationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CompanionTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanionConfirmation" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "taskId" TEXT,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CompanionConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanionProcessRecord" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "companionId" TEXT,
    "taskId" TEXT,
    "evidenceIds" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CompanionProcessRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionMeta" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "joinedCourseId" TEXT,
    "userRole" TEXT,
    "userName" TEXT,
    "studentId" TEXT,
    "studentName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SessionMeta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadFile" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "courseId" TEXT,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "referencedBy" JSONB NOT NULL DEFAULT '[]',
    "refCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "UploadFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Teacher" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "Teacher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentAccount" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "studentName" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "StudentAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Course_inviteCode_key" ON "Course"("inviteCode");

-- CreateIndex
CREATE INDEX "Course_status_idx" ON "Course"("status");

-- CreateIndex
CREATE INDEX "Course_updatedAt_idx" ON "Course"("updatedAt");

-- CreateIndex
CREATE INDEX "CourseSession_courseId_startedAt_idx" ON "CourseSession"("courseId", "startedAt");

-- CreateIndex
CREATE INDEX "Student_courseId_idx" ON "Student"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_courseId_id_key" ON "Student"("courseId", "id");

-- CreateIndex
CREATE INDEX "ClassroomSubmission_courseId_studentId_idx" ON "ClassroomSubmission"("courseId", "studentId");

-- CreateIndex
CREATE INDEX "ClassroomSubmission_courseId_stageKey_idx" ON "ClassroomSubmission"("courseId", "stageKey");

-- CreateIndex
CREATE UNIQUE INDEX "ClassroomSubmission_courseId_id_key" ON "ClassroomSubmission"("courseId", "id");

-- CreateIndex
CREATE INDEX "TeacherFeedback_courseId_studentId_idx" ON "TeacherFeedback"("courseId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherFeedback_courseId_id_key" ON "TeacherFeedback"("courseId", "id");

-- CreateIndex
CREATE INDEX "RubricScore_courseId_studentId_idx" ON "RubricScore"("courseId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "RubricScore_courseId_id_key" ON "RubricScore"("courseId", "id");

-- CreateIndex
CREATE INDEX "ReflectionRecord_courseId_studentId_idx" ON "ReflectionRecord"("courseId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "ReflectionRecord_courseId_id_key" ON "ReflectionRecord"("courseId", "id");

-- CreateIndex
CREATE INDEX "ActivityRecord_courseId_occurredAt_idx" ON "ActivityRecord"("courseId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityRecord_courseId_id_key" ON "ActivityRecord"("courseId", "id");

-- CreateIndex
CREATE INDEX "CourseAnnouncement_courseId_createdAt_idx" ON "CourseAnnouncement"("courseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CourseAnnouncement_courseId_id_key" ON "CourseAnnouncement"("courseId", "id");

-- CreateIndex
CREATE INDEX "CourseTodo_courseId_idx" ON "CourseTodo"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "CourseTodo_courseId_id_key" ON "CourseTodo"("courseId", "id");

-- CreateIndex
CREATE INDEX "CourseResource_courseId_idx" ON "CourseResource"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "CourseResource_courseId_id_key" ON "CourseResource"("courseId", "id");

-- CreateIndex
CREATE INDEX "ProjectGroup_courseId_idx" ON "ProjectGroup"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGroup_courseId_id_key" ON "ProjectGroup"("courseId", "id");

-- CreateIndex
CREATE INDEX "GroupAnnouncement_courseId_groupId_idx" ON "GroupAnnouncement"("courseId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupAnnouncement_courseId_id_key" ON "GroupAnnouncement"("courseId", "id");

-- CreateIndex
CREATE INDEX "WorkPlanItem_courseId_groupId_idx" ON "WorkPlanItem"("courseId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkPlanItem_courseId_id_key" ON "WorkPlanItem"("courseId", "id");

-- CreateIndex
CREATE INDEX "WhiteboardNode_courseId_groupId_idx" ON "WhiteboardNode"("courseId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "WhiteboardNode_courseId_id_key" ON "WhiteboardNode"("courseId", "id");

-- CreateIndex
CREATE INDEX "GroupBoard_courseId_idx" ON "GroupBoard"("courseId");

-- CreateIndex
CREATE INDEX "CourseUpload_courseId_studentId_idx" ON "CourseUpload"("courseId", "studentId");

-- CreateIndex
CREATE INDEX "CourseUpload_courseId_stageKey_idx" ON "CourseUpload"("courseId", "stageKey");

-- CreateIndex
CREATE UNIQUE INDEX "CourseUpload_courseId_id_key" ON "CourseUpload"("courseId", "id");

-- CreateIndex
CREATE INDEX "TeamContribution_courseId_groupId_idx" ON "TeamContribution"("courseId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamContribution_courseId_id_key" ON "TeamContribution"("courseId", "id");

-- CreateIndex
CREATE INDEX "AiSupportRecord_courseId_targetId_idx" ON "AiSupportRecord"("courseId", "targetId");

-- CreateIndex
CREATE INDEX "AiSupportRecord_courseId_stageKey_idx" ON "AiSupportRecord"("courseId", "stageKey");

-- CreateIndex
CREATE UNIQUE INDEX "AiSupportRecord_courseId_id_key" ON "AiSupportRecord"("courseId", "id");

-- CreateIndex
CREATE INDEX "TeacherIntervention_courseId_studentId_idx" ON "TeacherIntervention"("courseId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherIntervention_courseId_id_key" ON "TeacherIntervention"("courseId", "id");

-- CreateIndex
CREATE INDEX "LearningSignal_courseId_studentId_status_idx" ON "LearningSignal"("courseId", "studentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LearningSignal_courseId_id_key" ON "LearningSignal"("courseId", "id");

-- CreateIndex
CREATE INDEX "ClassCommonIssue_courseId_stageKey_idx" ON "ClassCommonIssue"("courseId", "stageKey");

-- CreateIndex
CREATE UNIQUE INDEX "ClassCommonIssue_courseId_id_key" ON "ClassCommonIssue"("courseId", "id");

-- CreateIndex
CREATE INDEX "TeacherAgentDirective_courseId_scope_targetId_idx" ON "TeacherAgentDirective"("courseId", "scope", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherAgentDirective_courseId_id_key" ON "TeacherAgentDirective"("courseId", "id");

-- CreateIndex
CREATE INDEX "OfflineInterventionRecord_courseId_occurredAt_idx" ON "OfflineInterventionRecord"("courseId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineInterventionRecord_courseId_id_key" ON "OfflineInterventionRecord"("courseId", "id");

-- CreateIndex
CREATE INDEX "DynamicFacilitationScaffold_courseId_stageKey_idx" ON "DynamicFacilitationScaffold"("courseId", "stageKey");

-- CreateIndex
CREATE UNIQUE INDEX "DynamicFacilitationScaffold_courseId_id_key" ON "DynamicFacilitationScaffold"("courseId", "id");

-- CreateIndex
CREATE INDEX "StageTransitionRecord_courseId_createdAt_idx" ON "StageTransitionRecord"("courseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StageTransitionRecord_courseId_id_key" ON "StageTransitionRecord"("courseId", "id");

-- CreateIndex
CREATE INDEX "EvaluationRecord_courseId_studentId_idx" ON "EvaluationRecord"("courseId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationRecord_courseId_id_key" ON "EvaluationRecord"("courseId", "id");

-- CreateIndex
CREATE INDEX "LearningEvent_courseId_studentId_occurredAt_idx" ON "LearningEvent"("courseId", "studentId", "occurredAt");

-- CreateIndex
CREATE INDEX "LearningEvent_courseId_type_idx" ON "LearningEvent"("courseId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "LearningEvent_courseId_id_key" ON "LearningEvent"("courseId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LearningEvent_courseId_idempotencyKey_key" ON "LearningEvent"("courseId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CompanionThread_courseId_studentId_stageKey_idx" ON "CompanionThread"("courseId", "studentId", "stageKey");

-- CreateIndex
CREATE UNIQUE INDEX "CompanionThread_courseId_id_key" ON "CompanionThread"("courseId", "id");

-- CreateIndex
CREATE INDEX "CompanionTask_courseId_studentId_status_idx" ON "CompanionTask"("courseId", "studentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CompanionTask_courseId_id_key" ON "CompanionTask"("courseId", "id");

-- CreateIndex
CREATE INDEX "CompanionConfirmation_courseId_studentId_status_idx" ON "CompanionConfirmation"("courseId", "studentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CompanionConfirmation_courseId_id_key" ON "CompanionConfirmation"("courseId", "id");

-- CreateIndex
CREATE INDEX "CompanionProcessRecord_courseId_studentId_createdAt_idx" ON "CompanionProcessRecord"("courseId", "studentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CompanionProcessRecord_courseId_id_key" ON "CompanionProcessRecord"("courseId", "id");

-- CreateIndex
CREATE INDEX "UploadFile_courseId_idx" ON "UploadFile"("courseId");

-- CreateIndex
CREATE INDEX "UploadFile_refCount_idx" ON "UploadFile"("refCount");

-- CreateIndex
CREATE UNIQUE INDEX "Teacher_username_key" ON "Teacher"("username");

-- CreateIndex
CREATE INDEX "Teacher_username_idx" ON "Teacher"("username");

-- CreateIndex
CREATE INDEX "StudentAccount_courseId_idx" ON "StudentAccount"("courseId");

-- CreateIndex
CREATE INDEX "StudentAccount_inviteCode_idx" ON "StudentAccount"("inviteCode");

-- CreateIndex
CREATE UNIQUE INDEX "StudentAccount_courseId_studentId_key" ON "StudentAccount"("courseId", "studentId");

-- AddForeignKey
ALTER TABLE "CourseSession" ADD CONSTRAINT "CourseSession_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomSubmission" ADD CONSTRAINT "ClassroomSubmission_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherFeedback" ADD CONSTRAINT "TeacherFeedback_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RubricScore" ADD CONSTRAINT "RubricScore_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReflectionRecord" ADD CONSTRAINT "ReflectionRecord_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRecord" ADD CONSTRAINT "ActivityRecord_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseAnnouncement" ADD CONSTRAINT "CourseAnnouncement_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseTodo" ADD CONSTRAINT "CourseTodo_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseResource" ADD CONSTRAINT "CourseResource_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectGroup" ADD CONSTRAINT "ProjectGroup_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupAnnouncement" ADD CONSTRAINT "GroupAnnouncement_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkPlanItem" ADD CONSTRAINT "WorkPlanItem_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhiteboardNode" ADD CONSTRAINT "WhiteboardNode_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBoard" ADD CONSTRAINT "GroupBoard_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseUpload" ADD CONSTRAINT "CourseUpload_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamContribution" ADD CONSTRAINT "TeamContribution_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSupportRecord" ADD CONSTRAINT "AiSupportRecord_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherIntervention" ADD CONSTRAINT "TeacherIntervention_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningSignal" ADD CONSTRAINT "LearningSignal_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassCommonIssue" ADD CONSTRAINT "ClassCommonIssue_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherAgentDirective" ADD CONSTRAINT "TeacherAgentDirective_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflineInterventionRecord" ADD CONSTRAINT "OfflineInterventionRecord_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DynamicFacilitationScaffold" ADD CONSTRAINT "DynamicFacilitationScaffold_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageTransitionRecord" ADD CONSTRAINT "StageTransitionRecord_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationRecord" ADD CONSTRAINT "EvaluationRecord_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanionThread" ADD CONSTRAINT "CompanionThread_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanionTask" ADD CONSTRAINT "CompanionTask_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanionConfirmation" ADD CONSTRAINT "CompanionConfirmation_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanionProcessRecord" ADD CONSTRAINT "CompanionProcessRecord_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
