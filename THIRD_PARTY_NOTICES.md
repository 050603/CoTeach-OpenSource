# 第三方来源与许可

CoTeach 自有代码及文档采用 [Apache License 2.0](LICENSE)，Copyright 2026 李科骏；作者单位为北京师范大学，项目署名见 [NOTICE](NOTICE)。本文件记录引入的第三方代码、字体和资源。各第三方文件保留自己的许可，项目的 Apache-2.0 许可不覆盖或取消这些条款。

工作区包版本以各自 `package.json` 为准，安装依赖以 [pnpm-lock.yaml](pnpm-lock.yaml) 为准。[licenses/README.md](licenses/README.md) 记录随仓库保存的许可原文及来源。不同组件有各自的署名、源码提供或其他条件，不能将所有内容统一声明为 Apache-2.0 或 MIT。

## 工作区代码

| 内容 | 来源及许可 | 本地范围与维护要求 |
| --- | --- | --- |
| OpenMAIC | [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)，Copyright (c) 2026 THU-MAIC，MIT | `packages/@openmaic/{dsl,generation,importer,renderer}` 各自保留 `LICENSE`；应用中的 OpenMAIC 适配、移植代码及其已有提示词也需保留上游归属。[MIT 原文](licenses/OpenMAIC-MIT.txt)，版本与本地改动边界见 [OpenMAIC 集成](docs/openmaic-upstream.md)。MIT 不替代下文列出的其他来源许可。 |
| PptxGenJS `4.0.1` | [gitbrent/PptxGenJS](https://github.com/gitbrent/PptxGenJS)，MIT | [源码头部](packages/pptxgenjs/src/pptxgen.ts) 保留完整许可、Brent Ely 及 OfficeGen / Ziv Barber 归属；[独立 LICENSE](packages/pptxgenjs/LICENSE) 从该头部提取，便于打包时保留。本地包含定制修改，分发子包或打包产物时仍需保留这些声明。 |
| mathml2omml `0.5.0` | [fiduswriter/mathml2omml](https://github.com/fiduswriter/mathml2omml)，Johannes Wilm，LGPL-3.0-or-later | [工作区源码](packages/mathml2omml/src)、[LGPL 原文](packages/mathml2omml/LICENSE) 和 [GPL v3 原文](licenses/GPL-3.0.txt) 随源代码保留。应用通过 [latex-to-omml.ts](src/lib/openmaic/export/latex-to-omml.ts) 使用该库。分发浏览器 bundle、容器或安装包时，还需满足实际链接与分发方式对应的源码、修改和重新组合要求；不能仅凭本仓库包含源码便声称所有产物已完成合规。 |
| omml2mathml `1.3.1-openpbl.1` | 基于 [scienceai/omml2mathml](https://github.com/scienceai/omml2mathml) `1.3.0`，Robin Berjon，Apache-2.0 | [源码及修改说明](packages/omml2mathml/README.md)、[许可原文](packages/omml2mathml/LICENSE)。CoTeach fork 替换旧 DOM 依赖；版本和本地安全维护身份已在包元数据保留。其 `xpath` 依赖另有许可，见下文。 |

## 已替换的历史集成

本次公开发行使用不包含旧 Git 历史的新仓库快照；下面的旧实现已在当前源码中替换或移除，旧代码不随此快照分发。替换依据是 CoTeach 既有接口、数据结构和行为回归；保留 OpenMAIC 整体来源声明，不把历史片段改称 MIT。以下记录用于说明来源边界，不将旧代码待补证据列为当前快照的发布阻塞。

| 历史来源 | 当前处理及仍需保留的边界 |
| --- | --- |
| React Bits `Stack` | [course-build-animation.tsx](src/components/teacher/course-build-animation.tsx) 和 [stage-generation-card-stack.tsx](src/components/teacher/stage-generation-card-stack.tsx) 已改用本项目的 [GenerationCardDeck](src/components/teacher/generation-card-deck.tsx)：固定纸张背景、按时间淡入当前卡片，保留生成状态、减少动态效果偏好和当前卡片操作按钮；旧的卡片重排及弹簧堆叠实现已移除。[React Bits 原文](licenses/react-bits-LICENSE.md) 作为历史来源记录保留，其 MIT + Commons Clause 附加条件不能从旧版本中删除。保存的原文对应上游 `d965399df489c7b8da3874e07d716c0d98ab39fd`，最初采用的 `Stack` 提交仍未记录。 |
| PPTist `StaticTable.vue` 与 snapshot store | [StaticTable.tsx](src/components/openmaic/slide-renderer/components/element/TableElement/StaticTable.tsx) 按现有 DSL 网格直接生成原生表格，保留合并单元格、锚点、主题及单元格样式优先级；[snapshot.ts](src/lib/openmaic/store/snapshot.ts) 改为串行命令与原子事务写入的有界时间线，保留撤销、重做、分支截断、页面焦点和 20 项上限。旧移植实现已替换。PPTist 的[当前许可证快照](https://github.com/pipipi-pikachu/PPTist/blob/89d664748a8dc8ae8e3d0ace902f9017ed10da2e/LICENSE) 为 AGPL v3，历史许可曾改变；本地原始采用提交和授权仍未确认，不能据当前实现反推旧提交的适用许可。 |
| `learn-your-way/concept_to_html.py:287-385` | 包内 [interactive-post-processor.ts](packages/@openmaic/generation/src/interactive-post-processor.ts) 已重新实现为 KaTeX 原生分隔符解析与 DOM 变更触发的渲染，不再使用原先的文本替换及脚本占位算法。[应用入口](src/lib/openmaic/generation/interactive-post-processor.ts) 复用此实现并指定同源数学资源，保留本项目的 Pyodide 加载处理。旧注释没有提供可核对仓库、提交或许可证，原始来源仍不能用于推定旧代码具有再分发授权。 |
| tldraw 同步原型 | 当前发行版已移除未接入客户端的 `@tldraw/sync-core`、`@tldraw/tlschema` 依赖及服务实现；既有课堂 WebSocket 和历史 board 快照字段继续保留，见[功能状态](docs/feature-status.md)。[tldraw 5.2.5 原文](licenses/tldraw-5.2.5-LICENSE.md) 保留为历史记录。旧版 `sync-core` 使用自定义许可，默认不允许生产用途；不得把旧原型重新启用或分发为无需单独许可的生产功能。 |

上述替换不授予历史代码新的许可。若以后另外发布含旧实现的 Git 历史、旧版本或旧构建产物，维护者仍须核对采用版本及授权，不能沿用当前快照的许可判断。

## 字体

六个本地 WOFF2 文件及各自原文已位于 [public/fonts/openmaic](public/fonts/openmaic/NOTICE.txt)，上游转换及嵌入元数据说明见 [renderer/FONTS.md](packages/@openmaic/renderer/FONTS.md)。字体许可独立于渲染器 MIT：

| 字体 | 许可与声明 |
| --- | --- |
| SourceHanSans、SourceHanSerif、LXGWWenKai、ZhuQueFangSong | [SIL OFL 1.1](public/fonts/openmaic/font-licenses/OFL.txt)；保留对应权利人、保留字体名称及适用的修改条件。 |
| WenDingPLKaiTi / AR PL KaitiM GB | [Arphic Public License 1999](public/fonts/openmaic/font-licenses/ARPHIC-PL.txt)；保留转换说明及原文。 |
| ZcoolHappy / 站酷快乐体 | [站酷授权与设计者署名](public/fonts/openmaic/font-licenses/ZcoolHappy-LICENSE.txt)；保持原字体名称及署名，不单独转售字体。 |

`@fontsource/*` 字体包另带 OFL 许可。使用或分发构建后的字体文件时，也须保留对应包的版权及许可，不能只保留上述六个文件的声明。

## 图像、品牌与教学样例

`public/openmaic/` 中 44 个已跟踪图像的 Git blob 与 [OpenMAIC `e693e11a81644f84c258df73dbda378643520a62` 的 public 目录](https://github.com/THU-MAIC/OpenMAIC/tree/e693e11a81644f84c258df73dbda378643520a62/public) 完全一致：14 个 PNG 头像、28 个供应商图标，以及 `logo-horizontal.png`、`openmaic-mark.png`。本地目录比上游增加了 `openmaic/` 前缀。这一比对确认复制来源，不构成对各品牌商标的额外授权。

- 供应商名称和 `public/openmaic/logos/` 图标用于识别对应服务，不表示提供方为 CoTeach 背书；第三方商标权仍属于各权利人。`bedrock.svg` 是上述 OpenMAIC [同名图标](https://github.com/THU-MAIC/OpenMAIC/blob/e693e11a81644f84c258df73dbda378643520a62/public/logos/bedrock.svg)（上游 Git blob `1ac0eb30aba78cdb20065e8c0becdf063077e7d6`）图形的简化变体：保留 80×80 画布、绿色背景、白色图形和 `(12, 12)` 平移，删除分组标识并简化路径坐标；不属于前述 44 个字节完全一致的文件。AWS 服务图标的官方来源见 [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/)，不将其视为 CoTeach 自有品牌或无限制的商标授权。
- 维护者已明确确认自有 CoTeach 品牌图 `public/brand/coteach/*.png`、应用图标 `src/app/icon.png`，以及两张定制 AI 头像 `public/openmaic/avatars/ai-teammate.webp`、`public/openmaic/avatars/openpbl-ai-teacher-female.webp` 具有随项目公开分发的权利。此确认不指定具体著作权主体、不替项目选择总许可证，也不授予第三方供应商商标权；产品使用规范见[品牌说明](docs/brand.md)。
- `e2e/fixtures/prelaunch-video.webm` 由[仓库生成器](scripts/generate-playback-fixture.mjs)从零绘制几何图形并合成音调，未使用第三方图像、摄影或录音；内容与复现方式见[浏览器回归素材说明](e2e/fixtures/README.md)。
- 八份教学 JSON 及关联测试中的长说明已改写为回归专用合成材料，保留概念、流程、归属、恢复和容量负例条件；未分发真实教材正文、原始模型响应或课堂记录。范围和保留的验证条件见[蓝图样例](src/lib/course-design/__fixtures__/README.md)、[证据列表](src/lib/textbook/__fixtures__/README.md)与[容量和排版样例](src/lib/openmaic/generation/__fixtures__/README.md)。模拟输入的来源字段不表示引用外部教材；教师上传权限、课堂使用许可与公开再分发许可仍需分别处理。
- 运行时上传的教材、学生作品、课堂录音、生成课程及媒体不因软件开源而一并授权公开；其保存和排除规则见 [版本管理范围](README.md#版本管理范围)。

## 安装依赖与发行产物

常规 npm 依赖由锁文件安装，许可原文随各包保存。仅列少数依赖不能替代发行物清单；制作容器、压缩包、浏览器 bundle 或离线安装包时，应按实际纳入内容保留相应 notices、许可和必要源码。

当前需特别留意：

| 依赖 | 许可边界 |
| --- | --- |
| `elkjs@0.12.0` | 包声明 `EPL-2.0 OR GPL-3.0-or-later`。本项目按 [既有来源说明](docs/slide-spatial-sources.md) 使用 EPL-2.0 路径；保留包许可、上游来源及对应源码取得方式。 |
| `xpath@0.0.24` | 通过 `packages/omml2mathml` 安装，包元数据和 `xpath.js` 头部为 CC-BY-SA-2.0，原作者 Cameron McCormack。其署名与相同方式共享条款独立于外层 Apache-2.0 包，发布打包产物时须核对。 |
| `sharp` 使用的 `@img/sharp-libvips-*` | 当前 Linux x64 包 `1.3.2` 为 LGPL-3.0-or-later；随平台变化的二进制及其 notices/source 要求按实际发行平台检查。 |
| `jszip`、`dompurify` | 当前分别声明 `MIT OR GPL-3.0-or-later`、`MPL-2.0 OR Apache-2.0`；双重许可不是要求同时套用所有分支，选定路径后仍需保留相应许可。 |
| `caniuse-lite` | CC-BY-4.0；如果实际分发包含该数据，保留相应署名与许可。 |
| `khroma@2.1.0` | 包元数据缺少 `license` 字段，扫描工具可能显示 Unknown；实际包内 `license` 为 MIT，Copyright (c) 2019-present Fabio Spampinato, Andrew Maney。 |

可用 `pnpm licenses list --prod --json` 检查安装依赖，并结合工作区包、包内许可原文和被复制进源码的片段人工复核。此命令不会自动完成素材授权、代码来源或整个发行版兼容性的判断。
