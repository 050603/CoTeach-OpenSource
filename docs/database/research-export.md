# 研究数据导出

分页研究接口为 `GET /api/platform/offerings/{offeringId}/research-export`。每页重新验证教师账号及该教学班的 `CourseTeacher` 关系，响应禁止缓存。实现见[研究导出服务](../../src/lib/platform/research-export.ts)；采集语义与留存要求见[研究留存合同](research-integrity.md)。

## 七类分页数据

| `type` | 数据源与范围 | 排序时间 | 默认字段（另含 `id`、`researchKey`、`quality`） |
| --- | --- | --- | --- |
| `events`（默认） | 该教学班的 `LearningEvent` | `receivedAt` | 章节、活动、课堂实例、事件类型与版本、发生/接收时间、来源、时长 |
| `submissions` | 选课与活动均属于该教学班的 `ActivitySubmission`，含独立后测正式答案 | `submittedAt` | 活动 ID、活动版本、提交时间 |
| `experiments` | 选课与场次均属于该教学班的 `ExperimentAssessmentSubmission` | `submittedAt` | 课堂实例、活动、场次编号、测量阶段、A/B 次序、客观分数及总分、提交时间 |
| `outcomes` | 该教学班 `DomainEvent` 中 `CLASSROOM_` 前缀事件 | `createdAt` | 课堂实例、事件类型、记录时间 |
| `ai` | 该教学班的 `AiInteractionEvent` | `createdAt` | 课堂实例、事件类型、角色类别、记录时间 |
| `ai_messages` | 归属可核实的 `AiMessage` 全部历史，不受课堂页面和模型上下文条数限制 | `createdAt` | 研究会话键、关联层级、课堂实例、活动、章节、角色、教学阶段键、原始阶段/线程键、工作区类别、功能类型、记录时间 |
| `domain` | 该教学班全部 `DomainEvent`，含课堂操作、实验提交、公开讨论等业务事实 | `createdAt` | 课堂实例、事件类型、记录时间 |

`outcomes` 是 `domain` 的子集，不能拼接后当成互不重复的数据。`domain` 包含课程管理和教师/系统操作，总条数不等于学生学习行为次数。一次操作也可能分别产生学习事件、AI 事件和业务事实，三类记录表达不同层面的证据。

`ai` 记录交互事实，`ai_messages` 记录消息，两者不能相加计算问答轮数；一次请求可能产生请求、答复、策略、采纳或错误等不同事件。`ai_messages.researchConversationKey` 为带教学班范围和版本标签的 SHA-256 稳定会话键，同一会话的消息可关联，不返回数据库会话原 ID。它仍是假名标识，不能当作匿名化保证。

`ai_messages.sourceStageKey` 保留会话 `legacyStageKey` / `stageKey` 原值。`stageKey` 表示教学阶段：普通 `make`、`ai-learning` 等无冒号键保持原值；只对文档服务实际使用的 `ai-collaboration:{proposal|make}`、`ai-collaboration-comments:{proposal|make}` 及其 `:external-artifact:` 形式解析出教学阶段，分别标记 `workspaceKind=document` 或 `external-artifact`。其他带冒号的未知或畸形线程键仅保留 `sourceStageKey`，`stageKey` 与 `workspaceKind` 为 `null`；普通阶段键和缺失值的工作区也为 `null`，不根据阶段名称猜工作区。

消息先在数据库内核对 `AiConversation → ClassroomParticipation → Enrollment` 与 `ClassroomInstance → Activity → Chapter` 的教学班，以及会话用户、选课用户、非空消息用户的一致性，再按时间和 ID 分页。会话教学班为空时，只有完整参与链可以证明归属才纳入；显式填写其他教学班的会话排除。已退出选课和已结束场次不因当前状态被排除。早期无参与记录的会话只有明确绑定本教学班、并存在同用户同教学班选课时才导出，标记 `association=offering_only`，课堂、活动和章节为 `null`，不从自由文本或 metadata 猜测场次。有参与链的记录为 `association=classroom`。无法证明归属的历史消息不强行匹配，需要在受控全库核查中单独诊断。

