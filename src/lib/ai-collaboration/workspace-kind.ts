export type CollaborationWorkspaceKind = "document" | "external-artifact";

/**
 * Keep the two collaboration spaces deliberately separate.  The external
 * artifact workspace is a planning/progress proxy only: the local PPT, video,
 * code project, or design file is never available to the model until the
 * student explicitly uploads it as a version.
 */
export function normalizeCollaborationWorkspaceKind(value: unknown): CollaborationWorkspaceKind {
  return value === "external-artifact" ? "external-artifact" : "document";
}

export function collaborationWorkspaceInstruction(kind: CollaborationWorkspaceKind): string {
  if (kind !== "external-artifact") return "";
  return [
    "本轮协作载体是‘成果协作稿’，不是学生电脑中的最终本地成果。",
    "你无法看见、打开、读取或修改学生尚未上传的 PPT、视频、代码、设计稿或其他本地文件，也不要声称自己看过这些文件。",
    "你只能依据成果协作稿、课程要求、教师反馈以及学生在对话中明确提供的信息来回答；如需了解本地成果，先说明需要学生描述或上传相关版本。",
    "最终本地成果由学生在本机制作，并通过版本上传提交；不要把成果协作稿称为最终成果或最终文档。",
  ].join("\n");
}

export const EXTERNAL_ARTIFACT_COLLABORATION_TEMPLATE = [
  "<h1>成果协作稿</h1>",
  "<p>这不是最终上传的文件，而是帮助你和 AI 组员共同推进本地成果的工作稿。</p>",
  "<h2>成果目标与使用对象</h2>",
  "<p>我准备制作什么成果？希望谁使用或观看？做到什么程度算完成？</p>",
  "<h2>内容结构、脚本或功能组成</h2>",
  "<p>我的成果准备包含哪些部分？PPT 的页面、视频的段落、代码的模块或设计稿的主要区域分别是什么？</p>",
  "<h2>素材、资料与依据</h2>",
  "<p>我准备使用哪些资料、数据、素材或参考来源？哪些内容还需要核验？</p>",
  "<h2>当前制作进展</h2>",
  "<p>已经完成了什么？正在制作什么？最近做了哪些取舍或修改？</p>",
  "<h2>遇到的问题与下一步</h2>",
  "<p>目前最需要解决的问题是什么？下一步准备如何验证、制作或改进？</p>",
].join("");

export function isExternalArtifactWorkspace(kind?: string | null): boolean {
  return kind === "external-artifact";
}
