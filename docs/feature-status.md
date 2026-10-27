# 功能开关、实现限制与兼容边界

本文面向维护者，记录容易误判为废弃的功能、启用条件和已知实现限制。教师与学生操作见[使用说明](user-guide.md)，总体模块关系见[系统架构](architecture.md)。源码实现与实际部署状态分别核对，本文不保存某台机器的开关或验收快照；未列出的模块仍须检查调用方、持久化数据与运维入口。

## 当前入口的维护边界

| 能力 | 当前入口与行为 | 维护边界 |
| --- | --- | --- |
| 教材、课程设计与发布 | 教师教材库、课程库及备课页面；新场次使用项目启动、知识讲授、项目实践、成果汇报、项目评价五阶段 | [系统阶段](../src/lib/system-mode.ts)按场次评价合同版本分流；已有在授及结束场次保留原后测阶段，不批量重写历史 |
| PBL 评价与 AI 过程报告 | 第五阶段的自评、可选互评、教师定评及发布；学习与实践阶段提供教师过程报告入口 | [评价服务](../src/lib/evaluation/pbl-service.ts)校验身份、分配与正式作品版本；[过程队列](../src/lib/evaluation/process-worker.ts)后台生成。未知维度不记零分，AI 不自动计入最终成绩，学生只读取固定发布版本 |
| 课堂编辑与 AI 修改 | 备课发布中心进入[课堂编辑器](../src/app/teacher/prepare/[id]/classroom-editor/page.tsx)；携带课程身份的 AI 编辑经过模板授权 | 不能因通用 Pro 切换按钮隐藏而删除教师编辑器、编辑 Agent 或工作区包 |
| 实验前后测、独立后测、问卷及结果 | 课堂实验配置、教学班章节活动、教师结果页与学生活动页 | 保留答题、草稿、提交、复看和导出；课程结束后的写入限制见[用户说明](user-guide.md)与服务端合同 |
| 文档与代码 AI 协作 | 学生项目实践工作台；文档由学生主动发起讨论、检查或委派 | 保留异步请求回执、后台任务、代码审阅队列、恢复与审计；文档自动批注旧客户端不再承担入口职责 |
| 公开追问与辩论 | [公开讨论服务](../src/lib/public-discussion/service.ts)要求 `ENABLE_PUBLIC_DISCUSSION=true`；教师从知识讲授阶段的课堂工具进入，学生在课堂中接收点名 | 保留师生入口和讨论记录；缺省关闭。启用后需验证师生同步、权限、语音或文字回应与总结 |
| 已结束课堂复看与研究留存 | 学生学习记录、教师课堂记录及研究导出 | 内容、答案、解释、AI 过程与版本应继续可读；清理自动测试数据不能删除真实记录或人工测试课程 |

## 开关与可选入口

| 能力 | 源码事实与启用条件 | 保留原因、缺口与启用前验证 |
| --- | --- | --- |
| 通用 MAIC Pro 切换 | [功能开关](../src/lib/openmaic/config/feature-flags.ts)读取 `NEXT_PUBLIC_MAIC_EDITOR_ENABLED`，仅 `true` 或 `1` 开启；缺省关闭 | 保留编辑组件、跨标签锁与播放切换。教师备课编辑有独立入口。启用需在对应构建中验证切换、锁与保存，不由当前 shell 变量推断已发布前端状态 |
| 职业任务引擎 | 服务端 `OPENMAIC_ENABLE_VOCATIONAL` 为 `true` 或 `1`，且本次请求 `taskEngineMode=true` 才采用；缺省走普通生成路径 | 保留生成原语和任务标记。启用需验证大纲、页面、动作与教学顺序；现有源码和开关不构成这条路径的课堂验收结论 |
| 职业任务测试按钮 | `shouldShowVocationalTestUi()` 读取 `NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI`，当前没有组件调用它 | 作为未接入的可选入口保留。仅设置变量不会出现按钮；接入前需明确产品入口，并同时验证服务端门控 |
| 新课堂 PPTX 转 PDF 兼容路径 | [上传接口](../src/app/api/uploads/route.ts)读取 `OPENPBL_PPTX_CLASSROOM_CONVERSION_ENABLED`；缺省要求教师上传 PDF，显式开启才转换相应 PPTX | 保留转换器、字体和运行依赖。启用需验证真实中文、公式、布局及转换失败恢复；不影响现有 PPTX 导入器和课件导出 |
| classic、flow、Workbench 与专用 PBL 生成原语 | 工作区与应用仍保留明确调用方，当前教师默认生成流程以[生成合同](course-generation.md)为准 | 不因非默认路径删除。差异、历史响应与恢复政策见 [OpenMAIC 适配](openmaic-upstream.md)；重新接入应另行验证输出合同与实际渲染 |
| 负载验收 API | [授权边界](../src/lib/load-test/authorization.ts)要求生产模式、`ENABLE_LOAD_TEST_API=true` 和有效管理凭据；否则拒绝访问 | 保留受控运维入口与隔离验收脚本；不作为师生功能开放，验证只能使用明确归属的合成账号和运行记录 |