`experiments.phase` 为 `pretest` 或 `posttest`；`variant` 为 `none`、`A_PRE_B_POST` 或 `B_PRE_A_POST`，表示题目情境的前后测次序，不能自行解释为实验组/控制组。配对分析至少同时使用 `researchKey + classroomInstanceId`，避免混合不同场次。

教学班目录直接添加的后测属于 `Activity.type=POSTTEST`，通过 `type=submissions&includeContent=true` 导出提交时的 `activitySnapshot` 和 `payload.answers`，不会出现在 `type=experiments` 中。其草稿保存在最新活动进度中，不属于正式提交导出。普通活动可以多次提交，独立后测锁定一次正式答案，两者不能采用相同的重交次数解释。

此接口导出上述事实、消息与提交记录，不是全库备份。公开讨论逐轮正文、干预实体、成果文件和所有评价没有独立的分页类型；部分历史 AI 正文仅在旧事件 payload 中，不是 `AiMessage`，须同时保留 `type=ai&includeContent=true`。是否有相应记录应按实际写入入口核对，不能把未返回的数据推断为没有发生。

V2 项目评价页面另提供 JSON 导出，内容严格取当前身份获授权的评价快照。教师导出包含本场个人评价档案与可追溯互评；学生只导出本人的自评、分配任务及已发布结果，不绕过匿名或发布限制。发布的 AI 报告保留原版本，新任务不会改写既有学生导出。过程报告不与实验测量合并计分；研究备份还需保留 `Evaluation`、`PeerReviewAssignment` 和版本化的 `AiSupportRecord`。

## 内容与身份

默认采用字段白名单，不返回顶层用户、选课、参与、请求或会话 ID，也不返回姓名、对话文本和自由文本 payload。保留的 `researchKey` 是选课假名标识，可关联同一选课下的事实，不是完全匿名数据。`ai.actor` 是 `student`、`assistant`、`system` 等角色类别。

显式 `includeContent=true` 时增加以下字段：

| 类型 | 内容字段 |
| --- | --- |
| `events` | `metadata` |
| `submissions` | `activitySnapshot`、`payload` |
| `experiments` | `questionnaire`、`answers` |
| `ai` | `content`、`payload` |
| `ai_messages` | `content`、消息 `metadata`、`conversationMetadata` |
| `outcomes`、`domain` | `payload` |

内容可能含账号标识、自由文本身份信息和业务关联字段，服务不会自动脱敏；题目快照也可能含评分所需信息。启用内容导出仍不会增加顶层 `userId`、`actorId` 等字段。

新 AI 事实可使用 `payload.schemaVersion=2`、`payload.detail.contentRef=AiMessage` 和 `messageId` 引用唯一正文。`type=ai&includeContent=true` 会批量读取这些消息，并核对事件会话、用户、参与及教学班归属后填充 `content`；旧的内联正文优先保留。消息缺失或归属冲突时保留原始引用和空正文，并增加 `contentResolution=message_reference_unresolved`，不能把它解释为学生发送了空文本。默认内容关闭时不读取引用正文。原始数据库或研究包中应同时保留事件和消息两表，以便离线解析引用。

`quality=complete` 仅表示有 `researchKey`，不表示课程质量、测量有效性或记录完整性已经通过检查。`missing_research_key` 表示缺少研究身份快照；课程级、教师级事实本来可能不对应某条选课，部分历史记录也无法可靠回填。应结合事件语义处理，不能伪造匹配或统一认定为采集丢失。

文档粘贴提醒使用独立业务事件 `document_content_reminder`，学生说明与教师核实使用追加的历史事件；它们表示观察和待核实状态，不是 AI 生成或违规结论，也不进入过程评分。`type=domain` 按既有 `includeContent` 规则导出。项目实践教学导出中的 `contentMonitorEvents` 与 AI 协作记录分开，默认不含片段、判断理由和自由文本说明，显式 `includeContent=true` 才包含这些正文。

## 参数与分页

