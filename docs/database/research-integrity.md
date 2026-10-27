# 研究数据与留存合同

本文描述当前采集、提交快照、归属校验和留存边界。实体清单见[数据库设计](../database.md)，分页与管理导出见[研究数据导出](research-export.md)。合同以 [Prisma schema](../../prisma/schema.prisma)、迁移 SQL 和实际写入服务共同为准。

## 区分当前状态与历史证据

| 记录 | 含义与使用方式 |
| --- | --- |
| `ActivityProgress` | 某条选课对活动的最新状态和答案投影；重交会更新，不能据此恢复历次尝试 |
| `ActivitySubmission` | 普通活动的历次提交与独立后测的一次正式提交，保存活动版本、配置、答案和研究键快照；与最新进度在同一事务写入 |
| `ClassroomParticipation`、`StudentProjectWorkspace`、`ClassroomSubmission` | 课堂参与、项目和各阶段的当前状态；阶段提交不是逐次操作历史 |
| `ArtifactVersion` | 成果的独立版本、文件/HTML 引用和提交状态；已保存版本不被后续提交覆盖 |
| `ExperimentAssessmentAssignment` | 某场次某条选课固定的前后测题目与情境次序，后续题目配置变化不替换已分配内容 |
| `ExperimentAssessmentDraft` | 测量答案草稿及版本；可继续编辑，正式提交时删除对应阶段草稿 |
| `ExperimentAssessmentSubmission` | 每个场次、选课、测量阶段的一次正式题目和答案快照；相同答案重试复用已提交记录，不同答案重交返回冲突 |
| `LearningEvent`、`AiInteractionEvent`、`DomainEvent` | 分别记录学习、AI 交互与业务操作事实；同一操作可在多个事实层记录，不能简单相加为实验尝试次数 |
| `AiConversation`、`AiMessage`、`AiTask` | 会话、完整消息历史与生成任务回执；页面或模型只读取近期消息不代表旧消息已删除。任务状态与消息证据要分别保留，失败回执不能冒充成功答复 |
| `AiTaskRequestAlias` | 已接收代码后台请求的原编号、原载荷和任务映射；重放可关联原回执，不等同于新增模型尝试 |
| `GenerationJob`、`GenerationCheckpoint` | 生成与恢复的运行状态；检查点按任务和步骤更新，不是追加式实验档案 |

[活动提交服务](../../src/lib/platform/submissions.ts)在事务内确认活动版本，题目已变化时拒绝旧版本答案。再次提交相同普通活动答案仍新增历史记录；实验测量使用“一阶段一次正式提交”规则。[独立后测](../../src/lib/platform/posttest-service.ts)也只保留一次正式提交，但使用 `ActivitySubmission`；开放期间相同题目与答案的重放复用原回执，不同答案重交拒绝。其草稿位于 `ActivityProgress.progressData.posttestDraft`，正式提交后移除。分析应先区分活动类型和测量入口，不能将同一表的所有记录统一解释为可重交作业。

发布课堂使用场次绑定的模板版本；设计修改经备课入口形成相应草稿/版本，不能通过授课动作覆盖已发布设计。模板 snapshot 存设计，实例 runtimeConfig 存运行控制，提交 payload 存学生内容，事实 payload 存单次操作。教材修订、实际采用章节和证据快照用于解释生成依据，不能以当前教材内容替代当时采用的证据。

## 实际教学阶段与研究出口

以下对照依据当前写入入口，说明应联合保留的记录；它不是某次课堂全部数据已通过验收的结论。

