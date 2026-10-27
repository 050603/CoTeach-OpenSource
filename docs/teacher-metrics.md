# 教师端指标口径与来源

本清单用于核对当前教师端指标及兼容统计。百分比只在分母大于零且有可信来源时呈现；`—` 表示尚无可统计数据，零表示确实观察到零。显示时才舍入。课堂的“已进入本场”指该场 `ClassroomParticipation`，离线仍计入；教学班人数指当前 `ACTIVE` 或 `COMPLETED` 的 `Enrollment`。

| 指标 | 来源和统计范围 | 算法与去重 | 更新方式 | 核对测试 |
| --- | --- | --- | --- | --- |
| 教学班、已进入、在线人数 | `Enrollment`、本场 `ClassroomParticipation`、presence | 教学班过滤退班；本场按参与者计一次；在线只计当前 presence | 教学班接口、课堂投影、presence 轮询 | `student-records.test.ts`、`ai-learning-timing.test.ts` |
| 资料打开与完成 | 本场参与者、启动资料、学习事件及旧版 `downloadedBy` | 每人每资料取有效事件；完成按完成事件或达到阅读边界；旧下载只代表打开 | 课堂事件刷新投影 | `teacher-dashboard-metrics.test.ts` |
| AI 学习进度与分布 | 本场参与者、与当前课堂场景标识匹配的可信 `StudentAiProgress` | 已完成主课场景数／有效主课场景数；旧场景记录待核验单列；每人只落入一个 10% 区间 | 进度上报后课堂投影刷新 | `teacher-dashboard-metrics.test.ts`、`teacher-presentation-analytics.test.tsx` |
| 小测提交覆盖 | 本场参与者、各节首次有效提交 | 已提交的学生与章节组合／学生数×配置章节数；首次提交按 quiz outline 去重；待批阅仍计提交 | 小测提交后课堂投影刷新 | `knowledge-lecture.test.ts`、`teacher-dashboard-metrics.test.ts` |
| 小测正确率、得分率、章节均分 | 服务端核验并保存的逐题评分 | 客观正确率＝答对客观题／已批阅客观题；得分率＝有效得分／对应满分；章节均分＝该节学生有效得分率的算术平均。待批阅和旧版未核验分数不计 | 评分完成或重试后刷新 | `route.test.ts`、`teacher-dashboard-metrics.test.ts` |
| 知识点未达标率 | 服务端核验评分、知识点映射 | 本知识点任一关联题低于 80% 的去重学生／有效作答学生；当前课堂首次作答、题目去重，排除待评、失败、未核验及非法分数；不等于确定未掌握 | 小测评分刷新 | `knowledge-lecture.test.ts` |
| AI 学习时长与速度 | 本场完整 `LearningEvent`，不受最近 10,000 条明细限制 | 幂等键去重，只计可见且有效的心跳时长；预计时长按场景汇总 | 课堂投影刷新 | `ai-learning-timing.test.ts` |
| 项目实践推进状态 | 本场参与者、已保存正文／代码、有效上传及成功提交版本 | 每人互斥计入未开始、任务进行中或提交过成果；成功提交后继续修改仍计入提交过成果，版本次数另列 | 课堂投影刷新 | `project-practice-analytics.test.ts`、`teacher-project-analytics.test.tsx` |
| AI 协作人数、累计交互与建议处理 | 本场项目实践的 AI 审计事件、补全对话、作品贡献及学生决策 | 协作人数按主动对话或处理建议的学生去重；累计交互按学生及 `requestId` 去重，无请求标识时使用事件 ID，回复不另计。建议决定按稳定身份合并，区分采纳、修改、未采纳、退回、撤销及待决定 | 课堂投影刷新 | `project-practice-analytics.test.ts`、`project-collaboration-transcript.test.tsx` |
| 项目实践需关注与外部待核实 | 开放学习信号、AI 边界事件、文档模式的外部内容提醒 | 需关注人数按学生去重；每生外部待核实数量读取全部记录的聚合，不从当前分页推断零，已排除提醒不计入。提醒须由教师核实，不作为违规结论或 AI 协作记录 | 课堂投影及外部提醒接口刷新 | `teacher-project-analytics.test.tsx`、`content-monitor-service.test.ts` |
| 大屏成果列表的提交次数与正文大小 | 本场参与者、成功提交版本和最新保存稿 | 成功 Word／上传版本按 ID 计数，关联的成果提交不重复计算；保存草稿、处理中和失败不算提交。字数取当前稿正文（无当前稿时取最新成功 Word 版本），去除 HTML 和空白；代码按源文件行数统计，上传文件不推算字数 | 课堂投影刷新，仅反映已保存内容 | `student-work-presentation.test.tsx` |
| 汇报就绪、评价完成、预计剩余 | 本场汇报队列及汇报记录 | 按队列成员状态计数；预计剩余以配置时间和已用时估算 | 汇报队列刷新 | `teacher-dashboard-metrics.test.ts` |
| 普通问卷与历史反思 | 课程活动问卷取有效成员完成记录；历史反思由兼容统计读取 | 每人最新有效记录；问卷、历史反思和后测分别统计 | 问卷接口或兼容课堂投影刷新 | `teacher-dashboard-metrics.test.ts`、`survey.test.ts` |
| 课堂实验前后测提交 | 前测按有效教学班成员；后测按已进入本场者 | 每场、每学生、每阶段唯一正式提交；草稿不算提交；历史退班答卷仍在明细 | 结果接口刷新 | `experiment-service.test.ts` |
| 目录独立后测提交 | `ActivityProgress` 草稿、`ActivitySubmission` 正式答卷及提交时题目快照 | 草稿不计提交；每名学生按该活动的正式答卷计数，回看使用提交时配置；与课堂实验后测分别统计 | 后测结果接口刷新 | `posttest-service.test.ts` |
| 教学班活动状态 | 活动进度和对应课堂场次参与记录 | 课堂只依据对应活动的参与记录；不能用其他课堂进入记录替代 | 学生记录接口刷新 | `student-records.test.ts` |
| 教材解析阶段估计 | 当前修订版最新 `GenerationJob.progress` | 取最新任务的 0–100 阶段估计，明确标注“约”；不等于学生学习完成率 | 教材列表刷新 | `textbook` 服务及页面测试 |