```text
GET /api/platform/offerings/{offeringId}/research-export?type=ai&take=200
GET /api/platform/offerings/{offeringId}/research-export?type=ai_messages&includeContent=true
GET /api/platform/offerings/{offeringId}/research-export?type=experiments&includeContent=true
GET /api/platform/offerings/{offeringId}/research-export?type=domain&take=200&includeContent=true
```

| 参数 | 规则 |
| --- | --- |
| `type` | 上述七种值，默认 `events` |
| `take` | 1–500 的整数，默认 200 |
| `since`、`until` | 带时区的 ISO 时间；起点不能晚于终点。未指定起点时从 Unix epoch 开始，未指定终点时固定为首请求时间 |
| `includeContent` | 仅接受 `true` 或 `false`，默认 `false` |
| `cursor` | 上一页 `nextCursor`；不要自行修改或拼造 |

未知参数或重复参数返回 `400 INVALID_INPUT`。响应为 `{ exportVersion: 1, type, window, rows, nextCursor }`。

下一页将 `nextCursor` 作为 `cursor`，继续携带相同 `type` 和 `includeContent`。`since`、`until` 可省略，由游标恢复；切换教学班、数据类型、内容开关或时间窗口时重新开始导出。持续请求直到 `nextCursor=null`，不能只保存第一页。无论游标如何变化，每页都会检查教师对当前教学班的权限。

排序使用“时间 + id”，同一毫秒多条记录也可连续翻页。学习事件按服务器 `receivedAt` 导出，保留客户端 `occurredAt`；AI 消息及 AI/业务事实按服务器 `createdAt` 排序，不能直接据此推断实际学习发生时刻。

固定窗口不是跨 HTTP 请求的数据库快照：在途事务可能在首请求后提交，但其记录时间仍落在窗口内。正式封存使用数据库一致性快照，并核对在途任务与待补写队列；采集继续期间的封存需要后续增量补齐。持续增量导出应重叠窗口，按每种类型的记录 `id` 去重，并保存导出类型、窗口、内容开关和版本。

## 教学管理导出

系统还提供以下教师导出，其身份与统计范围不同于上述假名分页接口：

| 入口 | 输出与范围 |
| --- | --- |
| `GET /api/platform/activities/{activityId}/survey-export` | 问卷 CSV，基于 `ActivityProgress` 的最新已完成答案；仅含该教学班有效/已完成选课，包含学生姓名、账号、用户/选课 ID 与研究键。重交替换旧答案；历次提交需使用 `type=submissions` |
| `GET /api/platform/classroom-instances/{instanceId}/experiment/results` | 教师的测量结果与参与统计，含学生身份、题目/答案快照和客观得分；前后测及参与统计各自有范围，不能用页面人数代替完整实验样本 |
| `POST /api/platform/offerings/{offeringId}/students/export` | 按所选学生和数据类型生成 ZIP，包含清单、说明及 JSON/CSV 学习记录。请求需同源，所有学生须属于该教学班 |

学生记录 ZIP 的请求体为：

```json
{
  "enrollmentIds": ["选课 ID"],
  "sections": ["summary", "activity_progress", "activity_submissions", "classrooms", "artifacts", "reflections", "evaluations", "summary_csv"]
}
```

每次选择 1–5000 条选课，`sections` 至少一项。`classrooms` 包含参与、正式阶段提交和实验前后测；`artifacts` 包含正式成果版本的记录、HTML 和文件引用，ZIP 不打包这些引用对应的文件字节。数据包含操作身份与所选学习内容，不应用假名接口的默认字段规则描述它；测量草稿、未提交成果和完整 AI 对话不在这组导出项中。

问卷 CSV 的最新答案与学生 ZIP 的最新进度属于可变投影。用于研究时应明确采用当前状态还是不可变提交快照，不能混为一次统一封存的数据集。实现入口分别见[问卷导出](../../src/lib/platform/survey-export.ts)、[学生记录导出](../../src/lib/platform/student-record-export.ts)和[实验测量服务](../../src/lib/platform/experiment-service.ts)。