| 学生操作或教学阶段 | 持久化与历史证据 | 研究读取与边界 |
| --- | --- | --- |
| 资源学习、进入课堂、学习时长与阶段进度 | `LearningEvent`、`ClassroomParticipation.stageProgress`；页面讲授学习进度在 `StudentProjectWorkspace.projectState` | `type=events` 导出已采集事实；阶段状态和工作区是可变投影，不代表所有点击、阅读或停留均已采集 |
| 知识讲授伴学、讲授页问答、各阶段 AI 协作 | `AiConversation`、`AiMessage`、`AiTask`、`AiInteractionEvent`；讲授页与伴学的新会话均绑定实际课堂参与 | `type=ai_messages` 读取全部可证明归属的消息，`type=ai` 保留策略、操作与错误；旧事件中的正文仍应保留，两类记录不相加为问答轮数 |
| AI 建议、采纳确认、学生对 AI 的判断 | `AiActionConfirmation`、`AiSupportRecord`、`AiTask` 及相关 `DomainEvent` | `type=domain` 可读取已写入的操作事实；实体的当前状态及结构化内容需从研究包/数据库读取，不能从一句模型建议推断学生已采纳 |
| 项目草稿、阶段提交、白板和成果版本 | `StudentProjectWorkspace`、`ClassroomSubmission`、`GroupBoard`、`ArtifactVersion`；课程动作通过 `COURSE_ACTION` 保存成功操作与幂等回执 | `type=domain` 保留动作历史；学生 ZIP 只覆盖其约定的正式记录。当前草稿、白板、引用文件与成果版本需联合备份，编辑器尚未上传的内容不算已留存 |
| 展示与公共讨论 | `ShowcasePresentation`、`PublicDiscussionSession`、`PublicDiscussionTurn` 及相关操作事实 | `type=domain` 不替代逐轮讨论正文；需保留讨论轮次、场次、学生身份和成果版本引用，文件字节由本地完整备份保护 |
| 反思、体验问卷、自评互评和教师评价 | `Reflection`、`Evaluation` 及课程动作/课堂结果事实；部分投影通过同 ID upsert 更新 | 不能将实体当前值当成每次提交历史；结合 `type=domain` / `outcomes` 的成功操作和回执，学生 ZIP 提供当前记录 |
| 前后测、独立后测及普通活动问卷 | `ExperimentAssessmentAssignment`、草稿/正式提交、`ActivitySubmission` 和最新 `ActivityProgress` | 课堂测量使用 `type=experiments`；独立后测和普通活动使用 `type=submissions`。问卷 CSV 是最新值，不能替代历次提交 |
| 教师干预与教学调控 | `Intervention`、`TeacherAgentDirective`、`LearningSignal`、`AiSupportRecord` 及相关 `DomainEvent` | 同时保留实体和动作，研究键可能为空；系统推断、教师判断和学生原始行为应保持类别差异 |

当前课程动作由[课程动作服务](../../src/lib/courses/action-service.ts)提交，投影由[课堂投影持久化](../../src/lib/db/v2-course-projection.ts)写入；正式课堂结果另有[结果服务](../../src/lib/platform/classroom-outcomes.ts)。不同入口的成功事实可能使用不同事件类型，不能只过滤 `CLASSROOM_` 前缀就宣称覆盖五阶段全部操作。

没有记录时，研究数据应区分“该学生/场次未发生”“该操作没有采集入口”“记录存在但无法确认归属”与“等待服务器补写”。前端显示的零值或空数组不足以判定哪一种，也不能统一作为零分。现有源代码核查只能证明采集路径和约束；实际覆盖率、重复率及缺失情况仍需在限定教学班的数据一致性快照中核对。

## 身份、归属与时间

`Enrollment.researchKey` 是每条选课的假名标识，同一学生在不同教学班有不同标识。它可关联同一教学班内的记录，不是跨课程受试者编号，也不是完全匿名数据。学习事件、AI 交互、业务事实和正式提交在写入时保存研究键快照；历史回填只在用户/课程归属可确认时进行。

课堂学习证据通过 `ClassroomParticipation → Enrollment` 关联学生，场次通过 `Activity → Chapter` 关联教学班。客户端提供的 ID 只是待验证引用，服务端逐级解析并核对归属；外键存在不等于跨课程语义正确。教师操作依据 `CourseTeacher`，学生小组操作还需核对实际成员与对象范围。

AI 消息研究导出在数据库查询内比较会话用户与选课用户，并验证两条教学班链；仅有教学班归属的历史会话用 `association=offering_only` 显示归属层级，不能编造课堂实例。`researchConversationKey` 仅关联消息所属的真实会话。`sourceStageKey` 保留会话 `legacyStageKey` / `stageKey` 原值；`stageKey`、`workspaceKind` 只解析已知文档线程格式，未知复合键保留来源并标空，规则见[导出合同](research-export.md)。同一阶段可有多个独立会话，不得按阶段合并问答历史。

`LearningEvent.occurredAt` 为客户端发生时间，省略时使用服务器当前时间；`receivedAt` 为服务器接收时间。允许离线上报早于接收时间的事件，拒绝超过服务器时间 5 分钟的未来事件。AI 交互与业务事实的 `createdAt` 是服务器记录时间，不自动代表实际学习发生时间。增量导出按各类型规定的服务器时间排序。

