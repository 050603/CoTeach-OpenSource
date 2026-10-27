# 多终端界面与课堂流程验证

`scripts/check-desktop-layout.mjs` 使用实际本机页面与浏览器内数据夹具，覆盖首页、师生登录注册、课程列表与详情、教师课程设置弹窗、学生课程返回导航/提醒弹层/账号菜单、个人中心、学生名单及详情、课程库、问卷填写和四类统计图表（含展示模式）。

## 按改动选择检查

| 检查范围 | 入口 | 证据边界 |
| --- | --- | --- |
| 平台页面及手机、平板布局 | [运行](#运行)与[检测与证据](#检测与证据) | 真实浏览器与资源，业务 API 使用夹具 |
| 内部教学、编辑器、图片失败 | [教学与素材检查](#内部教学与素材故障验证) | 注入故障单独统计，不改真实业务数据 |
| Chrome、Edge 与缩放 | [原生缩放](#chromeedge-与原生缩放)、[桌面矩阵](#仅桌面-chromeedge-上线检查) | 实际品牌浏览器，不等同于真机系统缩放 |
| 知识学习完成后的回顾 | [回顾专项](#学生结课与回顾专项) | 一次性数据库、真实保存与恢复、并发浏览器 |
| 师生联动、保存提交、真实 AI | [隔离业务验证](#隔离业务师生联动与真实-ai) | 根据显式开关区分真实业务、WebSocket 和供应商调用 |
| 投屏同步时延 | [投屏验收](projection-sync-validation.md) | 使用独立账号的实际课堂，记录请求到渲染时延 |

执行前核对目标构建、需要的浏览器、端口和配置。夹具检查、隔离业务验收、真实模型调用与生产容量分别记录；一个入口通过不能代替另一类证据。变更与测试选择总则见[开发工作流](agent-workflow.md)。

## 运行

先完成生产构建和本机服务同步，再验证实际运行产物：

```bash
node scripts/check-desktop-layout.mjs --assert
```

默认使用 Chromium，检查 13 个桌面分辨率、平板横竖屏、390/320 像素手机横竖屏。移动设备使用对应的 User-Agent、触控与移动视口配置，每个场景重新访问页面；登录旋转场景还检查横竖切换后学号输入值仍保留。WebKit 可单独运行：

```bash
LAYOUT_BROWSER=webkit LAYOUT_DEVICES=pad-portrait,pad-landscape,phone-portrait,phone-landscape node scripts/check-desktop-layout.mjs --assert
```

可按场景和设备缩小回归范围：

```bash
LAYOUT_SCENARIOS=home,student-login-rotation,teacher-course-dialog LAYOUT_DEVICES=phone-portrait,phone-landscape node scripts/check-desktop-layout.mjs --assert
```

`--source-css` 将工作区平台样式加入页面，只适合构建前检查；上线验收应去掉此参数，确认服务加载的是构建产物。脚本只接受本机地址；可通过 `LAYOUT_BASE_URL` 选择其他本机端口。页面登录门禁使用本机 JWT 密钥签发不存在于数据库的夹具身份，密钥和 Cookie 不进入报告。

## 检测与证据

- 页面横向溢出、关键容器内容溢出、弹窗超出屏幕、文字云裁切、柱图交互宽度。
- 自然长中文标题的宽度和行数、意外文字溢出或被挤成极窄多行；明确配置的省略号和行数截断允许保留。
- 页面 JavaScript 异常、HTTP 失败资源、网络失败、页面图片加载与解码（包括屏外图片）、资源耗时及传输体积。
- 首页和课程夹具使用仓库实际静态图片，图片资源经过应用真实服务加载。

结果持续写入 `/tmp/openpbl-responsive-*/report.json`，末尾生成 `summary.json`；失败场景及主要桌面/移动设备保存截图。`--assert` 在检测失败时返回非零状态。预期可横向滚动的内部容器不等同于页面溢出。

所有业务 API 都在浏览器内拦截：读取返回显式夹具，未定义读取和业务修改被记录并使检查失败；注册邀请码查询作为只读操作返回夹具。脚本不会创建账号、修改课程或提交真实作答。

这套检查验证所列页面、样例内容和浏览器引擎，不替代真实设备软键盘、安全区域、弱网、超大课件及生产数据的专项验收；资源耗时是本机测量值，不作为外网加载性能承诺。

## 内部教学与素材故障验证

```bash
node scripts/check-teaching-layout.mjs --assert
node scripts/check-image-stability.mjs
LAYOUT_BROWSER=webkit node scripts/check-image-stability.mjs
```

内部教学脚本覆盖备课生成与配置、课程发布预览、教师授课、学生课堂菜单、代码协作以及真实学生播放器。检查桌面、平板横竖屏、390/320手机横竖屏，包含步骤切换、文件管理、AI组员面板、页面目录收起和课堂菜单；同时检测画布被压扁、正文挤成竖排以及字幕与播放按钮裁切。`TEACHING_DEVICES` 和 `TEACHING_SCENARIOS` 可筛选受影响场景。

素材脚本在桌面和手机上主动模拟封面404、延迟响应和恢复URL，验证替代插画、图片解码以及卡片/封面/正文的位置与尺寸。预期注入的404与意外失败分开记录。图片失败时的替代显示保证页面可读，不代表已恢复远程原文件。

三个脚本均保留严格失败状态，生成本机临时JSON报告与截图；源码样式注入只用于定位问题，最终验证使用实际构建产物。WebKit的设备上下文不固定 `screen`，以便旋转测试同时更新布局屏幕尺寸；保留视口溢出和输入内容保持断言。

WebKit 检查需要浏览器系统依赖；页面与图片测试的通过不代表音视频播放和解码已验收，后者需要独立的播放证据。

## Chrome、Edge 与原生缩放

正式品牌浏览器验收必须指定真实可执行文件，不能用 Chromium 或覆盖 User-Agent 代替。隔离业务脚本、原生缩放测试及统一审计入口均核对可执行文件的 `--version` 和浏览器运行时身份；错标立即失败。

```bash
PRELAUNCH_E2E_EXECUTABLE_PATH=/absolute/path/to/chrome \
PRELAUNCH_E2E_BROWSER_LABEL=google-chrome \
OPENPBL_RESOURCE_E2E_BASE_URL=http://127.0.0.1:3000 \
pnpm exec playwright test e2e/branded-native-zoom.spec.ts --workers=1
```

Edge 使用其实际路径与 `PRELAUNCH_E2E_BROWSER_LABEL=microsoft-edge`。原生缩放采用临时浏览器用户目录的原生页面缩放配置，固定外窗大小，验证 80%、90%、100%、110%、125%、150%、175%、200% 下实际 CSS 视口、DPR 和截图；不设置 CSS zoom、CDP pageScale 或模拟 viewport。测试包含师生登录、课程设置、学生问卷、真实播放器组件、助教错误与重试、中文输入组合态、焦点圈定与恢复，以及代码和文档协作保存错误与恢复。全部业务响应为浏览器内显式夹具，不能据此声称真实后端保存或真实 AI 通过。

统一布局入口支持顺序运行两个真实浏览器，并将 DPR 检查与等效缩放视口分别标记：

```bash
PRELAUNCH_BROWSERS=google-chrome,microsoft-edge \
PRELAUNCH_CHROME_EXECUTABLE_PATH=/absolute/path/to/chrome \
PRELAUNCH_EDGE_EXECUTABLE_PATH=/absolute/path/to/msedge \
PRELAUNCH_REUSE_BUILD=1 \
node scripts/run-prelaunch-audit.mjs --browser-only --with-zoom
```

`--with-zoom` 仅为等效视口回归；原生缩放仍使用上述 Playwright 测试。桌面默认包含 768×576、1024×576 等分屏和低高度场景；完整手机、平板矩阵可通过原有设备筛选单独运行。原生缩放并不等于 Windows/macOS 系统缩放或真机输入法、外接投影仪验收。

## 仅桌面 Chrome、Edge 上线检查

```bash
PRELAUNCH_BROWSERS=google-chrome,microsoft-edge \
PRELAUNCH_CHROME_EXECUTABLE_PATH=/absolute/path/to/chrome \
PRELAUNCH_EDGE_EXECUTABLE_PATH=/absolute/path/to/msedge \
PRELAUNCH_OUTPUT_DIR=test-results/desktop-compat/final \
node scripts/run-prelaunch-audit.mjs --desktop-compat
```

此入口只选择桌面场景。100% 下覆盖 768×576、1024×576、1024×768、1280×720、1280×800、1366×768、1440×900、1536×864、1920×1080、1920×1200、2560×1440、3440×1440、3840×2160；1366×768 与 1920×1080 下覆盖原生 80%、90%、100%、110%、125%、150%，以及核心场景的 175%、200%。独立 DPR 1.25、1.5、2 检查保持 100% 页面缩放。固定外窗、实际内容视口、运行时浏览器身份、原生缩放、DPR 和已部署构建编号分别记录，资源与界面检查使用当前服务实际产物。

矩阵使用独立浏览器上下文运行；平台与教学脚本可分别通过 `LAYOUT_WORKERS`、`TEACHING_WORKERS` 设置 1–8 个并行任务，桌面统一入口默认 4。屏外懒加载图片也先启用实际加载再等待解码；HTTP 200 但无法解码仍判失败。字体和图片整体等待上限为 15 秒，超时保留未完成资源诊断并判失败。

独立学生播放器使用应用自托管的六个原始字体，资源与原许可证位于 `public/fonts/openmaic/`，保留原字族和二进制文件；`src/app/openmaic/fonts.css` 与应用的同源字体安全策略配套，不再依赖外部字体 CDN。

入口复用平台、教学、素材故障及 Playwright 场景，包含正常内容、长文本、错误恢复、真实播放器、图表/公式、教材库网格/列表与阅读图谱、课件编辑、文档/代码恢复工具栏和五阶段课堂操作。完整前后测模板、指代说明、学生作答与固定操作栏沿用 `posttest-stage` 桌面回归。`e2e/fixtures/desktop-coverage.ts` 维护师生页面路由与检查的对应关系；库存测试会拒绝遗漏的新页面。Server Component 的开课配置、历史记录需要以下隔离后端检查，浏览器内 API 夹具不能替代这些页面的数据读取：

```bash
PRELAUNCH_REUSE_BUILD=1 PRELAUNCH_DESKTOP_LAYOUT=1 \
PRELAUNCH_E2E_EXECUTABLE_PATH=/absolute/path/to/chrome \
PRELAUNCH_E2E_BROWSER_LABEL=google-chrome \
PRELAUNCH_REAL_PROVIDERS=0 PRELAUNCH_CLASSROOM_AI=0 \
PRELAUNCH_OUTPUT_DIR=test-results/desktop-compat/isolated-chrome \
node scripts/verify-prelaunch-functional.mjs
```

Edge 使用自己的实际可执行文件、标签与输出目录，两个隔离检查顺序执行。开课配置和历史记录执行相同的 13 个尺寸与两种窗口的六档常用原生缩放；其余真实后端和资源链路使用该脚本原有验收场景。使用 `PRELAUNCH_REUSE_BUILD=1` 时必须等生产构建完成后再启动隔离实例。

单独补测可使用 `LAYOUT_NATIVE_ZOOM=1 LAYOUT_ZOOM=1.25` 或 `TEACHING_NATIVE_ZOOM=1 TEACHING_ZOOM=1.25`，同时指定品牌标签、可执行文件及桌面设备筛选；原生模式不得再设置模拟 DPR。素材故障检查支持 `LAYOUT_EXECUTABLE_PATH`、`LAYOUT_BROWSER_LABEL`、`LAYOUT_DEVICES=desktop` 和 `LAYOUT_OUTPUT_DIR`。新增页面专项支持 `OPENPBL_DESKTOP_VIEWPORTS`、`OPENPBL_DESKTOP_SCENARIOS`、`OPENPBL_DESKTOP_NATIVE_ZOOM` 和 `OPENPBL_DESKTOP_DPRS`；现有教材、图谱、助教、课件编辑和后测专项使用 `OPENPBL_E2E_DESKTOP_ONLY=1` 选择桌面矩阵。局部筛选结果只代表实际选择的场景，不能替代完整验收。

本机自动检查不代表 Windows 真机验收。后补复核固定使用 Windows 上的 Chrome、Edge，在 1366×768、1920×1080 屏幕下组合系统显示缩放 100%、125%、150% 与浏览器缩放 100%、125%、150%；检查中文字体、弹窗/下拉菜单、图表/图谱、代码与文档编辑器、全屏进入/退出和窗口拖动后重绘。记录浏览器版本、实际桌面分辨率、系统缩放、页面缩放及结果截图；真机未执行项保持“待复核”。

## 学生结课与回顾专项

这里的“结课”指学生完成知识学习后出现的完成页，课堂仍处于授课状态；脚本核对回顾期间的既有学习事件与重复完成保护。教师结束课堂后的只读复习使用另一条历史课堂路径，不应产生新的学习事件、进度或作答；其行为见[系统架构](architecture.md#教学设计与授课分离)。不能用本专项替代已结束课堂的只读验证。

完成生产构建后，复用隔离后端执行真实 Chrome、Edge 的结课回顾并发与适配验证：

```bash
PRELAUNCH_REUSE_BUILD=1 PRELAUNCH_WEBSOCKET=1 PRELAUNCH_COMPLETION_REVIEW=1 \
COMPLETION_REVIEW_CONTEXTS_PER_BROWSER=5 COMPLETION_REVIEW_PREPARATION_CONCURRENCY=8 \
PRELAUNCH_OUTPUT_DIR=test-results/completion-review \
pnpm exec tsx scripts/verify-prelaunch-functional.mjs
```

此入口使用一次性 PostgreSQL、Redis 和独立应用实例，默认 40 个学生会话（两个浏览器各 20 个）持续至少 3 分钟，验证回顾翻页、刷新恢复、答案与进度隔离、重复完成写入以及学习事件。读取 P95 上限为 1 秒，写入为 2 秒；主动导航取消另行统计。随后每个浏览器检查 13 档桌面、6 档触屏尺寸、两种外窗下的 8 档原生缩放及 3 档独立 DPR，保存动画、结课页和目录截图，以及键盘焦点检查证据。

本机存在 `deploy/secrets/course-read.env` 时，仅继承其中三个读取进程与连接预算数值，显式环境变量可覆盖；隔离实例重新创建只读数据库角色，不复用正式数据库地址。报告记录有效配置及其与已安装配置的对应关系。浏览器沿用容量工具的后台节流设置及独立音频输出，默认每进程最多 10 个隔离学生上下文，共四进程；`COMPLETION_REVIEW_CONTEXTS_PER_BROWSER=1` 可改为每名学生独立浏览器进程，用于核对共用浏览器主进程造成的排队。此设置允许 1–10，报告保留实际进程分组。

可用 `COMPLETION_REVIEW_CONTEXTS_PER_BROWSER=5` 将 40 个会话分在八个浏览器进程中；`COMPLETION_REVIEW_PREPARATION_CONCURRENCY=8` 仅将首次学习的准备工作分批进行，后续真实播放恢复检查与至少三分钟的回顾窗口仍由全部 40 个独立学生同时执行。准备阶段和回顾阶段的错误分别保留，不因准备分批而缩短并发窗口。

适配矩阵轮换使用另一品牌已完成课程的学生身份，通过无本地回顾标记的新上下文验证服务端恢复；同批用不同身份，避免测试自身反复复制单个身份而触发既有 WebSocket 连接与重连限制。只有一个可用来源身份时串行执行，仍保留真实认证及限流错误。

回顾翻页的学习事件立即进入原有本地队列，成功回执后的 1500 毫秒内合并后续批次，事实、采样频率和每批 20 条上限保持不变；完成、页面隐藏或离开时立即发起同步，已发送批次的原样重试也不等待合并窗口。接口响应耗时与事件实际发生到数据库接收的耗时分别报告，不能用前者代替完整交付延迟。

验收使用合成课程及本地生成的提示音，经实际媒体路由播放并完成学习流程；业务写入和结果对账使用真实隔离后端，不调用付费 TTS，也不作为讲稿、语音模型或课程生成质量验收。

浏览器默认使用 `.cache/browsers/` 下已有的真实品牌可执行文件，可通过 `COMPLETION_REVIEW_CHROME_PATH`、`COMPLETION_REVIEW_EDGE_PATH` 指定。`COMPLETION_REVIEW_STUDENTS`、`COMPLETION_REVIEW_MINUTES`、`COMPLETION_REVIEW_LAYOUT=0` 及 `COMPLETION_REVIEW_LAYOUT_CASES` 仅用于缩小调试范围；人数不足 40、时长不足 3 分钟或未完成全部适配时，专项结果标为 `partial`，不能作为完整验收。报告保留在输出目录的 `completion-review.json`，不涉及运行中的业务数据，也不代表 Windows 真机系统缩放验收。

`COMPLETION_REVIEW_MODE=layout` 可独立执行适配矩阵：先由两个真实学生完成隔离课程，再用新的浏览器上下文恢复回顾入口并验证布局。此模式标为 `partial`，不能替代并发验收。完整模式中，性能、资源或浏览器错误会分别记录失败，仍继续适配检查，避免一个门槛失败掩盖其他结果。

## 隔离业务、师生联动与真实 AI

`scripts/verify-prelaunch-functional.mjs` 启动一次性 PostgreSQL、Redis 和独立应用实例；数据库、上传文件、课件与 TTS 缓存均与运行中的系统隔离。`PRELAUNCH_REUSE_BUILD=1` 复用已经完成的生产构建，仍将 standalone 复制到临时运行目录；构建尚未结束时不能启动复制。执行需要 Docker、可用的对应镜像和本机空闲 3198 端口。

```bash
PRELAUNCH_REUSE_BUILD=1 \
PRELAUNCH_E2E_EXECUTABLE_PATH=/absolute/path/to/chrome \
PRELAUNCH_E2E_BROWSER_LABEL=google-chrome \
PRELAUNCH_REAL_PROVIDERS=1 PRELAUNCH_CLASSROOM_AI=1 \
PRELAUNCH_PROVIDER_SECTIONS=providers,tts,asr \
PRELAUNCH_OUTPUT_DIR=test-results/prelaunch/chrome-functional \
node scripts/verify-prelaunch-functional.mjs
```

Edge 单独运行到不同输出目录。真实供应商检查读取既有供应商配置，业务写入仍限于隔离实例。脚本沿用本机配置数据库凭据及出站代理；不可用时记录失败，不能将模拟响应计为通过。默认不执行整门课生成，只有显式 `PRELAUNCH_COURSE_GENERATION=1` 才启用该昂贵且不属于授课适配范围的场景。

默认关闭 WebSocket，浏览器通过 HTTP 轮询恢复课堂状态。设置 `PRELAUNCH_WEBSOCKET=1` 后，脚本独占三个 loopback 端口：3198 为浏览器同源代理，普通 HTTP 请求转发到隔离应用 3197，`/ws` 升级请求转发到隔离 WebSocket 服务 3199。WebSocket 使用同一次性 Redis 与数据库，代理仅绑定 `127.0.0.1`，不修改已安装的反向代理或主服务。多个浏览器运行必须顺序执行，三个端口均须空闲；退出时关闭代理和隔离实例。

WebSocket 模式要求教师和两个学生收到真实订阅确认与课堂事件，主动断开代理中的 TCP 连接，再验证离线学生联网后重新订阅并恢复投屏状态。`three-browser-websocket-evidence.json` 记录实际浏览器收到的消息类型，不使用 WebSocket 路由模拟。`three-browser-console-evidence.json` 按正常连接、主动断线及重连阶段保留浏览器错误；主动取消的状态读取被误报为同步失败时使联动检查失败，注入离线产生的真实网络错误另行记录。`three-browser-response-evidence.json` 保留失败接口及投屏、课堂操作的成功响应，便于区分版本冲突后的自动恢复与未处理错误。只补联动回归时可设置 `PRELAUNCH_LINKAGE_ONLY=1 PRELAUNCH_WEBSOCKET=1 PRELAUNCH_REAL_PROVIDERS=0 PRELAUNCH_CLASSROOM_AI=0`，跳过付费 AI 场景。

只补项目实践链路时使用 `PRELAUNCH_PRACTICE_ONLY=1 PRELAUNCH_REAL_PROVIDERS=0 PRELAUNCH_CLASSROOM_AI=0`，与联动子集或 AI 恢复模式分开运行。它复用隔离数据库和正式开课入口，在真实浏览器中新建 Python/C 文件、编辑保存、清除本机草稿后刷新、调用实际沙盒并核对教师读取的成果；编程工作区的保存直接持久化代码成果，当前没有独立的最终提交按钮。文档检查实际编辑、保存恢复、提交最终版、下载 Word 内容及提交状态持久化。运行器默认使用已有的 loopback `http://127.0.0.1:3002` 和 `deploy/secrets/monitor_token.txt`，可分别由 `PRELAUNCH_CODE_RUNNER_URL`、`PRELAUNCH_CODE_RUNNER_TOKEN_FILE` 指定；仅允许 loopback HTTP，且应等主服务部署及运行器重启完成后执行。代码运行无业务数据库写入，课堂、提交及文档仍只写隔离实例。

实践子集默认运行三种成果模式，可用 `PRELAUNCH_PRACTICE_MODES=python,c,document` 选择需要重验的模式；报告记录实际选择，局部结果不能代替未执行项。它关闭文档后台主动检查且不配置付费供应商；编程工作区自动发起的 AI 建议请求可能因未配置模型而失败，这些响应单列在 `browser-practice-evidence.json`，不计为模型验收，也不替代独立的真实课堂 AI 检查。编辑、保存、运行、提交和资源加载的其他错误仍使对应场景失败。

- 三会话联动使用一个教师、两个学生的独立登录态；教师通过页面开始投屏、翻页、停止投屏、切换阶段，学生验证逐页 PDF 课件实际画布、离线重连和刷新恢复。作答检查独立学生记录及教师读取到的真实进度。
- 课堂 AI 开关覆盖共享题目讲解、个人追问、文档与代码协作及公开讨论模型回应和总结。公开讨论中，被点名学生显示回答弹窗和 AI 当前回应；旁听学生不显示回答弹窗，读取同一讨论快照并暂停自主播放。两类学生按各自真实交互验证，不能要求旁听学生出现点名界面。公开讨论播放状态的 API 驱动会在证据中说明，不等同于语音控制界面验收。
- TTS 检查除了生成音频，还要求浏览器点击后解码并推进播放时间。ASR 使用明确标记的 TTS 合成测试音频；没有音频时标为未验证，不把配置探测当作真实识别。物理麦克风与扬声器未被覆盖。

`report.json` 保存浏览器身份、版本、构建编号、实际视口、传输方式及每项 `evidence` 分类，区分隔离后端、真实浏览器操作、供应商 API、媒体播放和注入故障。默认轮询结果不能作为 WebSocket 证据；可选 WebSocket 模式覆盖真实隔离传输和重连，不替代部署入口 TLS/反向代理检查或课堂容量测试。报告与截图写入已忽略的 `test-results/`，实际执行结果在交付说明中报告，不将未执行场景或旧报告沿用为本轮通过。

失败时脚本保留本次一次性数据库的 SQL 快照。需要单独复核已保存的公开讨论回应与收尾，可将 `PRELAUNCH_RESUME_AI_DIR` 指向该次报告目录并设置 `PRELAUNCH_RESUME_PUBLIC_DISCUSSION=1`，另选输出目录；只恢复合成验收账号及对应课堂的访问和阶段，不重新生成已保存的讲解与讨论回应。此模式仍需真实供应商配置来完成尚未执行的讨论总结。原报告与恢复报告分别保留，不能覆盖原始失败记录。
