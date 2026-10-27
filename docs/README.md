# CoTeach 文档导航

这里维护当前系统的使用说明、技术合同和运维入口。功能和命令以实际页面、代码、[数据库 Schema](../prisma/schema.prisma)及 [package.json](../package.json) 为准；历史方案和上线记录通过 Git 查阅。

## 按任务阅读

- **首次使用**：教师和学生从[使用说明](user-guide.md)开始；课程库、教学班、课堂场次及两类后测的区别都在相应流程中说明。
- **启动开发环境**：按[项目说明](../README.md#本地开发)安装，再看[架构](architecture.md)及[开发工作流](agent-workflow.md)。
- **维护现有环境**：先看[部署说明](../deploy/README.md)，数据升级、导出和恢复分别使用下面的数据文档。
- **排查具体功能**：按下表进入相应契约；文档中的能力与默认值不代表当前机器已经启用，也不代表本次完成了真实模型或生产验收。

## 使用与开发

| 文档 | 内容 |
| --- | --- |
| [项目说明](../README.md) | 系统能力、本地启动、目录与常用命令 |
| [教师与学生使用说明](user-guide.md) | 教材、备课、教学班、课堂、项目成果与测评 |
| [系统架构](architecture.md) | 业务边界、接口、协作、实时同步和资源生命周期 |
| [功能开关与实现边界](feature-status.md) | 当前入口、可选能力、未接入入口及历史兼容职责 |
| [开发与验证工作流](agent-workflow.md) | 按改动选择检查、CI 和提交范围 |
| [贡献指南](../CONTRIBUTING.md) | 复现、提交、脱敏与贡献授权边界 |
| [安全与隐私](../SECURITY.md) | 私密报告、敏感数据与泄露处置 |
| [公开发布准备](open-source.md) | 许可、内容、Git 历史及 GitHub 发布范围 |
| [设计系统](../DESIGN-SYSTEM.md) | 当前主题、布局、组件与终端适配 |
| [品牌资源](brand.md) | 标识与动画的使用约定 |

## 教学生成与学习

| 文档 | 内容 |
| --- | --- |
| [课程生成与恢复](course-generation.md) | 教材证据、蓝图、原生页面、讲稿、质量诊断和检查点 |
| [个性化学习合同](quality/adaptive-learning.md) | 默认路径与已确认先修、补学、拓展方案的适用边界 |
| [OpenMAIC 集成](openmaic-upstream.md) | 固定包来源及 CoTeach 适配职责 |
| [空间设计参考](slide-spatial-sources.md) | 排版参考来源、依赖与实际适配范围 |
| [教师端指标](teacher-metrics.md) | 人数、进度、测验、成果与问卷的统计口径 |
| [文档 AI 协作与验证](ai-collaboration/README.md) | 意图路由、确认应用、异步任务、审计与验收入口 |

## 数据与运维

| 文档 | 内容 |
| --- | --- |
| [数据库设计](database.md) | 当前模型、关系、存储边界与迁移 |
| [研究数据完整性](database/research-integrity.md) | 幂等、留存、删除保护和隔离验证 |
| [研究导出](database/research-export.md) | 导出类型、分页、时间范围与内容权限 |
| [生产部署](../deploy/README.md) | 服务、端口、更新、健康检查与辅助模型 |
| [Secret 配置](../deploy/secrets.example/README.md) | 部署凭据文件与必需变量 |
| [备份与恢复](../deploy/backup/README.md) | 完整恢复点、教学班研究归档、异地回读与专项精简备份 |
| [课堂容量验收](../tests/load/README.md) | 当前负载工具、真实模型与结果判定 |
| [投屏同步验收](projection-sync-validation.md) | 独立师生浏览器与渲染时延 |
| [多终端布局检查](responsive-layout-checks.md) | 夹具页面、设备范围与实际构建检查 |
| [容量恢复操作](operations/classroom-capacity-restore.md) | 完成某次运行后的备份与隔离恢复 |
| [容量数据清理](operations/classroom-capacity-cleanup.md) | 单个运行的归属核对、dry-run 与清理 |

## 工作区包

- [DSL 契约](../packages/@openmaic/dsl/README.md)
- [生成基础包](../packages/@openmaic/generation/README.md)
- [PPTX 导入器](../packages/@openmaic/importer/README.md)与[维护技能](../packages/@openmaic/importer/SKILL.md)
- [渲染器](../packages/@openmaic/renderer/README.md)与[字体来源](../packages/@openmaic/renderer/FONTS.md)
- [文档解析适配](../src/lib/openmaic/pdf/README.md)
- [应用提示词](../src/lib/openmaic/prompts/README.md)
- [课件编辑 Agent](../src/lib/openmaic/agent/README.md)
- [集成组件翻译维护](../src/lib/openmaic/i18n/TRANSLATION_GUIDE.md)

文档修改应同步入口链接，并核对命令、路由、模型和状态名。提示词模板、技能、许可证与最小回归样例各有独立用途，按实际调用和维护需求保留。

## 维护与清理规则

每类事实保留一个主要维护位置，其余文档只给概要并链接，避免出现多套相互冲突的说明：

| 事实 | 主要维护位置 / 核对依据 |
| --- | --- |
| 用户操作、可见状态与限制 | [使用说明](user-guide.md)、实际页面及服务权限 |
| 功能开关与尚未接入的能力 | [功能边界](feature-status.md)、配置读取与调用方 |
| 模块、接口、数据归属 | [架构](architecture.md)、[数据库](database.md)、路由与 Prisma Schema |
| 命令、依赖与验证 | [开发工作流](agent-workflow.md)、根与子包 `package.json`、CI 配置 |
| 环境、部署、备份与恢复 | [部署](../deploy/README.md)、[备份](../deploy/backup/README.md)、提交的配置模板和脚本 |
| 包接口与提示词 | 对应包 README、类型导出和实际加载器 |

清理文档时先核对代码与引用：已废弃的操作步骤删除，仍有效的规则合并到对应契约，所有入站链接同步修改。历史计划、修复经过、某次验收结果和机器状态不作为现行手册，也不建立新的历史副本；需要时通过 `git log -- <路径>` 或 `git show <提交>:<路径>` 查看。

保留正在加载的 Markdown 提示词、技能入口、第三方与字体许可、最小回归样例及可复用恢复规程。文档收尾检查本地链接与章节锚点、引用命令和 `git diff --check`；纯文档调整不代表已经执行文档中的迁移、备份、模型调用或部署。