问卷选项分布以有效提交为来源。单选按答卷人数、多选按选择人次统计，百分比用最大余数法保留一位且合计 100%。已有答卷后锁定题目配置；活动标题、说明和开放状态仍可修改。
问卷提交率按当前有效教学班成员统计，分母为零或人数不一致时不展示百分比；这项指标不等同于某场课堂的参与率。

V2 场次第五阶段展示项目评价，分别统计自评提交、已分配互评提交、教师定评和报告发布。学生阶段完成由自评与本人分配的互评决定，未启用互评不产生额外任务；后测、AI 任务状态和教师定评不计入学生任务完成度，也不阻止教师结束课堂。旧场次继续展示原后测指标。内部阶段键均保留 `reflection`，不能单凭键名推断是反思、后测还是新项目评价。实现见[阶段看板](../src/components/classroom/teacher-stage-dashboard.tsx)和[评价服务](../src/lib/evaluation/pbl-service.ts)。

独立后测实现见[后测服务](../src/lib/platform/posttest-service.ts)，课堂实验实现见[实验服务](../src/lib/platform/experiment-service.ts)。新增指标应同时更新实现、行为测试与本表，不能将保存草稿、进入答题页或 AI 推荐分数计为正式完成或课程成绩。

知识点补讲推荐沿用最低有效样本 `min(班级人数, max(3, ceil(班级人数×40%)))`，且至少 2 人、未达标比例达到 30%。无有效作答、样本不足、暂未发现共性问题分别显示；多个知识点可关联同一学生或同一道题，人数不能跨知识点相加。完整原题目录中的未作答题仅供教师查阅，不创建提交或评分记录，也不参与上述指标。
