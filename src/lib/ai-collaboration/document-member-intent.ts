import type { DocumentCollaborationIntent } from './document-policy';

/** Questions about material are discussion, not permission to author material. */
export function inferDocumentMemberIntent(request: string, selectedText?: string): DocumentCollaborationIntent {
  const value = request.replace(/\s+/g, '');
  if (/(?:怎么|怎样|如何|教我).{0,16}(?:检查|看看|看下).{0,16}(?:并|然后|顺便)(?:直接)?(?:修改|修正|纠正|润色)/.test(value)) return 'discuss';
  if (/(?:检查|看看|看下).{0,16}(?:并|然后|顺便)(?:直接)?(?:修改|修正|纠正|润色)/.test(value)
    && !/(?:不要|不用|不必|别)(?:直接)?(?:修改|修正|纠正|润色)/.test(value)) return selectedText ? 'edit' : 'delegate';
  if (selectedText && /(?:修正|改|润色|校对|重写|精简|扩写|调整表达|格式|纠正|统一|排版)/.test(value)
    && !/(?:怎么|怎样|如何|为什么|什么意思|是否|能不能)/.test(value)) return 'edit';
  // A request for a reviewable delivery still delegates work. Inspect the
  // positive instruction itself before ancillary words such as “审阅”; a
  // question about how to modify something is not an instruction to modify it.
  const explicitWork = value.split(/[，。；！？,:;!?]/).some(clause =>
    /^(?:(?:请)?(?:帮我|替我|帮我们|替我们|你来)|请(?:直接)?|直接|只|仅|先|再)?(?:整理|归纳|查找|检索|补充|制作|生成|写出|统一|修正|修改|改为|改成|调整|补齐|校对|润色|重写|纠正|排成|分组|排版|选定|评定|补成)/.test(clause)
    || /^(?:请)?(?:(?:帮我|替我|帮我们|替我们)(?:把|将)|把|将).{0,32}(?:排成|改为|改成|修正|统一|制作)/.test(clause));
  if (explicitWork && !/(?:怎么|怎样|如何|为什么|什么意思|能否|是否|能不能|可以吗)/.test(value)) return 'delegate';
  if (/(?:检查|审阅|哪里.{0,5}问题|哪里不|是否完整|是否可靠|是否一致|有没有.{0,5}(?:问题|夸大)|哪里有问题|(?:看看|看下|看一下).{0,30}(?:修改|改进|完善|问题)|(?:什么|哪些|哪里).{0,8}(?:可以|需要|能).{0,4}(?:修改|改进|完善))/.test(value)) return 'check';
  if (/(?:解释|讨论).{0,12}(?:概念|方法|思路)|(?:列出|提供|梳理).{0,10}(?:比较|分析|评价).{0,4}(?:维度|方法|步骤)/.test(value)) return 'discuss';
  const politeTask = /(?:能不能|能否|是否可以|可不可以|可以)(?:请)?(?:帮我|替我|帮我们|替我们)/.test(value);
  if (/(?:怎么|怎样|如何|为什么|什么意思|能否|是否|能不能|可以吗|可靠吗)/.test(value)
    && !politeTask && !/(?:请直接|直接替我|替我完成)/.test(value)) return 'discuss';
  if (/(?:总结|梳理进展|概括|完成和未完成|已完成和待完成)/.test(value)) return 'summarize';
  if (/^(?:我|我们)(?:想|希望|打算|准备)(?:要)?(?:做|写|制作|生成)/.test(value)
    && !/(?:帮我|替我|帮我们|替我们|请|你来|交给你)/.test(value)) return 'discuss';
  if (/(?:整理|归纳|查找|检索|补充|添加|插入|追加|列出|制作|生成|写|做|统一|修正|修改|改为|改成|改通顺|调整|补齐|校对|润色|精简|完善|重写|纠正|排成|分组|排版|选定|选择|评定|补成|补.{0,8}(?:份|数据|记录))/.test(value)
    || /(?:你来|交给你|辅助工作|帮我弄)/.test(value)) return 'delegate';
  return 'discuss';
}
