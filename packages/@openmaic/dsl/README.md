# @openmaic/dsl

CoTeach 工作区的共享幻灯片与场景契约，提供 TypeScript 类型、结构校验、内容规范化、JSON Schema 和纯迁移函数。包没有运行时依赖；生成包、导入器和渲染器依赖本包，应用负责账号、课堂状态、存储和模型调用。

## 入口与职责

公开导出以 [src/index.ts](src/index.ts) 为准。

| 文件 | 契约 |
| --- | --- |
| [slides.ts](src/slides.ts) | `Slide`、`PPTElement`、画布、主题、文本、图片、表格、图表等页面结构 |
| [stage.ts](src/stage.ts) | `Stage`、`Scene`、幻灯片与测验内容；场景 `type` 与内容 `type` 必须匹配 |
| [interactive.ts](src/interactive.ts)、[pbl.ts](src/pbl.ts) | 互动组件的最小扩展接口、PBL 设计与初始结构；具体组件载荷和学生运行状态由应用维护 |
| [action.ts](src/action.ts) | 讲解、激光、聚光、白板、视频、讨论和组件动作，以及动作分类与类型守卫 |
| [guards.ts](src/guards.ts)、[validate.ts](src/validate.ts) | 元素类型守卫，场景、动作和运行记录的结构校验 |
| [normalize.ts](src/normalize.ts) | `ELEMENT_DEFAULTS` 与元素、页面、场景、课堂内容规范化 |
| [version.ts](src/version.ts) | 文档和运行会话各自的版本标记、迁移链与版本读取 |
| [storage.ts](src/storage.ts)、[runtime.ts](src/runtime.ts) | 资源引用、存储接口及学习者会话/记录的类型契约 |

```ts
import type { Slide, PPTElement, Action } from '@openmaic/dsl';
import { isTextElement, validateScene, normalizeSlide } from '@openmaic/dsl';
```

`Scene` 默认内容为 `SlideContent | QuizContent`，需要互动或 PBL 的调用方显式拓宽内容联合：

```ts
import type {
  Action, InteractiveContent, PBLContent, Scene, SceneContent, WidgetConfigBase,
} from '@openmaic/dsl';

interface AppWidgetConfig extends WidgetConfigBase { featurePayload?: unknown }
type AppContent = SceneContent | InteractiveContent<AppWidgetConfig> | PBLContent;
type AppScene = Scene<Action, AppContent>;
```

## 校验、规范化与 Schema

`validateStage`、`validateScene`、`validateAction` 返回 `{ valid: true }` 或 `{ valid: false, errors }`；每项错误包含 `path` 和 `message`。这些纯函数检查必填字段、判别类型及结构关系；完整字段值约束还需结合 Schema，结构有效不等于教学正确或实际布局可用。

`normalizeElement`、`normalizeSlide`、`normalizeScene`、`normalizeStage` 补齐内容默认值及可推导几何，保持纯函数、幂等；已提供但类型错误的字段会报错。元素身份和基础几何仍由生产者提供，规范化不能替代完整校验。图片真实尺寸与媒体持久化仍由导入/生成边界负责。

需要逐元素容错时显式使用 `normalizeSlideWith({ onInvalid: 'drop', onDropped })` 并记录被丢弃元素；默认 `normalizeSlide` 保持单参数，允许 `slides.map(normalizeSlide)`。

构建脚本 [gen-schema.mjs](scripts/gen-schema.mjs) 从类型生成三个文件：

| 导出路径 | 根类型 |
| --- | --- |
| `@openmaic/dsl/schema/stage.schema.json` | `Stage` |
| `@openmaic/dsl/schema/scene.schema.json` | `SerializedScene`，包含幻灯片、测验、互动和 PBL |
| `@openmaic/dsl/schema/action.schema.json` | `Action` |

Schema 供调用方选择的 JSON Schema 校验器使用，生成工具只是开发依赖。兼容历史 PBL 附加字段的范围由该脚本明确限定，不能把默认 `Scene` 联合误认为序列化 Schema 的全部类型。

## 版本与迁移

包版本见 [package.json](package.json)，序列化版本见 [version.ts](src/version.ts)，二者用途不同；页面内的 `SlideContent.schemaVersion` 又由应用画布迁移负责。

| 数据 | 版本字段 | 当前版本 | 迁移入口 |
| --- | --- | --- | --- |
| 页面文档 | `dslVersion` | `0.2.0` | `migrate`、`dslVersionOf`、`needsMigration` |
| 学习者运行会话 | `runtimeDslVersion` | `0.1.0` | `migrateRuntime`、`runtimeDslVersionOf`、`needsRuntimeMigration` |

文档迁移链包含无标记文档到 `0.1.0`、再到 `0.2.0` 的版本标记步骤。`0.2.0` 契约移除 `audioUrl`，但纯迁移函数保留旧数据中的该字段：它可能仍是有效音频的唯一来源，资源可达性与转换需由实际持久化调用方处理，不能仅更新版本号便删除旧资源。

运行会话必须从创建起带自身版本，不接受没有版本标记的对象，也没有文档式的旧数据提升步骤。两条版本线互相隔离：仅带另一条版本标记的对象会被拒绝。迁移幂等、对未来版本不降级；缺失迁移路径或畸形标记会抛错。迁移链的 `from` / `to` 使用固定值，不能引用会变化的最新版本常量。

## 存储与学习记录边界

`StorageProvider` 定义 `put` / `resolve` / `remove`；成功 `put` 分配新引用，`resolve` 对未知引用返回 `null`。这里提供类型契约，不提供数据库或文件存储实现。

`RuntimeSession` 表达学习者、课堂、用途与生命周期，`RuntimeRecord` 表达会话中的有序事实；重放按存储端分配的 `seq` 排序，时间字段为 ISO 字符串。文档中的场景或动作可能被编辑，消费方应容忍失效锚点。

本仓库未包含 `@openmaic/storage` 或 `@openmaic/exporter` 工作区包。CoTeach 实际持久化、研究记录和图片 PPTX 导出由应用实现，见[数据库设计](../../../docs/database.md)、[研究导出](../../../docs/database/research-export.md)和[使用说明](../../../docs/user-guide.md)。类型契约的存在不表示应用已经采用另一套学习记录存储。

## 构建与验证

从仓库根执行：

```bash
pnpm --filter @openmaic/dsl build
pnpm --filter @openmaic/dsl build:schema
pnpm --filter @openmaic/dsl typecheck
pnpm --filter @openmaic/dsl test
```

`build` 先生成 ESM 与类型，再生成 Schema；`build:schema` 仅更新 Schema。共享契约变化还需验证实际生产者和消费方，按[开发工作流](../../../docs/agent-workflow.md)选择导入、生成与渲染回归。

包采用 [MIT 许可](LICENSE)。其他包、字体与集成资源沿用各自许可，不能由本包许可推断整个平台的授权范围。
