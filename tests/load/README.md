# 课堂容量与稳定性验收

本文列出验收工具的执行范围、环境要求与报告解释；实际通过结论必须来自对应源码和构建的本次报告。日常改动先按[开发工作流](../../docs/agent-workflow.md)选择受影响检查，长期整课、真实 Provider 和部署环境写入按本页明确范围执行。

## 入口选择与兼容边界

| 目标 | 入口 | 环境与结果范围 |
| --- | --- | --- |
| 改动后的混合负载补测 | `PRELAUNCH_INCREMENTAL=1` 的隔离功能入口 | 独立 PostgreSQL、Redis、应用与 WebSocket；按实际专项报告 |
| 三堂连续课堂 | `pnpm test:classroom-acceptance` | 隔离业务环境；默认真实 Chrome/Edge、30 学生、每堂 90 分钟 |
| 旧 40 人容量协议与部署恢复 | `scripts/verify-classroom-capacity.mjs` | 写入指定宿主环境，长测可重启已安装服务；仅在维护窗口使用 |
| 数据约束与持久队列 | `scripts/verify-research-database.mjs` 的专项开关 | 标记隔离数据库；结构验证不等于真实模型质量 |

**现有整课和旧容量工具存在兼容缺口。** 当前[文档接口](../../src/lib/ai-collaboration/document-handlers.ts)已停用自动段落批注，旧动作返回 `410 DOCUMENT_AUTOMATIC_REVIEW_RETIRED`，学生仍可主动提问、检查和确认修改；但[整课必需检查](../../scripts/lib/classroom-acceptance-evidence.mjs)、[文档专项](../../scripts/lib/classroom-acceptance-document-ai.mjs)和[旧容量浏览器工具](../../scripts/verify-capacity-document-browser.mjs)仍包含自动批注或其收尾门槛。不能按旧说明等待自动批注，也不能删除失败结果后宣称整课通过。使用这些入口时须保留缺口及实际失败；需要完整现行产品验收前，先同步相关测试场景与判定合同。本文移除退役功能的旧操作规程，保留可用工具和历史证据的解释入口。

