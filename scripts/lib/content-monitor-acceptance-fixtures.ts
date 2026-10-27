/** Synthetic, fixed Chinese cases; no student text or classroom data. */
const task = "本项目研究校园食堂的食物浪费。学生需亲自确定调查问题，依据自己采集的连续五天剩餐记录分析主要原因，提出具体改进方案，并设计实施前后的对照评价方法。资料整理和空白记录表可借助AI，关键分析、方案论证和结论必须由学生完成。";
const answer = "我们的调查问题是：调整米饭的默认份量能否降低午餐时段的主食浪费？连续五天共记录了五百份午餐，其中一百六十份存在明显米饭剩余，说明固定份量与不同学生的食量之间可能存在不匹配。按照每百名用餐者的剩饭重量比较，初一学生组的浪费最多，不能仅因为初一人数较多就把差异解释为习惯问题。我们选择先提供较小份米饭，再允许学生免费添加，并把添饭处设在取餐路线的侧面，避免形成新的排队拥堵。实施前后分别观察五个工作日，记录用餐人数、菜品、剩饭重量和学生满意度，按每百人剩饭量进行比较。遇到考试、运动会或特别受欢迎的菜品时，应单独说明，不能把这些变化误当作方案效果。该方案不要求学生减少正常进食，而是减少一开始盛得过多的情况。我们的结论是，应通过份量选择和便捷添饭改善供需匹配，并依据对照记录决定是否推广；目前的数据只适用于被观察的食堂和时段，不能据此推断所有学校。";
const source = "【资料摘录，供后续讨论，不是本项目调查结果】某食堂管理手册指出，食物浪费可以从采购、储存、加工、分餐和消费等不同环节分析。在采购环节，需要留意需求预测与实际用餐人数的差异；在储存环节，应检查库存周转和保鲜条件；在加工环节，需要记录可食部分损失；在分餐环节，可以观察固定份量是否适应不同人群；在消费环节，则需区分口味偏好、就餐时间不足及取餐过量等原因。手册也提醒，单日的剩餐总重量不能直接反映管理措施优劣，因为就餐人数、菜单、天气和活动安排都可能影响数据。对于校园调查，可以借鉴这些观察维度，但不能把手册中的一般性解释写成本校调查发现。我们把这段文字放进参考资料区，之后会根据自己的问题选择记录项目，核对资料来源，并另写本校的数据分析。资料中的原因分类暂不构成我们的结论，也没有替我们选择最终方案。";
const template = "# 校园食堂调查报告模板\n一、研究问题\n研究问题：【填写自己确定的问题】\n调查对象：【填写对象】\n二、证据记录\n数据来源：待填写\n调查日期：待填写\n用餐人数：待填写\n剩餐重量：待填写\n三、分析过程\n主要发现：待填写\n可能的其他解释：待填写\n四、改进方案\n方案内容：待填写\n选择理由：待填写\n实施限制：待填写\n五、评价与反思\n评价方法：待填写\n对照条件：待填写\n项目局限：待填写\n后续问题：待填写";

export const CONTENT_MONITOR_ACCEPTANCE_CASES = [
  { id: "empty-template", expected: "unflagged", taskRequirements: task, pastedText: template, nearbyText: "报告刚开始，准备填写。", knownSources: [] },
  { id: "quotation-material", expected: "unflagged", taskRequirements: task, pastedText: source, nearbyText: "参考资料摘录，单独保留来源，分析部分尚未开始。", knownSources: [] },
  { id: "general-background", expected: "unflagged", taskRequirements: task, pastedText: source.replace("【资料摘录，供后续讨论，不是本项目调查结果】", "食堂管理背景知识："), nearbyText: "这里收集背景知识，尚未填写项目结果。", knownSources: [] },
  { id: "system-ai-full", expected: "exempt", taskRequirements: task, pastedText: answer, nearbyText: "", knownSources: [answer] },
  { id: "system-ai-partial", expected: "exempt", taskRequirements: task, pastedText: answer.slice(32, 260), nearbyText: "", knownSources: [answer] },
  { id: "system-ai-formatted", expected: "exempt", taskRequirements: task, pastedText: answer, nearbyText: "", knownSources: [`## 讨论记录\n\n**${answer}**`] },
  { id: "core-complete-answer", expected: "flagged", taskRequirements: task, pastedText: answer, nearbyText: "核心分析与最终方案：", knownSources: [] },
  { id: "filled-template", expected: "flagged", taskRequirements: task, pastedText: template + "\n已填好的分析与方案：\n" + answer, nearbyText: "准备提交的项目报告", knownSources: [] },
  { id: "mixed-ai-and-core", expected: "flagged", taskRequirements: task, pastedText: template + "\n" + answer, nearbyText: "核心分析与最终方案：", knownSources: [template] },
  { id: "unrelated-example", expected: "unflagged", taskRequirements: "学生需调查校园图书馆借阅排队问题，亲自收集排队时长并提出改进建议。", pastedText: answer, nearbyText: "下面只是另一个主题的完整案例，用来学习报告格式，不是我们的图书馆项目答案。", knownSources: [] },
  { id: "own-draft-context", expected: "unflagged", taskRequirements: task, pastedText: answer, nearbyText: "这是我根据昨天亲自整理的五天调查记录在Word中写好的草稿，现在搬回文档统一排版，原始记录保存在资料区。", knownSources: [] },
] as const;
