# PPTX 导入器设计合同

`@openmaic/importer` 将 `.pptx` 文件解析为中间 JSON，再通过 `import-pipeline` 转换为 OpenMAIC DSL。公开接口、媒体持久化与验证命令见 [README.md](README.md)。

## 解析管线

```
.pptx (ArrayBuffer)
  ↓  parser/ZipParser ── 解压 zip，按用途分类
PptxFiles
  ↓  model/* ── XML → 结构化模型（位置、大小、层级）
PresentationData
  ↓  serializer/* ── 模型 + 主题/模板上下文 → JSON 元素
Element[]
  ↓  adapter/toPptxtojson ── 组装最终输出
Output { slides, themeColors, size }
```

入口：`src/index.ts` → `parse(buffer, options?)`

## 分层职责

| 层 | 目录 | 做什么 | 不做什么 |
|---|---|---|---|
| **parser** | `src/parser/` | zip 解压、XML 解析（SafeXmlNode）、rels 映射、单位换算 | 不解析 OOXML 业务语义 |
| **model** | `src/model/` | 解析几何与结构：位置、大小、旋转、占位符、节点类型 | 不解析视觉样式（颜色、字体、填充） |
| **serializer** | `src/serializer/` | 结合 theme/master/layout 上下文，把模型转成 JSON 元素；按需解析媒体与嵌入公式资源 | 不负责初始 PPTX 解包和整体文件分类 |
| **adapter** | `src/adapter/` | 定义对外 JSON 类型，组装最终 Output | 不写业务逻辑 |
| **shapes** | `src/shapes/` | 生成 SVG path 字符串（200+ preset + 自定义几何） | 不决定填充/边框 |
| **utils** | `src/utils/` | 通用工具（颜色变换、媒体格式、EMF 解析、EQ 公式等） | 不引用业务类型 |

依赖方向：`adapter → serializer → model → parser`，单向。`shapes` 和 `utils` 是底层工具。

## 目录结构

```
src/
├── index.ts                    # 入口：parse() + 类型导出
├── adapter/
│   ├── types.ts                # ★ 对外 JSON 类型定义（改它 = 改协议）
│   └── toPptxtojson.ts         # 组装 Output
├── parser/
│   ├── ZipParser.ts            # .pptx → PptxFiles
│   ├── XmlParser.ts            # SafeXmlNode（null-safe DOM 包装）
│   ├── RelParser.ts            # .rels 关系映射
│   └── units.ts                # EMU / pt / px / 角度换算
├── model/
│   ├── Presentation.ts         # 组装 theme → master → layout → slide 链
│   ├── Theme.ts / Master.ts / Layout.ts / Slide.ts
│   └── nodes/                  # 各节点类型解析器
│       ├── BaseNode.ts         # 共用属性（位置、大小、旋转、xmlOrder）
│       ├── ShapeNode.ts        # sp / cxnSp
│       ├── PicNode.ts          # pic
│       ├── TableNode.ts / ChartNode.ts / GroupNode.ts / MathNode.ts
├── serializer/
│   ├── RenderContext.ts        # 每页渲染上下文（slide → layout → master → theme）
│   ├── slideSerializer.ts      # 编排：背景 → master 装饰 → layout 装饰 → slide 元素
│   ├── shapeSerializer.ts      # ★ Shape/Text 判定、preset 路径、自适应
│   ├── textSerializer.ts       # TextBody → HTML 富文本
│   ├── tableSerializer.ts      # 表格样式级联
│   ├── chartSerializer.ts      # 图表数据提取
│   ├── imageSerializer.ts      # 图片/视频/音频
│   ├── mathSerializer.ts       # OMML → LaTeX
│   ├── groupSerializer.ts      # ★ 坐标空间缩放 + flip/rotation 烘焙
│   ├── StyleResolver.ts        # 颜色/填充 → CSS
│   ├── backgroundSerializer.ts # 背景填充
│   └── borderMapper.ts         # 线型 → dasharray
├── shapes/
│   ├── presets.ts              # 200+ OOXML preset 几何
│   ├── customGeometry.ts       # 自定义几何 → SVG path
│   └── shapeArc.ts             # 弧形计算
├── utils/
│   ├── color.ts                # OOXML 颜色变换全套
│   ├── media.ts                # MIME / 路径
│   ├── mediaWebConvert.ts      # TIFF/EMF/JXR → PNG
│   ├── emfParser.ts            # EMF 内嵌提取
│   ├── eqFieldParser.ts        # Word EQ 域公式 → LaTeX
│   ├── rgbaToPng.ts            # RGBA → PNG 编码
│   └── urlSafety.ts            # 外链白名单
├── export/
│   └── serializePresentation.ts  # 调试用：扁平化输出
└── types/
    └── vendor-shims.d.ts
```

★ 标记的是定位问题时最常修改的文件。

