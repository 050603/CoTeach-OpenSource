import { describe, expect, it } from "vitest";
import {
  actorRoleLabel,
  courseResourceTypeLabel,
  feedbackKindLabel,
  isOpaqueInternalId,
  submissionTypeLabel,
  userFacingName,
  userFacingStageLabel,
} from "./user-facing-labels";

describe("user-facing labels", () => {
  it("translates internal enums into readable labels", () => {
    expect(userFacingStageLabel("ai-learning")).toBe("知识讲授");
    expect(feedbackKindLabel("revision")).toBe("修改建议");
    expect(submissionTypeLabel("plan")).toBe("项目方案");
    expect(submissionTypeLabel("code")).toBe("代码成果");
    expect(actorRoleLabel("system-trigger")).toBe("系统提醒");
  });

  it("normalizes resource MIME types without exposing raw MIME strings", () => {
    expect(courseResourceTypeLabel("application/pdf")).toBe("PDF");
    expect(courseResourceTypeLabel("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("Word");
    expect(courseResourceTypeLabel("application/x-unknown")).toBe("文件");
  });

  it("recognizes opaque runtime references", () => {
    expect(isOpaqueInternalId("prereq-1")).toBe(true);
    expect(isOpaqueInternalId("re_iSXGxKNK_b-R_iSPtL")).toBe(true);
    expect(isOpaqueInternalId("识别数据类型")).toBe(false);
    expect(userFacingName("scene-runtime-1", "课程页面")).toBe("课程页面");
  });
});