`NEXT_PUBLIC_*` 在 Next.js 构建时进入浏览器产物，修改运行服务环境后仅重启不能更新这类前端开关。服务端变量按实际读取位置生效；核对部署状态时应同时确认构建身份、服务环境与真实请求，不能把源码缺省值当成当前发布值。

## 已知实现限制

| 能力 | 已有实现与明确缺口 | 后续验收 |
| --- | --- | --- |
| 已移除的 tldraw 同步原型 | 原型未接入应用客户端，且所用 sync-core 有独立生产许可限制；当前发行版已移除该服务及依赖。现行课堂实时同步仍使用既有 WebSocket，历史 board 快照字段继续保留 | 旧部署须移除 `ENABLE_TLDRAW_SYNC=true`，否则启动时明确拒绝；未迁移或删除历史白板数据。以后如重新接入，须先完成适用授权与端到端验收 |
| 画布插入与链接 | [画布](../src/components/openmaic/slide-renderer/Editor/Canvas/index.tsx)保留已有元素编辑；双击插入文本、自定义形状和 LinkDialog 仍有空实现。[框选创建](../src/components/openmaic/slide-renderer/Editor/Canvas/hooks/useInsertFromCreateSelection.ts)已支持文本，但形状、线段创建仍待实现，拖放文本入口也需接通 | 分别验证文本插入、形状与线段创建、拖放、超链接保存及撤销，不能由已有拖动/缩放推断所有创建手势可用 |
| 表格内容及音频元素编辑 | [表格](../src/components/openmaic/slide-renderer/components/element/TableElement/index.tsx)已有选中、拖动与缩放，单元格编辑未完成；[可编辑元素](../src/components/openmaic/slide-renderer/Editor/Canvas/EditableElement.tsx)与[屏幕元素](../src/components/openmaic/slide-renderer/Editor/ScreenElement.tsx)的音频映射仍未接入 | 表格展示继续保留；补齐后分别验证内容修改、保存回读、音频元素播放及编辑，不与现有讲课音轨混淆 |
| MAIC Agent 配额源 | [配额 hook](../src/lib/openmaic/agent/runtime/quota.ts)存在；[Agent 构建](../src/lib/openmaic/agent/runtime/build-agent.ts)暂以 `Number.MAX_SAFE_INTEGER` 作为剩余额度，真实预算源未接入。已有工具白名单、模型与编辑链路保留 | 接入真实额度后验证耗尽、并发扣减和失败恢复；当前不能声称已实施配额限制 |

## 退役界面的兼容职责

| 已退役部分 | 保留的实际职责 | 回归边界 |
| --- | --- | --- |
| 师生旧 `reflection-survey` 独立 UI | [学生阶段分派](../src/components/views/student/stage-dispatcher.tsx)与[教师阶段分派](../src/components/views/teacher/stage-dispatcher.tsx)在旧合同场次将 `reflection` / `reflection-survey` 映射至后测，新合同第五阶段显示项目评价；[反思数据解释层](../src/lib/reflection-survey.ts)、汇总、展示和导出保留 | 旧记录仍能解释与汇总；实验后测和新项目评价均不回退到旧反思表单 |
| 浏览器旧自动文档审阅队列、重试调度和发送器 | 当前文档主动协作使用 [document-collaboration-transport](../src/lib/browser/document-collaboration-transport.ts)；共享完成通知及服务端 review worker/queue 仍由代码协作、恢复和健康检查使用 | 旧浏览器记录不触发自动审阅、不阻塞保存；主动协作、代码后台回执和历史研究数据继续可用 |
| 独立课程生成旧页面 | [旧 generate 地址](../src/app/teacher/prepare/[id]/generate/page.tsx)保留跳转到当前备课入口 | 老书签和已有链接仍有效，不因删除旧 UI 而移除兼容路由 |

长期保留必要回归测试、最小脱敏样例、迁移、许可证、备份恢复工具和当前合同。截图、测试报告、模型调用原始输出与运行备份按[版本管理范围](../README.md#版本管理范围)留在本地受保护或忽略目录；改变其 Git 跟踪状态不等于可以删除服务器上的实际数据。
