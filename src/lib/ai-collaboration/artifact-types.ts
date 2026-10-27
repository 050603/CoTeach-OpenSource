export type CollaborationArtifactType = "document" | "python" | "c";

export const COLLABORATION_ARTIFACT_TYPES = [
  {
    value: "document",
    label: "文档",
    description: "使用富文本文稿完成项目成果",
  },
  {
    value: "python",
    label: "Python",
    description: "使用 Python 文件完成代码成果",
  },
  {
    value: "c",
    label: "C 语言",
    description: "使用 C 源文件完成代码成果",
  },
] as const satisfies ReadonlyArray<{
  value: CollaborationArtifactType;
  label: string;
  description: string;
}>;

export function isCollaborationArtifactType(value: string | null): value is CollaborationArtifactType {
  return value === "document" || value === "python" || value === "c";
}

export function artifactTypeLabel(value: CollaborationArtifactType): string {
  return COLLABORATION_ARTIFACT_TYPES.find((item) => item.value === value)?.label ?? "文档";
}