`eventVersion` 表示事件结构版本。实验 `variant` 表示前后测情境次序，客观分数由分配题目的评分规则得出；实验分组、量表含义和测量有效性需依据真实研究方案，不能从事件版本、题目次序或已有答案自行推断。

## 事务、版本与幂等

| 场景 | 当前写入保护 |
| --- | --- |
| 邀请入班 | 邀请码行锁及同用户的串行化保护；选课、初始活动进度和使用计数在事务内提交，重复加入不重复扣额度 |
| 密码重置 | 事务内条件消费未使用且未过期令牌，更新密码并递增会话版本 |
| 章节/活动顺序、模板版本和课堂场次 | 在父记录锁的保护下分配编号，数据库唯一约束兜底 |
| 携带版本的编辑 | 事务内校验版本后写入，过期版本返回冲突 |
| 活动访问 | 只将 `NOT_STARTED` 更新为 `IN_PROGRESS`，迟到访问不能将已完成状态倒退 |
| 普通活动提交 | 活动版本确认、提交快照和最新进度同事务，避免题目与答案错配 |
| 学习事件批量上报 | 全批次解析归属后写入，任何上下文冲突都拒绝整批 |
| 实验分配与草稿/提交 | 场次生命周期守护、单学生分配锁及版本检查；A/B 平衡分配使用场次范围锁，正式提交与草稿清理同事务 |
| 成果归档与 AI 操作确认 | 在实际参与、对象归属、确认状态和幂等回执的保护下执行，正式成果使用独立版本 |

学习事件以 `(userId, idempotencyKey)` 唯一；AI 与业务事实表的 `idempotencyKey` 为全表唯一，由各服务构造操作范围。重试需复用原操作键，新事实需新键。学习事件重复键会被确认为已接受，不能用相同键修改旧内容。

新消息型 AI 事实可用 `payload.schemaVersion=2`、`detail.contentRef=AiMessage` 和 `detail.messageId` 引用正文；消息与必须的操作事实同事务保存，策略、建议、采纳及错误仍表达各自事实。研究接口的显式内容导出按会话、用户和教学班校验后解引用；缺失引用标记 `message_reference_unresolved`，不把空值伪装成成功采集。原始备份同时保存消息和事件，不将解引用结果再次写回数据库。旧的内联正文和历史重复审计记录继续保留；分析中只有稳定消息/请求标识能够证明重复时才合并，文本相同、时间接近或同一阶段仅能作为疑似重复诊断。

## 学习事件上报

学生通过同源认证请求 `POST /api/platform/events`：

```json
{
  "events": [
    {
      "idempotencyKey": "本次事实的稳定重试键",
      "type": "事件类型",
      "activityId": "当前教学班的活动 ID",
      "occurredAt": "2026-10-14T02:00:00.000Z",
      "source": "platform"
    }
  ]
}
```

每批 1–100 条；单条 `metadata` 序列化 JSON 最多 32,768 字符；`durationMs` 为 0–2,147,483,647 的毫秒整数。至少提供一个可解析的教学班、选课、章节、活动、场次或参与 ID，服务端补齐其祖先及选课。课堂事件必须关联当前学生实际存在的参与记录。响应的 `acceptedIds` 是已持久化或已存在的幂等键，不是新生成的事件记录 ID。实现见[学习事件服务](../../src/lib/platform/learning-events.ts)。

内置 `activity_opened` 对每个活动/选课记录一次；`classroom_entered` 按参与记录和分钟去重。这些事件不能直接当成完整访问次数、停留时间、注意力或眼动证据。客户端时长、自报文本与 AI 推断也应按其真实证据类别分析。

## 数据库约束与留存边界

`LearningEvent` 的用户及全部上下文外键、`AiInteractionEvent` 与 `DomainEvent` 的关联外键使用 `Restrict`。`ActivitySubmission`、实验分配/正式提交/草稿及 `ArtifactVersion` 的关键关联也使用删除限制。已有事实的账号、教学班和课堂对象应通过状态、退出或归档处理；物理删除前需专门处理研究留存关系。