研究接口现有七种导出类型，见[研究数据导出](../../docs/database/research-export.md)。整课工具的 `researchExportFields` 仍核对其中六种，另行读取 AI 历史；它不等于覆盖 `ai_messages` 分页合同。该接口的专门验证见[研究留存验证入口](../../docs/database/research-integrity.md#验证入口)，增量工具另有消息导出校验。

## 修改后增量补测

已有报告只能按实际通过的场景及其源码、依赖和配置证据沿用。先固定候选源码和构建，再用布局脚本的场景筛选、Playwright 文件/用例筛选及受影响单元测试补测；未修改且没有受共用依赖影响的页面无需重新跑矩阵。

保存、AI 和展示的混合补测复用隔离应用生命周期：

```bash
PRELAUNCH_INCREMENTAL=1 PRELAUNCH_WEBSOCKET=1 PRELAUNCH_REAL_PROVIDERS=1 \
PRELAUNCH_REUSE_BUILD=1 PRELAUNCH_DIST_DIR=.next-build \
PRELAUNCH_E2E_EXECUTABLE_PATH=/absolute/path/to/chrome \
PRELAUNCH_E2E_BROWSER_LABEL=google-chrome \
PRELAUNCH_CHROME_EXECUTABLE_PATH=/absolute/path/to/chrome \
PRELAUNCH_EDGE_EXECUTABLE_PATH=/absolute/path/to/msedge \
PRELAUNCH_OUTPUT_DIR=test-results/incremental/current/mixed \
pnpm exec tsx scripts/verify-prelaunch-functional.mjs
```

此模式强制一次性 PostgreSQL、Redis、独立应用和 WebSocket，仅读取已授权的供应商配置并复制到隔离库；业务数据写入隔离实例。默认 40 名学生（两品牌各 20）、2 名教师，5 分钟预热、20 分钟稳定负载、5 分钟恢复、5 分钟空闲观察；每 5 秒通过独立认证上下文保存和读取，稳定窗口执行两轮 30 人真实 AI 请求，并保留真实浏览器、原生保存恢复和投屏消息证据。周期协议负载与实际 UI 操作分别标记。`INCREMENTAL_SMOKE=1` 仅验证工具链，结果最多为 `partial`；同时设置 `INCREMENTAL_SHOWCASE_ONLY=1` 可只诊断归档、推荐改版、预览控制与隔离恢复，不能作为容量结果。

稳定负载期间，同一隔离应用另建两品牌代表参加的成果展示课程，执行真实归档、推荐改版、Word/PDF预览、投屏与控制权切换；主课程40人继续保存、读取和AI活动，分别核对课程归属与版本。采用独立课程是为了遵守制作阶段与展示阶段的现有权限约束，不把停载后执行的成果功能计作混合压力。重启后重放已完成AI请求并核对原回执、原任务和消息；这项证据不代表模型执行中途重启已通过。

`INCREMENTAL_SMOKE=1 INCREMENTAL_CALLERS_ONLY=1` 只执行受影响的代码AI、助教代表性真实后端调用及隔离恢复；两个入口分别使用自己的现有模型预算，结果不计作压力验收。工具判定回归可定向运行 `node --test scripts/lib/incremental-classroom-contract.test.mjs scripts/lib/incremental-showcase-acceptance.test.mjs scripts/projection-contention-config.test.mjs`。

已取得推荐证据、只需复验上传/预览修复时，可用 `INCREMENTAL_SMOKE=1 INCREMENTAL_SHOWCASE_ONLY=1 INCREMENTAL_VIEWERS_ONLY=1`，跳过推荐模型，仅验证真实Word/PDF、控制权和阶段结束；报告明确不包含推荐质量，正式40人模式禁止此开关。AI瞬态5xx且回执允许重试时，混合模式最多用原编号重试一次，保留首次失败与恢复结果；120秒门槛仍从首次请求开始计算。

仅补成果展示在保存负载下的失败场景时，在上述隔离入口增加 `INCREMENTAL_SHOWCASE_LOAD_ONLY=1`，保留 `INCREMENTAL_SMOKE=0`。此模式仍使用两品牌各20名学生、2名教师，每5秒保存和读取；在独立课堂由两品牌代表各完成初版和改版推荐、Word/PDF预览与投屏后立即收尾，逐人核对保存回执和重放。性能按42个客户端分别检查，避免学生快读掩盖教师慢读。它不重复两轮30人AI、导出备份或故障注入，结果只代表 `showcase-save-load-only` 专项，不代表35分钟或整课验收通过，且不能与其他局部模式同时启用。

`incremental-classroom.json` 保留各检查、原始失败、注入故障、分阶段/操作性能和源码指纹；原始请求、资源采样、AI 回执、导出、在线备份及最终停写恢复分别留证。普通读写继续使用 P95 1 秒/2 秒，投屏 HTTP 与最后接收者 P95 500 毫秒；AI 沿用各调用入口的既有预算：混合负载端到端完成门槛为120秒，同步文档讨论使用85秒操作期限，异步任务使用自身执行预算，代码执行期限为110秒，助教使用自身的 `TUTOR_EXECUTION_MS`。重试不重置首次请求的验收计时，端到端门槛不延长内部执行期限。短时补测不代替整课或连续三堂验收。故障或缺测不能改标为通过。

投屏竞争独立工具也支持 `PROJECTION_CONTENTION_MODE=incremental`，必须显式传入隔离 `CAPACITY_BASE_URL`、`CAPACITY_DATABASE_URL`、`JWT_SECRET`、`CLASSROOM_DATA_DIR`、`PROJECTION_CONTENTION_OUTPUT_DIR` 和数据库 `_OpenpblVerification` 表中已有的 `OPENPBL_VERIFICATION_MARKER`；缺项不读取正式凭据、不回退正式环境。原完整模式保持原入口行为。

## 单教师 30 学生整课验收

统一入口 `pnpm test:classroom-acceptance` 默认验证 1 位教师、30 位学生（真实 Google Chrome 与 Microsoft Edge 各 15 位）和同一应用进程连续三堂、每堂至少 90 分钟的五阶段课堂。它先记录实际源码（含未提交及未忽略的新文件）与迁移文件 SHA-256，再执行 `pnpm build`，绑定 BUILD_ID；各专项之间和运行中持续复核身份。它不重启已安装的生产服务，业务验收使用同一候选构建的隔离 PostgreSQL、Redis、上传目录和应用实例。

```bash
# 默认正式验收；需先准备真实 Chrome/Edge、Docker 镜像与已有供应商配置。
pnpm test:classroom-acceptance

# 快速验证工具链；人数与持续时间缩小，只能得到 partial 或 failed。
pnpm test:classroom-acceptance --smoke --minutes=1 --students=2

# 只执行指定范围；缺少其余必需范围时不能标记正式通过。
pnpm test:classroom-acceptance --smoke --checks=unit,linkage,practice
```

默认依次执行 `unit,ui,linkage,practice,classroom,faults`。三堂课及每次课后 120 秒观察窗保持同一应用进程；第三堂后再执行重启、故障和恢复专项。显式 `--soak-classes=1` 可做单堂复验，但不能得到完整稳定性验收通过结论。UI、联动、实践和故障专项分别运行真实 Chrome/Edge；UI 与故障用例的业务接口为显式夹具，单独标为模拟接口证据。联动与实践使用真实隔离后端，整课阶段启用真实供应商，保留原模型配置。主课后另建 Python、C 和其他成果课堂，逐学生验证多文件保存、清除本地草稿后的服务器恢复、真实沙盒运行，以及两版本地文件上传、幂等重放、下载 SHA 和教师读取对账。整课之外的准备、专项、故障恢复及数据核验时间另计，不能替代 90 分钟课堂持续时长。校园 Wi-Fi、师生物理终端、麦克风、扬声器与外接投影仍需现场核验。

可用 `PRELAUNCH_CHROME_EXECUTABLE_PATH` 与 `PRELAUNCH_EDGE_EXECUTABLE_PATH` 指定绝对路径；未设置时依次检测 `.cache/browsers/chrome/opt/google/chrome/chrome`、`.cache/browsers/edge/opt/microsoft/msedge/msedge` 及对应 `/usr/bin` 安装。品牌由实际安装程序和浏览器运行身份验证，不用 UA 替换模拟。各隔离实例顺序执行，需空闲 loopback 3197–3199 端口；代码专项使用已配置的 loopback 代码运行器。

三浏览器联动还会在代理层持续拒绝 WebSocket 重连，保持 HTTP 可用，核对两名学生通过真实轮询收到并渲染新的投屏页面；恢复升级通道后，教师和学生均须重新订阅。只关闭一次连接后立即重连不能代替轮询降级证据。

同源 HTTP/WebSocket 代理使用独立子进程，避免与浏览器驱动共用事件循环；报告保留两个进程编号。代理控制须等待确认，异常退出或清理失败也计入验收结果。资源采样在采集时追加到 `resource-snapshots.ndjson`，运行结束后仍输出完整 JSON。

每次证据保存在独立的 `test-results/classroom-acceptance/<UUID>/`，包括总报告、构建/子任务日志与原始 JSON 报告。Playwright 输出放在各专项目录，不能清空顶层证据。仅进程退出成功不够：必须核验实际测试结果、真实人数/品牌、五阶段计时、教师统计、过程记录、成果回执、恢复与真实 AI 证据。跳过、未验证、缺子报告、缩短时长或缩小检查范围均不能标记 `passed`；失败保留为 `failed`。最终报告的通过范围是该版本与该验收场景，不表示所有未来课堂无故障。

受控中断先停止自有隔离应用，再分别转储源库和已创建的恢复库，最后删除本轮容器。中断快照使用 `isolated-interrupted-*.sql`，正常失败使用 `isolated-failure-*.sql`；各自的 `database-*-preservation.json` 记录完整页尾、私有文件权限、字节数与 SHA 校验。每库转储最多等待30秒，父进程为整个退出保留90秒；这不延长课堂、模型或用户操作的验收期限。快照缺失、转储失败或强制终止来不及保全时明确记为未知或失败，不借用其他轮次的数据库补证据。

正常课堂按项目启动8分钟、知识讲授22分钟、项目实践30分钟、成果汇报10分钟、后测20分钟持续运行；课前9题前测、53题后测的真实翻页提交、准备资源及补验另有原始记录。课堂每15秒从每个浏览器核验真实登录和页面存活，并采集隔离服务的CPU、内存、事件循环与AI队列指标。导航瞬态采用8秒有界重试。故意断网、流式恢复、行锁竞争、额外成果课程及超过一万条事件的汇总对账在正常课堂之外执行。

`functions.csv` 提供逐功能与逐浏览器结论，`performance.csv` 按课堂序号提供逐阶段/操作P95，`students.csv` 提供逐学生前后测答案数、独立预期及学生/教师小测分数、文档状态、AI请求、过程记录与成果摘要，`defects.json` 汇总缺陷和未验证项，`phases.json` 保留每堂阶段的序号、起止与时长。原始请求保留首次失败、重试和取消；同一请求编号的版本冲突成功恢复时，操作耗时包含重试等待，导航取消不虚构成已完成的性能样本。投屏延迟核对学生实际PDF像素，媒体与AI响应单独留证。六类研究导出、学生档案ZIP和完整AI历史分别核对，SQL及文件备份恢复比较完整内容与摘要。

每堂课均核对原有功能证据、读写门槛、五阶段在线连续性和模型配置指纹；不能只凭三堂汇总的通过标志。逐堂性能、阶段与任务回执从对应原始报告读取，不合并三堂的 P95；前两堂原始报告缺失或与汇总不一致时，保留未验证或失败。空白、缺失及非数值资源指标保持未知，显式零单独处理。

已有真实测量但延迟或错误门槛不合格的检查记为失败，不重复算作未验证；失败结果仍须与原始样本一致。备份恢复先逐模型、逐文件核对，再以独立恢复数据库和文件目录启动恢复副本，实际重新登录教师及学生、打开课堂历史、下载核对 Word 摘要，并验证原生音频播放到结束。恢复副本的界面证据单列 `restored-app-ui.json`；启动或任一步行为失败都不能算恢复可用。

### 性能、日志与证据解释

普通请求的 P95 使用浏览器 `Request.timing()` 的完整网络时长，原始记录保留计时字段及 `Server-Timing`；成功恢复的版本冲突使用同一浏览器各次请求的绝对起止时间，包含真实退避。测试驱动收到回调的耗时另列为 `observerP95Ms`，避免驱动自身排队造成归因错误。原生时间缺失不作为零或成功样本，`unmeasured` 必须为零才可通过。投屏实际渲染及 AI 用户操作总耗时继续按各自行为时钟核验。

选定读取与进度接口另保留 Next 路由层的 `proxy`、`dispatch` 和处理器计时；其中 `proxy` 指 Next 的路由与鉴权层。进度的各子阶段保留同一请求中的起止偏移、重复调用和失败；`course-queue` 记录本地准入排队，个人／课堂准入记录完整 SQL 调用等待，重试退避另列，不能将 SQL 调用耗时直接当作数据库锁等待。诊断响应头有容量上限，`progress-timing-omitted` 明确列出省略数量，不补造时长。嵌套时长不可相加或用各组 P95 相减推算排队。资源采样保留已有课程准入等待与事务分段指标；任务时间戳之差仍单列，不充当真实队列等待。

课堂初始化与订阅补偿只合并同一课堂、同一连接周期内正在进行的读取，不缓存已经完成的状态。事件请求从已确认的初始游标开始；查询发出后到达的新订阅保留下一次补偿，教师控制与新游标仍能触发后续快照。事件接口复用本次学生权限查询同时读出的课堂版本，每次轮询重新核验用户、会话和教学班关系，不复用先前请求的授权。

隔离 HTTP 代理另记录选定接口的接收、连接、转发和响应时钟。Node 原生入口为选定的 HTTP 尝试生成独立 `x-openpbl-http-request-id`，清除调用方伪造值；它与业务 `X-Request-Id` 分开，刷新重放、轮询及连接复用仍各有不同编号。浏览器响应、代理和应用完成日志以原生编号关联，旧验收编号仅作为兼容路径；缓存响应复用旧编号时仍须核验本次真实起止时钟，不能借用旧执行记录。`isolated-proxy-http.ndjson` 与 `isolated-app-requests.ndjson` 只保存白名单元数据，不保存查询、凭据、正文或非验收业务编号；缺少关联或边界仍记未知。应用记录 Next 代理开始、结束及处理器进入、返回的实际时刻，返回时刻在指标与日志生成前采集；流式正文结束另由代理记录，不能用日志时间减处理时长代替入口证据。日志写入不阻塞 HTTP 流，写入或关闭失败会使该轮失败。它们用于定位浏览器发送前、Next 入口前及处理器外的耗时，不改变原生延迟门槛。

代理日志的 `upstreamBodyBytes` 只累计现有响应流中实际观察到的正文块，不复制或保存正文；`upstreamBodyEncoding` 区分压缩表示，`upstreamBodyComplete` 标记是否完整接收。它不包含 HTTP 头、分块边界，也不证明浏览器收到了全部字节。HEAD／304 的已确认空正文为零，未收到上游响应为 `null`，中断只保留已经观察到的前缀。旧报告没有这些字段时保持未知，不能补写成零或据此推算流量改善。

Python、C、其他成果的专项浏览器读写合并列在 `artifact-modes` 阶段，各方法、路径和操作仍分别计算 P95，并沿用读取1秒、写入2秒门槛。专项不计入五阶段90分钟，代码执行和AI响应继续单独统计。六类研究导出均须有全部学生的实际记录并经过游标翻页；其中独立作业提交与课堂反思通过现有真实 API 在整课之后补验，核对未改变主课堂的成果及前后测。空集合或字段缺失不能算导出内容通过。

个人追问另外要求每位学生完成真实配置的动态语音：匹配实际TTS响应字节与原生Audio来源，并等待真实播放结束；追问文本成功、预生成音频成功或页面导航取消均不能代替。`ai-http-transport.json` 单独保留正常课堂AI/语音的首次HTTP失败、同用户同请求重试恢复和取消，未恢复错误计入失败。AI计时分别记录完整浏览器响应和任务运行时长；流式首段来自实际流响应，非流式接口不虚构首段。`taskTimestampDeltaMs` 只是数据库任务创建与开始时间之差。`aiCapacityAdmission` 以同进程批次前后真实直方图增量报告本地容量池等待、拒绝和P95区间，保留原始指标；它不是逐学生等待，也不包含上游供应商排队。缺指标、进程重启或计数器重置均记未知，不记零。

AI HTTP 报告中，兼容字段 `firstAttemptFailures` 与新增 `failedHttpAttempts` 均为失败 HTTP 尝试次数，不是去重的首次逻辑失败数。`failedLogicalRequests` 在同阶段、方法、路径与操作内按精确浏览器身份和请求编号去重；缺少可用身份或编号的失败逐次单独计数，不能推定属于同一请求。只有该组全部失败尝试均已由现有同编号重试或完整个人追问恢复链覆盖，才计入 `recoveredLogicalRequests`，其余计入 `unrecoveredLogicalRequests`。同编号恢复必须有可识别的浏览器身份和非空请求编号，缺少证据时不得与后来200合并。计数保留原始 `failedAttempts`、取消与 HTTP202 的现有处理；只对缺身份的旧误匹配收紧为失败，不改变有效身份的恢复判定、`unrecoveredFailures` 门槛或耗时口径。

个人追问终态服务失败时，验收先核对错误可见、问题保留及发送按钮恢复，再实际点击一次重新发送。首次失败任务、原始输出和审计须保持不变；新旧请求只有在同一问题、身份、最终任务、历史重放和真实语音全部核对后才记为 `logicalRecoveredFailures`，原始503及首次失败计数仍保留。最终可见文本的180秒观察窗从第一次点击计时；没有完整恢复链的后来成功不能抵消旧失败。

真实供应商模式以只读事务获取当前全局 `ProviderCredential` 快照，将加密凭据和助教专用模型、语音设置一起复制到隔离数据库，再完整比对与记录摘要；应用不连接正式配置库写入。课堂期间持续核对公开的模型、语音和能力配置指纹，变更会终止本轮通过判定。备课编辑另外验证文本、形状、白板与讲稿的真实保存、旧修订冲突和发布隔离；所有学生均执行格式、表格、图片及撤销重做后的保存恢复，30个学生上下文保持运行；该专项的原生键盘流程按浏览器品牌排队（Chrome、Edge各最多1人），每个流程实际将页面置前，点击后须至少3次采样且持续≥250ms原生选区稳定，再单次定位文档末端并核对。全班普通编辑、并发AI期间保存及集中Word归档仍按各自原有并发另行验证；此专项调度不降低其他全班并发负载。最终备份在额外成果、评分和媒体等专项完成后执行，关闭浏览器写入并停止隔离应用后，逐个Prisma模型与完整文件目录对比恢复内容。

### 文档与代码回归边界

文档段落身份随实际正文编辑保存，刷新后恢复；仅查看、补齐身份和显示批注不产生新草稿。新版批注必须匹配原段落身份、完整正文与唯一目标；历史易变身份仅允许用唯一且完整一致的段落恢复，删除、改写或歧义均不重新绑定。

AI 批注高亮使用显示范围，不通过拆分、设置或清除正文节点写入撤销历史。编辑器回归启用生产环境的节点身份，覆盖一次工具栏撤销/重做、批注刷新、跨高亮编辑、普通批注及 AI 修改确认。归档先保留每人的真实提交回执和下载摘要，再分别核对已保存表格的行列与完整文字、图片字节及服务端恢复；前置编辑失败与归档丢失分别记录，后续教师预览仍须单独核验。

## 宿主 40 学生容量工具（兼容入口）

当前工具以真实账号和独立运行 UUID 验证课堂、AI、文件与恢复。下列容量工具会写入目标环境并调用真实 Provider，正式长测还会重启应用；在已安排的维护窗口执行。隔离数据库命令使用独立容器。工具约束是验收要求，不代表当前部署已经通过。

```bash
# 小规模真实 HTTP 冒烟（同样创建仅属于本次运行的测试数据）
CAPACITY_CONNECT_HOST=127.0.0.1 CAPACITY_STUDENTS=2 CAPACITY_MINUTES=0 CAPACITY_REAL_AI=1 pnpm exec tsx scripts/verify-classroom-capacity.mjs

# 正式维护窗口：2 位教师、40 位学生，120 分钟，含真实 AI 与语音
CAPACITY_CONNECT_HOST=127.0.0.1 CAPACITY_STUDENTS=40 CAPACITY_MINUTES=120 CAPACITY_REAL_AI=1 CAPACITY_RESTART_SERVICE=1 \
  pnpm exec tsx scripts/verify-classroom-capacity.mjs

# 不接触正式库的真实 PostgreSQL 并发与事务恢复验证
OPENPBL_VERIFY_CONCURRENCY_ONLY=1 node scripts/verify-research-database.mjs

# 短测：100 次投屏、42 个实际 WebSocket；分别报告实践负载与额外跨阶段压力
CAPACITY_CONNECT_HOST=127.0.0.1 pnpm exec tsx scripts/verify-projection-http-contention.mjs

# 隔离数据库：批注/无批注的完整原文、决策、幂等和失败回滚
OPENPBL_VERIFY_REVIEW_ONLY=1 node scripts/verify-research-database.mjs
```

保留现有域名 `https://coteach.cn`，默认把 HTTP、WebSocket 和浏览器连接固定到本机反向代理 `127.0.0.1`，不使用公网 DNS 路径。用 `CAPACITY_CONNECT_HOST` 指定实际的本机校园内网地址；连接地址必须为私有或回环 IP。可用 `CAPACITY_BASE_URL` 指定其他内网入口。数据库通过本机 `deploy/secrets/database_url.txt` 加载，可用 `CAPACITY_DATABASE_URL` 指定隔离环境；不要把凭据放进报告、命令参数或共享日志。课堂文件写入本机 `.openpbl-data/classrooms`，工具适用于当前宿主部署。负载机在宿主服务器上，经校园内网地址请求反向代理；报告验证服务器和应用容量，不代表师生终端至服务器之间的 Wi-Fi 覆盖与丢包情况。

每次生成独立 UUID 课程、教师与学生，真实登录、前测/问卷、课堂进入、学习测验与进度、文档保存、两次最终归档、集中上传、展示评价与后测。持续负载分为 AI 知识学习和文档实践各60分钟：前半程每15秒读取学习进度、每分钟读取真实课件；后半程40名学生每5秒保存一次。全程42用户每10秒心跳，42个WebSocket持续订阅，15秒投屏更新必须送达所有身份。学习阶段每10秒读取课堂快照并写学习心跳，实践阶段每5秒读取快照、每分钟写实践事件。授课媒体按真实片段时长持续下载并核验；投屏操作分散在整个5秒请求周期内。逐学生核验保存内容、版本、每次已确认保存回执的正文 SHA-256 和归档 SHA-256。真实40人文档AI集中请求期间同时运行5秒自动保存和状态刷新，在学习半程完成后再进行一轮40人文档AI。`CAPACITY_DOCUMENT_REPEATS` 默认 120，可在 30–1000 内调整协议草稿规模；报告记录实际字节数。AI请求单独统计并核对完整任务、消息、原始模型输出与审计归属。服务明确标记可重试的429/503/504最多重试一次，原requestId和正文不变，总期限60秒；原失败计入错误率，非流式文档AI首个可用答案耗时包含重试和等待。

真实AI模式先生成供应商语音并上传本次课程，40个独立浏览器上下文（每10人一个Chromium进程）同时打开真实学生课件、点击讲解，持续至少3分钟观察原生Audio解码及播放时间推进；小规模冒烟观察10秒。测试机每个浏览器进程使用独立实时PulseAudio输出，避免宿主共享音频输出的并发限制；不修改原生播放时间、下载或解码。此方案仅影响测试机音频输出，自动清理，不改变系统默认声卡。这项浏览器播放证据与上述120分钟协议负载分别报告，不能把协议时长写成40个浏览器连续播放120分钟。

报告位于 `.openpbl-data/capacity-evidence/<runId>/report.json`，与 Playwright 可清空的 `test-results/` 分开保存；旧路径仅用于仍存在的历史报告。只有完整人数、时长、真实 AI、应用重启恢复、数据对账和性能门槛全部满足，结果才能标为 `passed`；缩小运行标记 `partial`，故障保留 `failed` 现场。工具同时以真实浏览器校验投屏渲染、观察教师只读与接管、离线60秒后10秒内恢复；长压测后 `CAPACITY_RESTART_SERVICE=1` 会实际重启本机 `openpbl.service` 并核对保存回执及重连。进度在初次、重启后、结课后重放同一请求，核对唯一过程事实和完整原回执，并验证纯重放不改变数据库版本或活跃时间。

文档与两轮集中上传使用稳定请求标识并验证重复回执：普通附件约1.6MiB/人；实际“提交本地成果”入口使用1–2MiB/人，验证首次201、重放200、同编号换内容409、版本不额外递增，全部逐一下载核对SHA-256。其中保留的自动段落审阅步骤受上文兼容缺口限制，不作为现行功能操作说明。

另以两个真实学生浏览器验证编辑、服务器回执、刷新、断网60秒期间本机草稿、关闭页面后重新打开续传、AI回答期间继续编辑。恢复后对账学习事件、协作事件、已接收任务、原文、决策与审计事实；自动审阅的旧断言单独记录兼容失败。旧页面及新页面的完整请求/回执分别留证；已有 mock 浏览器故障用例见 `e2e/classroom-reliability.spec.ts`，与这些真实入口检查分开报告。

开跑及运行中每分钟验证监测可读、数据库/AI/待补写指标有效、备份恢复点不超过15分钟，并检查磁盘与可用内存；异常停止负载并保存现场。数据核对工具以只读数据库连接执行：

```bash
capacity_report="${CAPACITY_REPORT:?设置本次报告的完整路径}"
node scripts/verify-capacity-files.mjs "$capacity_report"
node scripts/verify-capacity-ai-records.mjs "$capacity_report"
```

清理先 dry-run，再检查计划：

```bash
node scripts/cleanup-capacity-run.mjs "$capacity_report"
node scripts/cleanup-capacity-run.mjs "$capacity_report" --execute
```

失败或缩小运行需显式添加 `--abort-run=<完整runId>`。清理器校验 UUID、账号前缀及跨课程外键，只删除该运行的数据与文件，保留原报告和清理证据。已有研究记录按归属与外键限制清理，不能使用无作用域级联删除。

### 失败夹具中的文档浏览器专项

需要单独诊断文档恢复时，可对明确指定的本次失败 UUID 运行：

```bash
CAPACITY_CONNECT_HOST=127.0.0.1 node scripts/verify-capacity-document-resume.mjs \
  "${CAPACITY_RUN_ID:?设置原失败运行的完整capacity-UUID}"
```

工具校验测试用户命名、课堂归属与原始草稿版本，使用短时内存凭据，保留原失败报告，将后续写入记到独立的 `document-resume-<时间戳>.json`。该专项不能替代完整 40 人验收；原始草稿版本已变化时会拒绝继续，不自动覆盖已有文档。

### 最终备份、恢复与清理

包含最终数据的本机恢复支持只读逐学生校验；使用 [恢复操作单](../../docs/operations/classroom-capacity-restore.md)。清理默认仅预览；投屏短测必须显式指定 `--kind=projection-contention` 及完整 `--abort-run=capacity-UUID`，见[精确清理规则](../../docs/operations/classroom-capacity-cleanup.md)。先留存报告、核对记录并恢复验证，再清理明确所属的测试样本。

## 稳定性复验与连续课堂

`pnpm test:classroom-acceptance --soak-classes=3` 使用同一构建与隔离应用进程连续完成三堂五阶段课堂，每堂仍为30学生和至少90分钟。前两堂保留各自功能、浏览器网络及阶段性能原始记录，第三堂完成全部专项、故障重启与备份恢复；这些故障重启安排在第三堂正常课堂及资源观察之后，不得重置连续课堂的内存证据。课间观察窗口保留浏览器正常订阅，停止额外交互，连续采样应用、驱动、宿主可用内存及可读取的进程PSS。观察时间不计入90分钟。

三堂必须具有相同应用PID和进程启动时间，完整人数、五阶段时长、功能及性能均满足既有门槛，才可通过连续课堂检查。资源未知不记零；第三堂静默窗口末尾RSS相对第一堂的增长超过512MiB或第一堂RSS的20%（取较大者）记为未达到资源稳定门槛，保留原始数据继续定位。此门槛用于发现持续累积，不等于证明不存在任何内存泄漏。缩小时长的三堂冒烟只能验证工具链，不能算长时稳定性通过。

草稿恢复专项先等协作稿和上传文件各自真实回执，再只移除当前身份、当前课堂且与服务端已确认内容一致的草稿；保留所有待确认保存、AI审阅与学习记录队列。不得以整站清空localStorage后仍能看到上传文件，替代协作稿保存恢复证据。

Chrome、Edge 均须实际完成两个并发保存专项：独立浏览器会话以真实旧版本提交产生409，保留双方内容，选择本机稿后继续保存；同一浏览器的两页从共享待确认队列重放原请求编号，核对原回执且不新增版本。两者都在旧回执到达前输入新内容，核对迟到回执不会清除新编辑，最终以数据库版本、业务事件和刷新后的内容对账。接口模拟、组件单测或其中一个场景不能替代这两项浏览器证据。

代码主动审阅和任务建议共享同一容量与公平调度，不能用单独执行器或新进程增加实际模型并发。专项还核对客户端编号与原模型输入去重编号的持久映射、每个编号的完整原载荷、丢接收回执后的原编号恢复、跨动作异体拒绝及明确重试命令的持久去重。会话撤销、阶段离开再返回时，旧任务与映射保持不变；当前授权代际的相同新请求只产生一个任务。已完成结果可继续复用，真实供应商失败不得通过自动创建新编号重置恢复上限。结构模型夹具仅证明调度与事务行为，不能代替真实供应商质量和整课验收。

持久审阅数据库专项：`OPENPBL_VERIFY_REVIEW_QUEUE_ONLY=1 node scripts/verify-research-database.mjs`。该入口使用隔离PostgreSQL验证30人任务幂等、公平调度、真实事务回执/检查点/审计、租约接管、旧令牌拒绝和准备结果恢复，不调用真实模型。生产默认后台并发8、等待上限80；有效执行租约与等待位置分别核对，接管后的既有任务不因超额而丢弃，超额时停止新接收。最多3轮完整执行，每轮保留既有模型预算及结构修复；已准备结果的提交恢复总领取上限9次。本地容量等待及工作器关闭不消耗模型次数；终态后由用户明确重新审阅同一任务，不以普通状态查询无限重置预算。
