# CoTeach

![CoTeach 横版标识](public/brand/coteach/horizontal-color.png)

CoTeach 是 AI 协同教学平台，让教师、学生与 AI 共同参与备课、知识学习、项目实践和成果交流。系统把教材证据、可复用课程、教学班、课堂场次、学生作品和学习记录连接起来。

**许可证：**CoTeach 自有代码及文档采用 [Apache License 2.0](LICENSE)。Copyright 2026 李科骏；作者单位：北京师范大学。署名见 [NOTICE](NOTICE)，第三方代码、字体与素材继续适用各自的[许可与来源](THIRD_PARTY_NOTICES.md)。

[贡献指南](CONTRIBUTING.md) · [安全与隐私报告](SECURITY.md) · [发布准备](docs/open-source.md)

用于研究或教学成果时，可通过 [CITATION.cff](CITATION.cff) 引用软件版本。

## 阅读入口

| 读者 / 任务 | 从这里开始 |
| --- | --- |
| 教师与学生使用平台 | [使用说明](docs/user-guide.md)：首次使用、备课、开课、项目协作、测评与结课回看 |
| 开发者启动与修改系统 | 本文的[本地开发](#本地开发)，再读[架构](docs/architecture.md)与[开发工作流](docs/agent-workflow.md) |
| 管理员安装、升级与恢复 | [部署说明](deploy/README.md)、[数据库迁移](docs/database.md#迁移与验证)、[备份恢复](deploy/backup/README.md) |
| 查询能力限制或技术契约 | [文档导航](docs/README.md)与[功能边界](docs/feature-status.md) |

对外产品名称为 **CoTeach**。`OpenPBL`、`OPENPBL_*`、部分目录与服务名是现行技术标识，配置时按代码原名使用。

## 当前系统

教师端提供“教学班”“课程库”“教材库”三个主要入口，学生端从“我的课程”进入已加入的教学班。

| 能力 | 当前行为 |
| --- | --- |
| 教材库 | 导入 DOCX，解析章节、原文证据、图片和知识关系；支持章节阅读、知识图谱及检索。备课引用固定教材解析版本。 |
| 课程库与备课 | 新建课程，配置课时和资料，按知识小节生成教学蓝图、原生课件与连续讲稿，编辑、预览并发布版本。 |
| 教学班 | 用邀请码组织学生，按章节安排课堂、作业、测验、问卷、后测和资料活动，控制开放状态并查看学习记录。 |
| 五阶段课堂 | 新场次为项目启动 → 知识讲授 → 项目实践 → 成果汇报 → 项目评价；前后测在主流程外的实验拓展单独配置。历史场次保留原流程。 |
| 项目评价 | 自评、可选互评和教师定评分别保存；AI 依据学习、协作与真实修改记录生成过程报告，由教师发布，不自动计入最终成绩。 |
| 知识学习 | AI 讲解、板书与视觉提示、章节小测、答案解析和问答；学习过程归属于当前课堂场次。 |
| 项目协作 | 每位学生拥有私有项目空间。文档与多文件 Python/C 工作区支持 AI 批注、局部建议和确认后应用，保留保存、修改和提交证据。 |
| 问卷与测评 | 问卷支持单选、多选、简答和选项补充说明，教师查看统计与词云；目录可添加独立后测并应用 CoTeach 模板，保存草稿与答卷；课堂实验前后测另可配置情境与配对。 |
| 成果与研究 | 保存作品版本、展示评价和 AI 交互；按教学班导出学习事件、活动提交、实验答卷、课堂成果及审计记录。 |

发布版本保存教学设计快照，开课创建独立场次，再次授课保留上一场记录。课程生成在服务器保存阶段与页面检查点；可执行首稿的质量问题记录为诊断，有界修复失败时保留较好的草稿继续，技术错误单独处理。

操作步骤见[教师与学生使用说明](docs/user-guide.md)，技术边界见[系统架构](docs/architecture.md)和[课程生成与恢复](docs/course-generation.md)。完整文档入口见[文档导航](docs/README.md)。

## 本地开发

需要 Node.js 22、pnpm 10.4.1、PostgreSQL 16（包含 pgvector）和 Redis 7。仓库提供数据库镜像与 Compose 配置；宿主开发服务器连接本地数据库端口。

### 安装与配置

从[公开源码仓库](https://github.com/050603/CoTeach-OpenSource)克隆；也可下载该仓库的源码归档。

```bash
git clone https://github.com/050603/CoTeach-OpenSource.git CoTeach
cd CoTeach
pnpm install --frozen-lockfile
cp .env.example .env.local
```

安装时保留 `postinstall`：它构建工作区包、同步浏览器导入器并生成 Prisma Client。Windows PowerShell 可用 `Copy-Item .env.example .env.local` 复制配置。

源码不附带真实教材、课程、学生记录或服务凭据；使用合成测试数据和自己有权使用的资料。本地 Compose 端口仅绑定回环地址，部署到网络环境按[生产部署](deploy/README.md)配置。维护用旧仓库保留私有；公开发行采用不带旧 Git 历史的独立源码快照。

在 `.env.local` 中填写以下配置，完整变量说明见[环境模板](.env.example)：

```dotenv
POSTGRES_PASSWORD=replace-with-a-local-password
DATABASE_URL=postgresql://openpbl:replace-with-a-local-password@localhost:5432/openpbl
REDIS_URL=redis://localhost:6379
PUBLIC_BASE_URL=http://localhost:3000
JWT_SECRET=replace-with-a-long-random-secret
PROVIDER_ENCRYPTION_KEY=replace-with-a-base64-encoded-32-byte-key
INTERNAL_MONITOR_TOKEN=replace-with-at-least-32-characters
TRUST_PROXY_HEADERS=false
COURSE_GENERATION_BACKGROUND_ENABLED=false
ENABLE_WEBSOCKET=true
WEBSOCKET_PORT=3001
NEXT_PUBLIC_WEBSOCKET_URL=ws://localhost:3001
```

分别用 `openssl rand -base64 48` 和 `openssl rand -base64 32` 生成 JWT 密钥与 Provider 加密密钥。模型、语音、媒体和解析服务由教师“个人中心 → AI 服务”管理；缺少相应 Provider 时无法执行该项真实 AI 功能。

本地默认使用请求内生成；需要验证离开页面后的持续生成和恢复时，显式启用 `COURSE_GENERATION_BACKGROUND_ENABLED=true`。

### 数据库与应用

```bash
docker compose --env-file .env.local up -d postgres redis
pnpm db:generate
pnpm db:migrate:prod
pnpm db:status
pnpm dev
```

这些迁移命令用于新建、独立的开发数据库。已有环境升级先阅读[数据库迁移说明](docs/database.md#迁移与验证)，确认历史重建迁移对数据的影响。当前平台依赖 PostgreSQL，JSON 文件不能替代账号、教学班和课堂参与数据库。

| 页面 | 路径 |
| --- | --- |
| 首页 | `/` |
| 教师登录 / 首个教师注册 | `/teacher/login` / `/teacher/register` |
| 教学班 / 课程库 / 教材库 | `/teacher/classes` / `/teacher/templates` / `/teacher/textbooks` |
| 教师设置 | `/teacher/settings` |
| 学生登录 / 注册 | `/student/login` / `/student/register` |
| 学生课程 | `/student` |

默认开发地址为 `http://localhost:3000`。数据库尚无教师时可通过注册页创建首个教师，也可执行：

```bash
OPENPBL_INITIAL_TEACHER_PASSWORD='replace-with-a-strong-password' \
  pnpm admin:init-teacher --username teacher --display-name '教师'
```

初始化命令只允许数据库尚无教师时执行，密码须为 10–256 个字符。首次使用的顺序为：配置 AI 服务 → 生成并发布课程 → 创建教学班、章节和课堂活动 → 开放课程并分发邀请码 → 开始上课。具体操作与不同测评入口见[使用说明](docs/user-guide.md)。

### 启动检查与常见问题

启动后访问教师登录页，并检查进程存活：

```bash
curl --fail http://localhost:3000/api/health/live
```

返回 `status: alive` 只表示应用进程可用。数据库连接、迁移、模型调用、上传与代码执行需按各自入口验证；依赖就绪和生产检查见[部署说明](deploy/README.md)。

| 情况 | 检查与处理 |
| --- | --- |
| 3000 / 3001 端口已被占用 | 先确认是否为正在使用的正式服务。开发实例使用独立 HTTP/WebSocket 端口，并同步 `PUBLIC_BASE_URL`、`WEBSOCKET_PORT` 和 `NEXT_PUBLIC_WEBSOCKET_URL`；例如 `pnpm dev --port 3100` 只改变 HTTP 端口。 |
| 数据库连接或迁移报错 | 核对 PostgreSQL 是否就绪、连接目标与密码、pgvector 扩展和 `pnpm db:status`；不要在已有教学数据上直接重置数据库。 |
| 工作区包或浏览器导入器缺失 | 确认安装未跳过 `postinstall`；修改包源码后按[工作流](docs/agent-workflow.md)构建对应依赖与浏览器产物。 |
| AI 功能提示未配置或模型不可用 | 在教师 AI 服务中核对该功能的 Provider、模型和凭据。能打开页面不表示已配置模型、语音、解析或代码运行服务。 |


## 代码与数据入口

```text
src/app/teacher/             教学班、教材库、备课与授课
src/app/student/             课程活动、知识学习、项目协作和成果
src/app/api/platform/        账号、教学班、活动、模板、场次和研究接口
src/lib/platform/           权限、平台仓储、问卷、实验测评和导出
src/lib/textbook/           教材解析、证据、知识关系与检索
src/lib/course-design/      教学设计任务、蓝图与确认来源
src/lib/course-generation/  课件任务、阶段和页面检查点
src/lib/ai-collaboration/   文档与代码 AI 协作、请求和审计
src/lib/project-practice/   项目草稿、归档、DOCX 转换与成果
src/lib/realtime/           课堂事件、在线状态、投屏与白板同步
src/lib/openmaic/           课堂生成、编辑、播放与 Provider 适配
packages/@openmaic/         DSL、生成基础包、PPTX 导入与渲染
prisma/                    当前数据库契约与提交的迁移
deploy/                    systemd、网关、监控与备份
scripts/                   运维、初始化、恢复与验证工具
```

平台业务实体使用 `/api/platform/*`。教材服务使用 `/api/textbooks/*`，协作使用 `/api/ai-collaboration/*`；备课、授课和 OpenMAIC 适配仍使用部分 `/api/courses/*`、`/api/openmaic/*` 接口。具体入口按[架构文档](docs/architecture.md#接口与权限)和调用方核对。

业务数据主链为 `User → Enrollment → CourseOffering → Chapter → Activity`；课堂链为 `ClassroomTemplate → ClassroomTemplateVersion → ClassroomInstance → ClassroomParticipation`。数据库、上传文件、课堂内容和审计队列各有持久化职责，完整说明见[数据库设计](docs/database.md)。

## 验证与常用命令

按[开发工作流](docs/agent-workflow.md)选择受影响的检查，命令以 [package.json](package.json) 为准。

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动开发服务器 |
| `pnpm build` / `pnpm start` | 构建并启动隔离的生产产物 |
| `pnpm typecheck` | 生成 Next 类型并检查应用类型 |
| `pnpm exec eslint <文件> --max-warnings 0` | 检查受影响代码 |
| `pnpm exec vitest run <测试路径>` | 定向运行应用回归 |
| `pnpm test:ci` | 运行 `src` 范围测试，最多两个 worker |
| `pnpm test:e2e` | Playwright 浏览器测试；先核对配置中的运行环境 |
| `pnpm test:db:research` | 在隔离 PostgreSQL 中检查平台及研究持久化 |
| `OPENPBL_VERIFY_EVENTS_ONLY=1 pnpm test:db:research` | 单独回归课堂事件投影、私有版本覆盖、游标和即时权限校验 |
| `pnpm test:course-generation-acceptance` | 正式生成验收；真实模型调用需显式开关 |
| `pnpm db:generate` / `pnpm db:status` | 生成客户端 / 核对迁移 |
| `pnpm db:migrate` / `pnpm db:migrate:prod` | 开发迁移 / 应用已提交迁移 |
| `pnpm cleanup:uploads` | 按引用与保留规则清理孤立上传 |
| `pnpm storage:rehydrate` | 检查或重建有完整配方的派生资源 |

根测试与类型检查不覆盖全部子包源码，工作区包需按各自说明验证。真实课堂容量验证见[容量验收工具](tests/load/README.md)，会创建测试数据并可调用真实模型、重启服务，须在对应维护窗口执行。

## 部署与恢复

当前宿主部署由 systemd 管理 Next.js 应用、代码运行器、问卷分词、语音对齐和出站代理；Docker Compose 管理 PostgreSQL、Redis、Nginx 和可选监控。公开入口经 Nginx 访问，应用与辅助服务监听回环地址。

`pnpm build` 使用 `.next-build`，生产运行使用 `.openpbl-runtime/releases/<BUILD_ID>` 不可变目录，开发构建与服务正在使用的文件分开保存。应用修改通过相关检查后，先构建并准备运行目录，再重启服务、检查健康状态和实际运行版本，详见[部署说明](deploy/README.md)。

备份分为三种用途：本机完整恢复点保存数据库、WAL、文件、配置与源码恢复输入；教学班研究备份保存指定教学班的账号、课堂版本、作答、学习过程和 AI 记录，并上传到独立异地归档后回读校验；旧的账号与首课问卷精简备份仅供对应专项用途。研究归档不包含附件、媒体字节和完整系统环境，不能代替完整恢复点。覆盖范围、调度配置和恢复验证见[备份与恢复](deploy/backup/README.md)。

## 版本管理范围

仓库保留必要源码、实际使用的素材、数据库迁移、锁文件、构建部署配置、回归测试及当前合同和运维说明。运行数据、密钥、备份、构建产物、模型输出、截图和测试报告写入 `.gitignore` 覆盖的目录；历史实现和决策通过 Git 查阅。

回归测试保留可复用的测试源码与最小脱敏样例；测试生成的数据、执行记录、报告和截图不参与仓库同步。本机临时验收服务的构建目录不写入共享 TypeScript 配置。

每次修改与测试收尾执行[提交范围检查](docs/agent-workflow.md#版本管理与提交)，保留其他任务的未提交内容。文档按当前入口和实际实现维护，版本上线经过、一次性验收结果和已被替代的方案不作为现行说明。

## 文档维护与第三方来源

现行说明统一从[文档导航](docs/README.md)进入。功能、接口和运维方式改变时，同步对应说明；废弃文档先迁移仍有效的规则并修复引用，再删除，历史通过 Git 查询。

第三方来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[OpenMAIC 集成](docs/openmaic-upstream.md)及各包的许可文件。运行时提示词、维护技能、字体许可和回归样例都有实际用途，不按普通旧文档清理。