数据库另外检查事件非负时长、正结构版本、合法邀请码额度、正活动版本、实验阶段及客观分数范围。额外检查和部分唯一索引定义在迁移 SQL，不能仅依赖 Prisma 模型检查。相关迁移包括[学习事件与提交留存](../../prisma/migrations/20260908120000_research_integrity/migration.sql)、[AI/业务事实与成果版本保护](../../prisma/migrations/20260908150000_v2_classroom_research/migration.sql)及[实验测量](../../prisma/migrations/20260924100000_classroom_experiment_assessments/migration.sql)。

追加事实是应用使用合同；目前没有禁止全部数据库 UPDATE/DELETE 的触发器。公共讨论等实体仍有自己的级联或置空策略，不能因为事件表受保护就声称所有正文都有不可删除保证。绕过写入服务修改 ID、研究键、题目或 payload 的管理脚本仍可能破坏语义；历史已被覆盖的内容不能伪造恢复。

`AiConversation` 和 `AiMessage` 自身仍有级联删除关系，关联的受限事实只能保护其实际引用的对象；不能由此推导全部消息都受相同删除限制。应用的状态归档、正式封存和实际恢复验证需要一起使用，数据库外键不是完整备份。

`quality=complete` 只表明导出记录带研究键；没有研究键的教师/课程操作需按事件语义保留。正式数据封存要处理在途事务与文件字节，不依赖分页接口的固定时间窗口充当数据库快照。具体方法见[导出分页合同](research-export.md#参数与分页)和[部署与恢复说明](../../deploy/README.md)。

## 验证入口

按修改范围选择检查；以下列出可执行入口，不记录某次历史通过结果：

```bash
pnpm exec prisma validate
pnpm exec vitest run src/lib/platform/learning-events.test.ts src/lib/platform/submissions.test.ts src/lib/platform/research-export.test.ts src/lib/platform/experiment-service.test.ts
pnpm test:db:research
OPENPBL_VERIFY_RESEARCH_EXPORT_ONLY=1 pnpm test:db:research
OPENPBL_VERIFY_BROWSER=1 pnpm test:db:research
```

`prisma validate` 检查 schema，需合法格式的 `DATABASE_URL`，不会执行迁移。隔离数据库入口 [verify-research-database.mjs](../../scripts/verify-research-database.mjs)需要 Docker 与项目依赖，使用带随机标记、绑定回环地址的独立 PostgreSQL 16/pgvector 容器，执行完整迁移及持久化/约束验证，结束时清理自身资源；它自行构造数据库地址，不向现用库执行迁移。

`OPENPBL_VERIFY_RESEARCH_EXPORT_ONLY=1` 通过[研究导出验证](../../scripts/verify-classroom-research-export.ts)在同一标记隔离库创建双教学班合成数据，实测消息导出的用户/选课/场次归属、历史空教学班与班级级会话、相同时间分页、内容开关和事件正文引用隔离，再运行[研究包数据库验证](../../tests/deploy/test_classroom_research_backup_db.py)检查真实导出、清单、待补写队列、范围和摘要。该入口不读取现用库 schema、正文或备份凭据，不执行云上传；Python 文件直接运行时默认跳过，需要经标记库入口显式开启。它验证研究包的数据正确性，不代替生产快照恢复及阿里云下载验证。

浏览器模式另需 Playwright Chromium，并通过 [verify-v2-pages.mjs](../../scripts/verify-v2-pages.mjs)核对隔离库的地址和随机标记。它使用临时 Next 构建/上传目录、测试身份和独立端口（默认 3199，可设 `OPENPBL_VERIFICATION_PORT=3199`–`3299`），结束时清理；不使用 3000 上的现用服务。只检查设置与备课可增加 `OPENPBL_VERIFICATION_PAGES=authoring`。

浏览器验证进程屏蔽工作区 `.env*`、旧配置和外部 API key，阻止外部网络；固定教案的设置、备课、师生五阶段页面读取/切换/刷新与业务持久化分别验证。明确的 `AI_NOT_CONFIGURED` 作为环境项报告，不是模型调用成功。隔离检查、真实供应商调用、生成质量验收和生产备份恢复是不同的验证范围，交付时分别说明实际执行结果。

已有部署的迁移先核对待执行项并备份。历史破坏性重建 SQL 的风险与 pgvector 前置条件见[数据库迁移说明](../database.md#迁移与验证)；完整迁移链仅用于已明确允许的新库或隔离验证环境，不能据此重置现用数据。
