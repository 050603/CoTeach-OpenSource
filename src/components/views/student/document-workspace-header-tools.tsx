"use client";

import { useRef, useState } from "react";
import { FilePenLine, ShieldCheck } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function DocumentContentMonitorStatus({ notice }: { notice: string | null }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const restoringFocus = useRef(false);
  const description = <>
    <p className="font-semibold text-slate-900">AI 协作检查已开启</p>
    <p className="mt-2">教师已开启外部内容使用提醒：系统会检查较长的外部粘贴内容。系统 AI 内容与正常模板可豁免。</p>
    <p className="mt-2">提醒需人工核实，不代表内容由 AI 生成，不自动扣分，也不影响编辑和提交。</p>
    {notice && <p className="mt-2 text-amber-800" role="status">{notice}</p>}
  </>;

  return (
    <TooltipProvider delayDuration={200}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip open={!open && hovered} onOpenChange={setHovered}>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="AI 协作检查已开启，查看说明"
                onFocus={event => {
                  // Closing the click panel restores keyboard focus, without
                  // immediately opening a second layer over the toolbar.
                  if (restoringFocus.current) event.preventDefault();
                }}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-teal-700 transition hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                <ShieldCheck aria-hidden="true" size={16} />
                <span className="hidden sm:inline">AI 协作检查</span>
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="bottom" sideOffset={8} className="z-[80] max-w-[min(20rem,calc(100vw-2rem))] border border-slate-200 bg-white p-4 text-left text-xs leading-5 text-slate-600 shadow-lg [&>svg]:hidden">
            {description}
          </TooltipContent>
        </Tooltip>
        <PopoverContent align="end" sideOffset={8} aria-label="AI 协作检查说明" onCloseAutoFocus={() => {
          setHovered(false);
          restoringFocus.current = true;
          queueMicrotask(() => { restoringFocus.current = false; });
        }} className="z-[80] w-[min(20rem,calc(100vw-2rem))] border-slate-200 bg-white text-xs leading-5 text-slate-600">
          {description}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

export function DocumentRevisionNote({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500">
          <FilePenLine aria-hidden="true" size={14} />
          修改说明{value.trim() ? <span className="sr-only">（已填写）</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} aria-label="提交修改说明" className="z-[80] w-[min(24rem,calc(100vw-2rem))] border-slate-200 bg-white text-slate-700">
        <p className="text-sm font-semibold">提交修改说明（可选）</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">随最终版一起提交，帮助教师了解你的修改过程；不填写也可提交。</p>
        <label className="mt-3 block text-sm">
          本次改了什么，为什么这样改？
          <textarea aria-label="提交修改说明" className="mt-2 min-h-28 w-full resize-y rounded-md border border-slate-300 bg-white p-2 text-base outline-none focus:border-blue-500 sm:text-sm" maxLength={2000} value={value} onChange={event => onChange(event.target.value)} />
        </label>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">{value.length}/2000</span>
          <button type="button" className="min-h-11 rounded-md px-4 text-sm font-semibold text-blue-700 hover:bg-blue-50" onClick={() => setOpen(false)}>完成</button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