## 核心设计点

### 模型层不感知样式
`model/*` 只解析"是什么、在哪里、多大"。视觉样式（颜色、字体、填充）留给 serializer 层，因为需要 theme/master/layout 的级联解析。

### Serializer 转换边界
`*ToElement(node, ctx, order)` 根据模型与上下文解析样式并输出 JSON 元素。媒体和公式分支可能异步读取、转换资源、创建 Blob URL 或写缓存；例如公式预取可请求 texmath 服务，并读取嵌入 DOCX 中的 XML。排查时跟踪模型、上下文、序列化及 DSL 转换，不能将所有分支视为无副作用的纯函数。

### Group 坐标烘焙
`groupSerializer.ts` 处理两件事：
1. **chOff/chExt 缩放**：子元素坐标从 group 内部坐标系映射到外层坐标
2. **flip/rotation 烘焙**：group 的变换折算进子元素，输出的 group 始终中性（`rotate:0`, `isFlipH/V:false`）

### 元素层级（order）
`layoutElements`（master + layout 装饰）和 `elements`（slide 内容）分开输出。`layoutElements` 内部，layout 元素的 order 会加偏移量，保证始终在 master 元素之上。每个元素的 `order` 来自 `xmlOrder`（文档深度优先遍历索引）。

### 单位约定
- 对外 JSON 一律 **pt**（`left/top/width/height`）
- 纯色通常使用 `#RRGGBB`；透明度、无填充与渐变按对应字段或 CSS 表达，可出现 `rgba(...)`、`transparent` 等值。角度使用 deg。
- 解析几何内部以 px 表示，输出边界转换为 pt：页面尺寸在 adapter、元素几何在对应 serializer。DSL 转换再按 `96 / 72` 从 pt 转回 CSS px。

## 输出结构概览

完整类型定义见 `src/adapter/types.ts`。

| `type` | 关键字段 |
|---|---|
| `text` | `content`(HTML), `vAlign`, `isVertical`, `autoFit` |
| `shape` | `shapType`, `path`, `keypoints`, `content`, `vAlign` |
| `image` | `src`, `geom`, `rect`(裁切), `filters` |
| `table` | `data[][]`, `borders`, `rowHeights`, `colWidths` |
| `chart` | `chartType`, `data`, `colors` |
| `group` | `elements[]`（坐标已转换，变换已烘焙） |
| `math` | `latex`, `picBase64`, `text` |
| `video`/`audio` | `src`, `blob` |

## 文本序列化

[textSerializer.ts](src/serializer/textSerializer.ts) 的 `renderTextBody` 接收 `TextBody`、可选占位符与 `RenderContext`，返回富文本 HTML，供形状和表格序列化使用。它不创建浏览器 DOM，不直接读取压缩包。

段落按母版默认样式、母版占位符类别样式、母版匹配占位符、版式匹配占位符、当前形状列表样式、段落属性依次覆盖。Run 在继承的 `defRPr` 上合并自身 `rPr`；仍缺字色时核对当前列表级别的默认字色。段落、字号和颜色问题应核对完整继承链，不能只查看当前 run。

输出保留对齐、缩进、行距、段距、项目符号、字体效果和空白。绝对行距与段内换行可使用固定高度行盒，其他段落使用 `<p>`；禁止产生 `<p>` 内嵌块级元素的无效结构。`normAutofit` 的字号与行距压缩、符号字体和占位符项目符号规则由实现及对应回归约束。

表格调用方传入单元格默认字色、粗体和边距，保留 HTML 与单元格样式的一致性；run 显式样式优先，不能把当前表格输出描述为仅有纯文本。超链接经 [urlSafety.ts](src/utils/urlSafety.ts) 校验，允许 `http:`、`https:` 和 `mailto:`，输出携带 `target="_blank"` 与 `rel="noopener noreferrer"`。

当前维护依据是本仓库的序列化器、DSL 转换、渲染器和 `test/` 回归；历史外部 `TextRenderer` 对照不作为当前实现已完全等价的证明。

## 参考实现

- [当前适配协议](src/adapter/types.ts)和 [回归样本](test/)：公开源码快照以当前协议、实现和样本为准，不依赖私有维护仓库的旧实现或 Git 历史。

## 脚本

以下命令在本包目录执行；从仓库根使用 `pnpm --dir packages/@openmaic/importer` 调用。

| 命令 | 用途 |
|---|---|
| `pnpm exec tsx scripts/transvert.ts <file.pptx> [out.json]` | 用本库解析（直接跑源码无需构建） |
| `node scripts/extract-pptx-structure.js <file.pptx> [outDir]` | 解压 .pptx 查看源 XML |
| `pnpm build` | Rollup 打包 + 生成 .d.ts → dist/ |
| `pnpm lint` | ESLint 检查 |
