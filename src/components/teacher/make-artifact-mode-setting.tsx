"use client";

import { Check, ChevronDown, Code2, FileText, PackageOpen } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  normalizePblCourseConfig,
  type MakeArtifactMode,
} from "@/lib/pbl-course-config";
import type { Course } from "@/lib/session/types";
import { useSession } from "@/lib/session/store";

const MODE_LABEL: Record<MakeArtifactMode, string> = {
  document: "文档成果",
  other: "其他成果",
  python: "Python 代码",
  c: "C 语言代码",
};

function ModeCheck({ active }: { active: boolean }) {
  return active ? <Check className="ml-auto text-blue-700" size={14} /> : null;
}

export function MakeArtifactModeSetting({ course }: { course: Course }) {
  const { updateCourse } = useSession();
  const applied = normalizePblCourseConfig(course.pblConfig).makeArtifactMode;
  const CurrentIcon = applied === "other"
    ? PackageOpen
    : applied === "python" || applied === "c"
      ? Code2
      : FileText;

  function apply(nextMode: MakeArtifactMode) {
    if (nextMode === applied) return;
    updateCourse(course.id, {
      pblConfig: normalizePblCourseConfig({
        ...course.pblConfig,
        makeArtifactMode: nextMode,
      }),
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`选择项目实践成果形式，当前：${MODE_LABEL[applied]}`}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 text-xs font-semibold text-stone-700 shadow-sm transition hover:border-blue-300 hover:text-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          title="切换项目实践成果形式"
          type="button"
        >
          <CurrentIcon className="text-blue-700" size={14} />
          <span className="hidden text-stone-400 sm:inline">成果形式</span>
          <span>{MODE_LABEL[applied]}</span>
          <ChevronDown className="text-stone-400" size={13} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" sideOffset={8}>
        <DropdownMenuLabel className="px-2 py-2">
          <span className="block text-xs font-bold text-stone-900">项目实践成果形式</span>
          <span className="mt-0.5 block text-[10px] font-normal leading-4 text-stone-500">教师统一设置，学生进入对应的协作工作台</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="items-start py-2" onSelect={() => apply("document")}>
          <FileText className="mt-0.5" />
          <span className="min-w-0">
            <span className="block font-semibold">文档成果</span>
            <span className="block text-[10px] leading-4 text-stone-500">系统内富文本协作与提交</span>
          </span>
          <ModeCheck active={applied === "document"} />
        </DropdownMenuItem>
        <DropdownMenuItem className="items-start py-2" onSelect={() => apply("other")}>
          <PackageOpen className="mt-0.5" />
          <span className="min-w-0">
            <span className="block font-semibold">其他成果</span>
            <span className="block text-[10px] leading-4 text-stone-500">本地制作并上传最终文件</span>
          </span>
          <ModeCheck active={applied === "other"} />
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="py-2">
            <Code2 />
            <span className="font-semibold">代码成果</span>
            {applied === "python" || applied === "c" ? (
              <span className="ml-auto mr-1 text-[10px] font-semibold text-blue-700">{MODE_LABEL[applied]}</span>
            ) : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuItem className="py-2" onSelect={() => apply("python")}>
              <Code2 />
              <span>Python</span>
              <ModeCheck active={applied === "python"} />
            </DropdownMenuItem>
            <DropdownMenuItem className="py-2" onSelect={() => apply("c")}>
              <Code2 />
              <span>C 语言</span>
              <ModeCheck active={applied === "c"} />
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
