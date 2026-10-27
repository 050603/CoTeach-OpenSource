# CoTeach 生产部署与服务维护

仓库提供的宿主部署方案由 systemd 用户服务托管 Next.js 应用、代码运行器、本地问卷分词、语音强制对齐和出站代理；Docker Compose 管理 PostgreSQL、Redis、Nginx、可选迁移容器、监控与手动备份。系统能力和本地开发见 [README](../README.md)，日常恢复见[备份说明](backup/README.md)。本文以仓库模板为准，已安装服务可能有环境覆盖，操作前核对 `systemctl --user cat <服务名>` 和实际 Compose 组合。

常用入口：[服务与端口](#服务与端口) · [首次部署](#首次部署) · [更新流程](#更新流程) · [固定运行版本](#固定运行版本) · [后台任务与健康检查](#后台任务与健康检查) · [基础设施](#基础设施) · [GitHub Actions](#github-actions)。

## 服务与端口

| 服务 | 仓库宿主模板 | 检查入口 |
| --- | --- | --- |
| `openpbl.service` | 应用 `127.0.0.1:3000`，WebSocket `127.0.0.1:3001` | `/api/health/live`；受令牌保护的 `/api/health/ready` |
| `openpbl-code-runner.service` | `127.0.0.1:3002` | `/health` |
| `openpbl-survey-nlp.service` | `127.0.0.1:3003` | `/health/live` |
| `openpbl-speech-alignment.service` | `127.0.0.1:3004` | `/health/live` |
| `openpbl-outbound-proxy.service` | `127.0.0.1:19999` | `/health/ready` |
| PostgreSQL / Redis | 宿主网络覆盖配置使用 `15432` / `16379` | 数据库就绪 / Redis ping |
| Nginx | `80/443`，内部检查 `127.0.0.1:18082` | 网关及受权依赖检查 |

systemd 用户服务模板使用 `%h/OpenPBL/openPBL`，其中 `%h` 由 systemd 展开为服务用户的家目录；其他仓库位置应在安装前替换为实际绝对路径。端口和网络出口按目标环境调整，站点地址必须显式配置。课堂实时同步使用现有 WebSocket 服务。尚未接入客户端的 tldraw 同步原型及其受生产许可限制的依赖已移除；旧配置应移除 `ENABLE_TLDRAW_SYNC=true`，历史白板快照数据继续保留。

## 首次部署

1. 准备 Linux、Node.js 22、pnpm 10.4.1、Python 3.10+、Docker Compose、Git、curl、rsync 和 flock；将仓库放在固定目录，使用实际服务用户安装依赖。运行 `pnpm install --frozen-lockfile`，保留 postinstall 的工作区构建、解析器同步与 Prisma 生成。
2. 按 [Secret 配置](secrets.example/README.md)准备 `deploy/secrets/` 和 `deploy/.deploy.env`，选择公开域名及 HTTPS 证书。区分宿主数据库端口与容器网络地址，先核对合并 Compose 配置，再按[基础设施](#基础设施)准备 PostgreSQL、Redis 和网关。
3. 检查 [数据库迁移](../docs/database.md#迁移与验证)，确认目标是新库或已审查的增量升级。准备本地辅助模型和 Playwright Chromium，按下文对应章节选择服务与出站方式。
4. 按下节配置站点地址，将 [systemd 模板](systemd/)中的仓库路径、网络出口和端口调整到目标环境，再安装到该用户的 `~/.config/systemd/user/`。模板包含适用于 IPv6 出站宿主的 NAT64 代理，原生 IPv4/双栈环境按[模型出站](#ipv6-主机的模型出站)调整。需要开机后持续运行时，核对用户 linger 和服务启用状态；不要只依赖当前 SSH 会话的环境变量。
5. 按[更新流程](#更新流程)构建、启动并检查实际运行版本。数据库无教师时，按根 README 的首教师初始化步骤创建账号；完成登录、加入教学班和关键功能冒烟。
6. 按[备份说明](backup/README.md)启用所需保护并完成隔离恢复或云端回读。应用健康、备份成功和恢复验证分别记录，不以安装成功替代恢复证据。

### 站点地址与现有配置

`openpbl.service` 可读取服务用户的 `~/.config/openpbl/site.env`。创建目录后，将实际入口写入该文件；已有文件应合并设置，保留其他配置：

```bash
install -d -m 0700 "$HOME/.config/openpbl"
```

```dotenv
# ~/.config/openpbl/site.env；替换为自己的公开入口
OPENPBL_PUBLIC_BASE_URL=https://coteach.example.com
```

文件权限设为 `0600`。也可通过现有服务环境显式设置 `PUBLIC_BASE_URL`；两者同时存在时，`OPENPBL_PUBLIC_BASE_URL` 优先。模板将环境文件标为可选，以兼容已有服务配置，但应用不再提供默认站点域名：两项都为空时，在读取凭据、连接数据库和执行迁移之前退出。环境文件由 systemd 读取，直接在终端运行启动脚本时需另外传入相应变量。

更新已安装服务前，先核对实际站点地址、`systemctl --user cat openpbl.service` 及现有 drop-in；保留数据库、只读线程、代理、日志和 `OPENPBL_RUNTIME_BUILD_ID` 等环境设置。单纯替换模板不会迁移旧模板内的站点地址，须先保存到 `site.env` 或既有配置中，再按更新流程重新加载服务。该文件随本机完整备份保存，恢复说明见[备份与恢复](backup/README.md)。

## 更新流程

1. 备份 PostgreSQL、上传文件、课堂数据和 `deploy/.deploy.env`。保留原 `PROVIDER_ENCRYPTION_KEY` 与 `JWT_SECRET`。
2. 首次安装或辅助模型依赖变化时，运行 `python3 scripts/setup-survey-nlp.py` 和 `python3 scripts/setup-speech-alignment.py`。应用更新运行 `pnpm install --frozen-lockfile`，完成相关检查后执行 `pnpm build`。
3. 构建成功后运行 `node scripts/run-next-production.mjs prepare`，生成不可变运行目录。核对待执行迁移；应用启动脚本从部署 Secret 加载目标数据库后自动执行已提交迁移。单独迁移使用 `pnpm db:migrate:prod`，执行环境必须明确指向相同目标库。
4. 安装或更新 `deploy/systemd/` 下的应用、代码运行器、`openpbl-survey-nlp.service`、`openpbl-speech-alignment.service` 和 `openpbl-outbound-proxy.service`，执行 `systemctl --user daemon-reload` 后重启服务。
5. 检查上表服务健康、应用实际运行版本，再完成教师登录、学生加入与相关课堂功能冒烟。代码运行器变化时同时重启并验证其独立服务。

已安装服务的应用更新命令：

```bash
pnpm build
node scripts/run-next-production.mjs prepare
systemctl --user restart openpbl.service
curl --fail http://127.0.0.1:3000/api/health/live
```

逐步执行，前一步失败时停止后续切换。构建或准备失败保留当前运行版本；健康检查失败不能宣称页面已更新。纯文档和不进入运行产物的工具修改无需重启。

学生草稿在发送前保留按账号与课堂隔离的本机待确认请求，刷新后先验证身份，再以原请求编号和原内容取得回执。退出或切课不会删除未确认请求，返回原账号与课堂后继续恢复；不要通过清空整站浏览器存储处理保存异常。真实版本冲突保留本机与服务器两份内容，页面提供对比、选择和下载入口。浏览器存储不可用时明确显示未保存状态，须保留页面并导出当前内容，不能将另一项操作的成功视作全部草稿已确认。

`pnpm build` 在全部检查通过后自动准备 `.openpbl-runtime/releases/<BUILD_ID>` 不可变运行目录，再退出成功；`prepare` 可以重复执行。`pnpm start` 也会先在锁内准备版本，只把完成的运行路径交给服务进程，不在服务运行期间持有构建锁。健康检查通过后，还应核对实际运行目录的 `BUILD_ID` 与本次准备的版本一致。

生产构建、类型检查和发布准备共用 `.openpbl-runtime/production-task.lock` 的操作系统锁；并发操作在写入前以退出码 75 明确失败，不清空另一项操作的产物。锁随进程结束释放。Linux 宿主需要 `flock`（util-linux），构建镜像已安装。

构建会同步被 Git 忽略的文档解析器和 PDF.js，在 `.next-build/public` 保存本次公共资源快照，并对公共文件、浏览器 chunk 和两个后台 worker 记录 SHA-256 清单。`prepare` 只复制本次快照，完成文件和依赖检查后才写 `.release-ready`；后续工作区清理不能改变已构建版本。启动时优先选择校验通过的完整运行目录，不把暂存目录里刚出现的 `server.js` 当成构建完成。不能仅凭 `/api/health/live` 成功判定 PPT/PDF 预览可用，还需检查模块 MIME 和实际课件加载。

PDF.js 主模块与 worker 使用 `src/lib/browser/pdf-runtime-version.json` 固定的同一版本目录；升级依赖时同步更新该文件，版本不一致会使同步失败。宿主发布会从保留的完整运行版本携带旧的 PDF 版本目录，避免长驻课堂在升级后混用主模块与 worker；旧固定 URL 继续供已有页面使用。成功加载的模块共用，明确的网络加载失败最多重试一次，失败不会永久缓存。

### 固定运行版本

需要人工恢复明确的上一可用构建时，`openpbl.service` 支持 `OPENPBL_RUNTIME_BUILD_ID`。它只选择现有 `.openpbl-runtime/releases/<BUILD_ID>`，校验非空安全字符、真实目录与可读 `server.js`，以及 `.release-ready` 和内嵌 `.next-build/BUILD_ID` 都与指定编号一致；新版本同时核对资源清单，旧版本至少检查文档解析入口与 PDF.js 主模块、worker。缺资源或坏 pin 会在读取密钥、连接依赖或执行迁移前失败，不会悄悄选择别的构建。它不要求旧版本具备新的 Monaco 清单，不创建构建、不自动回滚。未设置时选择已完成且校验通过的运行目录；显式空值会拒绝。CI 部署在重启前核对显式 pin 与本次构建是否一致，不一致时保留运行服务并明确报错。

先确认旧代码与当前数据库迁移、已接收后台任务的格式兼容，并保留配套备份。以下从仓库根执行：先只读检查指定版本，成功后才写入固定版本配置并重启应用。子 shell 中任一步失败即停止后续操作，不退出当前终端。

```bash
(
set -e
runtime_build_id="${OPENPBL_RUNTIME_BUILD_ID:?设置已经检查的现有BUILD_ID}"
node scripts/lib/production-runtime-release.mjs "$PWD" "$runtime_build_id"
install -d -m 0755 ~/.config/systemd/user/openpbl.service.d
cat > ~/.config/systemd/user/openpbl.service.d/40-runtime-build.conf <<EOF
[Service]
Environment=OPENPBL_RUNTIME_BUILD_ID=$runtime_build_id
EOF
systemctl --user daemon-reload
systemctl --user restart openpbl.service
curl --fail http://127.0.0.1:3000/api/health/live
)
```

逐步执行，任一步失败即停止后续步骤；核对实际 Next 子进程的运行目录与 `BUILD_ID`，完成关键保存和任务恢复检查。pin 仍通过原 launcher 加载密钥、等待依赖、执行已提交迁移，并保留端口、长连接、文件目录和后台执行器配置；它不绕过迁移兼容性检查，也不会修复不兼容 schema。不要用直接运行旧 `server.js` 代替该流程。

解除这次 pin 时，先确认要恢复的当前构建已经验收并运行 `node scripts/run-next-production.mjs prepare`；再仅删除本次创建的 `40-runtime-build.conf`，执行 `systemctl --user daemon-reload`、重启 `openpbl.service` 并重新核对构建与健康状态。保留其他 drop-in（例如 edge 日志路径）。后续部署前也要明确解除或更新 pin，否则新构建不会自动取代被固定的版本。隔离回归入口为 `node --test scripts/lib/production-runtime-release.test.mjs`。

### 静态资源与流式代理

Monaco 浏览器资源在构建成功后发布到该构建的 `/_next/static/openpbl-runtime/monaco/<版本>/<完整 SHA>/vs`，构建和 `prepare` 都会核验清单与文件内容。升级锁定依赖时需同时审查 [资源清单](../src/lib/browser/monaco-runtime-manifest.json)，生成文件不纳入源码。生产编辑器入口使用 [独立 bundle 清单](../src/lib/browser/monaco-browser-bundle-manifest.json) 固定的 104 个具名 AMD 模块，按静态依赖顺序连接；模块列表、原资源树与派生文件分别校验 SHA。入口使用 bundle 的 SHA 地址，CSS、语言、加载器及 worker 保留原资源树地址；原 151 个资源和旧 API 仍可用。依赖升级后若清单未同步，发布会明确失败。

身份、gzip 和 Brotli 表示中的小文件共用现有公共资源正文缓存（最多 8 MiB、256 项、单项 512 KiB），每次先核对文件元数据，同资源并发读取合并；大文件与入口 bundle 独立流式传输，取消一个响应不影响其他客户端，HEAD／304 不读取正文。Nginx 的 `/_next/static/` 规则优先于扩展名规则，并保留 Next 对成功文件和缺失文件分别给出的缓存头。公开缓存只用于这些固定公共资源，私有教材和成果仍按各自权限读取。

AI 课堂右侧编辑接口 `/api/openmaic/agent/edit` 使用 SSE。所有 Nginx 模板须将其纳入流式路由，关闭代理缓冲与 gzip，并使用 300 秒读取超时；接口在模型或工具尚无新输出时每 15 秒发送注释心跳，并返回 `X-Accel-Buffering: no`。不能将工具等待期间的无输出视为请求已完成，也不能通过自动重放整次编辑来恢复断线，以免重复应用已完成的修改。

## 后台任务与健康检查

学生文档的自动段落批注已停用，`DOCUMENT_AI_PROACTIVE_REVIEW_ENABLED` 不再控制或恢复该功能。旧自动批注和恢复接口返回 HTTP 410 与 `DOCUMENT_AUTOMATIC_REVIEW_RETIRED`；共享执行器启动时将遗留待执行文档审阅标为取消，保留原输入、历史批注与审计。学生主动发起的文稿检查、讨论和辅助任务继续可用，编程工作区不受影响。共享后台执行器的故障保留在就绪检查的 `documentReview` 诊断中，但不单独导致就绪失败。

代码主动审阅和代码任务建议由应用进程内的共享持久执行器处理，HTTP 202 表示任务已接收，最终完成以持久回执为准。默认合计最多8个后台执行，另有80个等待位置，每名学生串行，交互模型请求优先。等待与执行占位分别检查，不能在空闲时将执行位置当成额外等待位置；租约恢复或降低并发配置时保留全部已接收任务，暂时超出等待上限则停止接收新任务。输入、执行租约和准备结果保存在 `AiTask`，应用重启后接管未完成任务；准备结果已保存时只恢复数据库提交。真实模型执行最多自动恢复三轮，每轮保留原有模型与结构修复预算；仍失败时页面保留输入和明确重试入口。本地容量等待不消耗模型失败预算。

代码后台请求在发送前持久保存客户端编号与完整载荷；服务端用 `AiTaskRequestAlias` 保留每个编号、原始载荷及其任务映射，继续按原模型输入去重。丢失202后先查原编号，不用新编号猜测旧请求是否提交。同编号异体在所有动作的副作用前拒绝。明确重试使用独立命令编号指向原任务，命令重放不能再次重置失败预算；原输入和准备结果不改。身份或阶段换代后，旧未完成任务保留原终态与编号，新请求可在当前授权代际创建稳定派生任务；同代际继续去重，已完成的相同模型输入继续复用。浏览器只将匹配当前身份、课堂及代码／运行版本的结果应用到界面，完成通知仅提示查询真实回执。

任务失败后记录审计、安排恢复的过渡期仍保留租约和执行占位，查询继续返回处理中并附真实诊断；清除租约后才成为终态失败。取消保留原输入和准备结果，并阻止旧执行者继续提交或恢复该任务。最老任务年龄包含这些尚未结束的保留任务，等待数量将已过期或缺失租约的执行任务计入恢复等待。

当前模型准入计数属于同一应用进程，运行时与后台执行器共享容量池。不要直接拆出第二个 AI 进程或并行启动多个生产应用实例来增加执行器；增加实例前须先实现跨进程统一准入。`/api/health/ready` 检查已启用的关键工作器，`/api/health/live` 只证明进程存活。审阅排队、租约接管、准备结果提交恢复、外部内存及各路由的操作延迟由受令牌保护的 `/api/metrics` 暴露；采样缺失保留未知状态。

就绪响应中的 `dependencies.llm.okScope=configuration` 明确说明该项 `ok` 沿用供应商配置检查。独立的 `networkReachability` 为 `reachable`、`unreachable` 或 `unknown`；所有 HEAD 共用两秒预算，未配置探测地址或预算用尽时保留未知。HEAD 收到响应只证明网络可达，`modelExecution=not_checked` 表示没有执行模型；供应商调用是否成功仍应检查真实任务回执、错误指标和相关功能验收。

### 可选的课程只读线程

`OPENPBL_COURSE_READ_WORKERS` 默认 `0`，可显式设置为 `1` 或 `2`。启用后把课程列表、课程状态、事件游标和投屏状态四类 GET 交给同一应用进程内的 Worker threads；每次执行仍重新核验会话版本与当前访问权限，主进程保留 HTTP 认证边界、响应与指标。主进程继续处理所有写入、模型调用和持久审阅，后台 AI 的8个执行位置和80个等待位置不增加。它不启动第二个 Next 进程或新端口，不能把线程配置本身称作课堂性能验收通过。

启用必须同时指定 `OPENPBL_COURSE_READ_CONNECTION_BUDGET`、`OPENPBL_COURSE_READ_PER_WORKER_CONNECTIONS` 和 `OPENPBL_COURSE_READ_DATABASE_URL`。只读URL须使用专用身份，主机、端口、数据库及 `public` schema 与主URL一致。运行时保留原 `DATABASE_URL`，仅给主 Prisma 客户端计算剩余连接数。例如总预算57、每线程16时，关闭为主57，两个线程为主25＋只读2×16；对照验收还须让两臂的原主URL均显式带 `connection_limit=57`，不能比较两个不同总池预算。

使用受权的数据库管理员连接运行下面的运维入口。它不会安装 drop-in、重启服务或运行迁移；正常应用启动仍执行原迁移与依赖检查。把路径替换为该宿主的实际绝对路径，私有文件放在不可变 release 目录之外：

```bash
node scripts/provision-course-read-role.mjs \
  --database-url-file "$PWD/deploy/secrets/database_url.txt" \
  --environment-file "$HOME/.config/openpbl/course-read.env" \
  --workers 2 --connection-budget 57 --per-worker-connections 16
```

该入口生成专用 `openpbl_course_reader` LOGIN 角色，授予目标库 CONNECT、`public` USAGE及表 SELECT，并为当前迁移拥有者设置后续表的 SELECT 默认权限；迁移由其他拥有者创建表时需重新授权并复验。角色没有超级用户、创建数据库/角色、复制、绕过RLS、角色成员、对象所有权和永久CREATE或表列DML/序列写权限，默认事务为只读。PUBLIC 的 TEMP 权限可以保留，不能声称任意SQL下连临时对象也无法创建。若现有PUBLIC等权限仍让角色获得永久CREATE或写权限，工具拒绝启用，不修改其他用户的PUBLIC权限。

初次生成的密码先写入0600私有文件并保持线程关闭，角色和实际登录验证通过后才写入启用值；失败时不要重启服务，修复后以同一路径重跑。后续执行保留同一密码，不覆盖未标记的既有角色，不输出数据库URL或密码。私有文件须由服务用户拥有，目录不能让其他用户写入；不要将其提交、复制进构建或放进公开日志。

验证成功后，按本机的发布流程准备构建，再创建独立的 systemd drop-in：

```ini
# ~/.config/systemd/user/openpbl.service.d/50-course-read.conf
[Service]
EnvironmentFile=%h/.config/openpbl/course-read.env
```

随后按原更新流程 daemon-reload、重启并核对构建、readiness及实际只读线程状态，再验收保存与读取。关闭时只移除本次的 `50-course-read.conf`，保留其他 drop-in，重新 daemon-reload和重启；若另有配置仍设置该组变量须一并核对。保留私有文件和专用角色可供回退后复用，不直接删除数据库角色。

课程备份会包含只读角色的授权ACL。隔离恢复验收在同一独立PG实例中恢复到 `acceptance_restore`，重新授权并生成指向恢复库的只读URL，不复用源库URL；完整模型数据对账仍须通过。恢复到另一PG实例时，先按审核的角色恢复步骤建立相同角色，再恢复带ACL备份并重新授权验证，不能用忽略ACL错误或指回源数据库代替恢复。工具回归入口为 `node --test scripts/lib/course-read-role.test.mjs scripts/lib/classroom-acceptance-restored-app.test.mjs`。

## IPv6 主机的模型出站

服务模板针对 IPv6 出站宿主配置 NAT64 出口，这是可选部署方式。`openpbl-outbound-proxy.service` 是仅监听 `127.0.0.1:19999` 的 HTTPS CONNECT 代理：它通过多组 DNS64 节点解析并并行选择可用 NAT64 路径，连接内容仍由目标站点 TLS 端到端加密。采用此模板时，应用服务显式依赖该代理，并在启动、部署和运行健康检查中验证到 `api.deepseek.com:443` 的 TLS 链路；出口由服务配置管理，不依赖 SSH 或桌面会话的临时端口。

能够原生访问模型服务的 IPv4/双栈宿主不必部署 NAT64。安装前从应用 unit 的 `Wants`、`After` 中移除代理服务项，移除对应的 `ExecStartPre` 探测及 `OPENPBL_OUTBOUND_PROXY`、`OPENPBL_DEEPSEEK_PROXY`、`OPENPBL_NAT64_PREFIXES` 配置，并核对已安装 drop-in、Provider 配置和部署检查是否仍引用旧代理。其余辅助服务依赖保留；切换后按真实模型、媒体和向量入口验证直连。当前 `deploy/deploy-systemd.sh` 的服务清单和健康检查也包含此代理，使用该自动部署入口前须同步适配服务清单，不能直接套用默认流程。已有 IPv6 部署继续保留原代理及前缀，不应随模板更新自动移除。

默认 DNS64 节点可用 `OPENPBL_NAT64_DNS_SERVERS`（逗号分隔 IPv6 地址）替换为运营方自建节点；允许的 HTTPS 目标可用 `OPENPBL_NAT64_ALLOWED_HOSTS` 收窄为逗号分隔的域名或域名后缀。生产环境优先使用有可用性承诺的自建或运营商 NAT64，切换时无需修改应用代码。

经显式代理发送的模型请求使用独立 CONNECT 隧道，接收完整流式响应后关闭，避免后续页面复用已老化的上游连接。不要改回默认长连接复用而只增加生成重试次数。代理为每条隧道记录关闭来源、持续时间、上游地址、传输字节数和错误码；用 `journalctl --user -u openpbl-outbound-proxy.service` 对照应用错误时间排查 `connect-error`、`upstream-error`、`upstream-end` 或 `client-end`。日志不包含请求正文或密钥。`/health/ready` 只证明当前能建立 TLS 链路，不代表完整长课程生成已通过验证。

教师与学生共用的文本模型、TTS/ASR、图片/视频、PDF 和教材向量请求统一使用服务器托管出口；本机地址与 `NO_PROXY` 排除项保持直连。应用服务清除会话继承的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，生产出口使用 `OPENPBL_OUTBOUND_PROXY` 或服务商显式代理配置。DNS64 查询默认有 2 秒上限（`OPENPBL_NAT64_DNS_TIMEOUT_MS`），相同域名的并发查询合并，失败不会进入缓存。

浏览器媒体下载保留独立 SSRF 校验与 DNS 地址绑定，使用 `OPENPBL_NAT64_PREFIXES` 配置运营者信任的 NAT64 `/96` 前缀，将已经校验的公网 IPv4 合成为固定 IPv6；TLS 仍校验原始媒体域名。服务模板列出的前缀属于当前公网 NAT64 出口，迁移到原生双栈服务器时可移除，切换自有 NAT64 时应同步替换。不能用普通代理转发替代此接口的地址安全校验。

脱离 SSH 运行需确保用户已启用 linger（`loginctl show-user "$USER" -p Linger`），`openpbl.service` 已启用开机启动，依赖端口由 systemd 服务托管；本地 Ollama 也应由系统服务托管。AI 设置不应引用电脑上的端口或 SSH 临时转发。验收除健康检查外还应包含文本流式回答、语音合成/识别、媒体下载和教材向量调用；认证失败应修正相应服务商的 API Key 与 Base URL，不能靠增加重试修复。

## 正式与测试系统共用 AI 设置

正式系统以自身 `DATABASE_URL` 中的全局 `ProviderCredential` 为 AI 设置唯一来源。测试系统保留独立业务数据库，并将 `PROVIDER_CONFIG_DATABASE_URL` 指向正式数据库、`PROVIDER_CONFIG_ENCRYPTION_KEY` 设为正式系统的同一密钥；这样语言、语音、图像、视频等 Provider 的密钥、默认模型、音色和启用状态都由正式系统教师端的「个人中心 → AI 服务」统一管理。运行时每 5 秒刷新共享设置，测试系统不应维护第二份 Provider 凭据。

## 课程计量与预览

课件容量与实际渲染检查使用 Playwright Chromium、播放器同源 Noto Sans SC、渲染器 CSS 与 KaTeX。首次宿主安装运行 `pnpm exec playwright install chromium`；已有系统 Chromium 可通过 `OPENPBL_CHROMIUM_EXECUTABLE_PATH` 指定。Docker 镜像已安装 Alpine Chromium 并设置该路径。浏览器不可用、容量过载与教学质量差异分别记录诊断，不能将辅助估计当成实际渲染通过。

PPT 图片版导出复用同一 Chromium 启动配置，访问本机 `/internal/slide-export`，使用播放器组件逐页原生截图；该页面默认不载入课程，由隔离浏览器在内存中提供单页数据，不启动讲课或写入课堂状态。默认连接 `127.0.0.1:$PORT`（缺省 3000）；特殊本机入口可设置 `OPENPBL_SLIDE_EXPORT_URL`，仅接受 loopback 地址。截图浏览器不携带用户 Cookie，媒体由已授权客户端内联，字体与页面静态资源从本机构建加载；导出失败保留明确错误，不使用另一套渲染结果替代。

当前正式生成按知识小节联合产出页面与连续讲稿，再执行原生页面编译；通用分区空间规划与 ELK 候选布局用于对应适配路径。局部修复、原稿选择和恢复遵循[生成合同](../docs/course-generation.md)，来源与计量职责见[空间设计参考](../docs/slide-spatial-sources.md)。

课程预览默认显示“未检查”；教师可主动检查，也可在权限、版本与资源完整性满足时直接确认发布。打开预览、生成完成和资源更新均不自动安排质量审核或重新生成。

## 问卷词云分析

教师可在个人中心的问卷主题云设置中切换「本地高频词」和「AI 主题聚合」。选择按教师账号保存至数据库，默认保持本地高频词；更改只影响当前教师查看问卷时的分析方式。

本地模式使用 HanLP `COARSE_ELECTRA_SMALL_ZH:20220616` 上下文分词模型，不加载自定义领域词典。普通虚词、问卷套话和泛化表达在展示阶段过滤，题干中的词降权，不改变模型分词边界。结果优先选择由多名学生提及的原词，再用信息量较高的单次词补足；它不合并同义表达。

AI 模式复用 AI 服务设置中的默认语言模型及连接配置。第一步为每份回答提取最多三个可在原文中验证的原子核心词，并拆开可独立统计的并列或复合表达；程序还会按并列位置去除“教育、课程、技术、领域”等语境后缀，但不会处理独立出现的完整概念。第二步在整道题内只归并严格同义、缩写或同一概念的措辞变体，相关概念、上下位概念和正反评价不得合并。同一回答中已经分别提取的不同证据不会被合成一个虚假主题。主题云不设十二词展示上限，主题名称必须选自第一步的原文证据，不能由模型创造或拼接。只发送题目、回答文本和匿名编号，不附带学生姓名或账号；程序校验证据映射并按学生去重计算频次，模型不生成统计数字。首次分析在后台完成，每批最多 8 份回答，每个应用进程最多 2 个并发请求，与本地推理队列分开；提词服务失败会显示不可用并延迟重试，语义归并返回局部格式异常时逐项清洗，完全不可用时继续用已验证的 AI 原词生成精确聚合词云，并在短期缓存后自动重试，不会切换到本地模式或隐藏整张主题云。

安装脚本建立 `.openpbl-runtime/nlp-venv`，复用宿主 Python 的已安装依赖，并按 `deploy/survey-nlp-requirements.txt` 安装缺失版本。需要 Python 3.10 或以上；首次安装会下载并校验模型及分词资源，之后资源位于 `.openpbl-runtime/nlp-models`。受限网络可在运行安装脚本时设置 `HTTPS_PROXY`。运行服务完全离线，缺少模型资源会启动失败，不会自动联网下载。

模型常驻 CPU，使用两线程，暖机后仅监听回环地址 3003；Nginx 不开放该端口。应用默认通过该地址访问，可通过 `OPENPBL_NLP_URL` 指定其他本机回环入口。两种模式的逐回答结果按题目、内容和模型配置缓存至 Redis（7 天）；AI 整题主题快照额外按全部回答摘要和提示词版本缓存。新增回答时可继续显示上一版主题，编辑或删除回答后不会复用不匹配的旧映射。普通请求最多等待本地推理 500 毫秒，大批量任务继续后台处理并保留已有主题云。长文本分片有重叠，频次仍按不同学生去重统计。

主题云展示全部经过排序和验证的词条，并围绕中心紧凑排布；不同学生的提及人数决定字号，同频词保持相同字号。常规数量使用碰撞布局，词数过多导致字号低于可读阈值时直接改为可滚动的完整词条并跳过碰撞计算，避免高密度场景拖慢页面。词云上方不显示状态或说明提示；看板默认显示全部原回答，点击 AI 归并后的原词主题时按已验证的学生映射筛选，题目右上角的“全部回答”按钮可清除筛选。

## 朗读时间对齐

`scripts/setup-speech-alignment.py` 建立独立的 `.openpbl-runtime/speech-alignment-venv`，安装 `deploy/speech-alignment-requirements.txt` 固定的运行版本，并下载固定提交的 `Qwen3-ForcedAligner-0.6B` 到 `.openpbl-runtime/speech-alignment-models`。服务启动后完全离线，只监听 `127.0.0.1:3004`，不经 Nginx 暴露；输入限制为本机音频绝对路径、原讲稿和模型支持的语言，音频统一解码为 16 kHz 单声道且不得超过五分钟。

当前生产服务模板设置 `OPENPBL_ALIGNMENT_FORCE_CPU=1`、隐藏 CUDA 设备并限制 CPU 推理为八线程，使用固定模型、普通 attention 和 FP32 精度。CPU 模式在设备选择阶段不探测 CUDA。切换 GPU 前核对宿主驱动、实际模型兼容性和资源，再调整环境并执行真实对齐验收；服务健康不能替代触发时间误差验证。

可选的 TITAN Xp GPU 路径使用 PyTorch CUDA 11.8 wheel 中与 `sm_61` 二进制兼容的 Pascal `sm_60` 内核。安装校验会执行真实 FP32 CUDA 运算并加载固定模型；可抛出的 CUDA 异常、wheel 不支持当前架构或模型加载失败时自动改用 CPU。推理严格单并发，应用侧按音频内容、讲稿、语言和对齐版本写入 `.openpbl-data/speech-alignment-cache`。可用 `OPENPBL_SPEECH_ALIGNMENT_CACHE_DIR` 更换缓存目录。应用对可重试技术故障最多请求三次，并以同一总超时守护请求、响应读取和退避；同步修复仅处理未完成或指纹失效的语音，保留已验证的时间线。

真实课程验收使用 `pnpm exec tsx scripts/evaluate-speech-alignment.ts <人工标注.json> --no-cache`。JSON 包含 `audioPath`、原始 `text`、可选 `language`，以及至少 20 个 `{ "quote", "occurrence", "expectedStartMs" }` 人工听音标注。命令输出每个触发误差、P95、推理耗时和实时率；P95 超过 300 毫秒时以失败状态退出。

## 基础设施

当前宿主网络与域名 HTTPS 配置使用：

```bash
docker compose --env-file deploy/.deploy.env \
  -f docker-compose.prod.yml -f docker-compose.ip.yml \
  up -d postgres redis nginx
```

首次准备 [Secret 文件](secrets.example/README.md)、`deploy/.deploy.env` 和 HTTPS 证书。Compose 中有必需变量插值，包括迁移镜像标识、域名和精简备份目标；按实际启用服务准备其配置。证书初始化入口见 [bootstrap-certificate.sh](bootstrap-certificate.sh)。

Nginx 将整个 `deploy/nginx/` 目录只读挂载到 `/etc/nginx/openpbl-templates/`，避免 Git checkout 或编辑器原子替换文件后，单文件 bind 仍引用旧 inode。启动入口 [render-config.sh](nginx/render-config.sh) 只选择 `OPENPBL_NGINX_TEMPLATE` 指定的一份模板（默认 HTTPS，另支持 HTTP 和证书 bootstrap），通过镜像自带 envsubst 生成 `conf.d/default.conf`；不会把目录里的多个模板全部加载，也不会覆盖其他站点或 edge 日志 include。

从旧单文件挂载迁移时，先核对实际 Compose 组合，保存容器内另外维护的 `conf.d/*.conf` 和已有挂载；检查 `docker compose ... config --quiet` 后，仅重建 Nginx：`docker compose ... up -d --no-deps --no-build --pull never --force-recreate nginx`。新增挂载必须重建容器，单独 reload 或 restart 不会应用 Compose 的挂载变更。及时恢复额外站点配置并执行 `nginx -t`，再 reload 和检查其入口；不能用重建整个服务栈代替。其他项目若把站点配置直接写入容器层，需要单独保留并按其维护流程恢复，不能将其误认为持久 bind。

目录挂载生效后，模板更新仍需明确渲染、检查并重新加载。渲染器先验证包含其他站点的完整候选配置，通过后才原子替换 `default.conf`，语法错误会保留旧文件。依次执行下列命令，任一步失败即停止；操作前仍应备份 `default.conf`，用于后续加载失败时恢复。六小时维护循环只 reload 已生成配置，不会自动发布尚未检查的模板修改：

```bash
docker compose --env-file deploy/.deploy.env -f docker-compose.prod.yml -f docker-compose.ip.yml \
  exec -T nginx /bin/sh /etc/nginx/openpbl-templates/render-config.sh
docker compose --env-file deploy/.deploy.env -f docker-compose.prod.yml -f docker-compose.ip.yml \
  exec -T nginx nginx -t
docker compose --env-file deploy/.deploy.env -f docker-compose.prod.yml -f docker-compose.ip.yml \
  exec -T nginx nginx -s reload
```

按实际配置追加已有覆盖文件。核对宿主和容器中所选模板的 `sha256sum` 相同，并从公网验证现有哈希资源、`/vendor/` 资源及缺失资源的状态和缓存头；应用健康接口不能代替代理资源验收。隔离回归入口为 `node --test scripts/lib/nginx-static-cache.test.mjs scripts/lib/nginx-template-render.test.mjs`，涉及真实 Nginx 的测试仅使用已缓存镜像，不拉取镜像或操作生产代理。

当前宿主启用监控时，在上述两个 Compose 文件之后追加 [宿主覆盖](monitoring/docker-compose.host.yml)，仅启动 Prometheus。它使用本机缓存的固定镜像，以监控令牌文件的属主运行，保留令牌 `0600` 权限；采集现有 `127.0.0.1:18082` 内部入口，面板仅监听 `127.0.0.1:9090`。先确认该端口空闲，当前操作用户与令牌文件属主一致，再逐步执行；前一步失败时停止：

```bash
export OPENPBL_MONITOR_UID="$(stat -c %u deploy/secrets/monitor_token.txt)"
export OPENPBL_MONITOR_GID="$(stat -c %g deploy/secrets/monitor_token.txt)"
install -d -m 0700 .openpbl-data/prometheus
docker compose --env-file deploy/.deploy.env \
  -f docker-compose.prod.yml -f docker-compose.ip.yml -f deploy/monitoring/docker-compose.host.yml \
  --profile observability config --quiet
docker compose --env-file deploy/.deploy.env \
  -f docker-compose.prod.yml -f docker-compose.ip.yml -f deploy/monitoring/docker-compose.host.yml \
  --profile observability up -d --no-deps --no-build --pull never prometheus
```

启动后检查实际采集目标健康、至少两轮 `up{job="openpbl"}=1`、正数采集样本及规则评估健康；面板存活不能代替采集成功。宿主配置只列已启用的应用采集，未部署 exporter 的指标仍是未知。当前没有外部通知目的地，规则状态可在本机面板/API 查看，不能称作外部通知已经送达。停止时使用相同三个 Compose 文件，仅执行 `stop prometheus`，保留数据目录。

完整 bridge 网络的 observability profile 仍使用 [原采集配置](monitoring/prometheus.yml)。不要在当前宿主直接启动整个 profile：Grafana 默认映射 `127.0.0.1:3002`，与代码运行器冲突，其余 exporter 也需适配实际端口后才能启用。异地支持绑定正式教学班的单次课堂研究备份，并保留旧账号与首课问卷手动入口，范围和有限调度见[备份说明](backup/README.md)。Nginx 的应用、WebSocket 和内部检查端口须与已安装服务一致。

可选的 [Nginx edge 日志覆盖](monitoring/docker-compose.nginx-edge.yml) 将固定课堂 API 的 Nginx 首字节到响应完成时长汇总给现有应用 `/api/metrics`。它能测到 Node 解析 HTTP 之前的等待，也包含客户端上传/响应发送时间；不能测浏览器发请求前排队、渲染或绕过 Nginx 的3000直连。后者保持未知。GET/HEAD普通读、已确定的进度/学习事件写按1秒/2秒观测；混合AI POST单独标记，不把202当审阅成功。不配置时只有监控未知，应用 readiness 不受影响。

启用前必须先完成真实隔离 Nginx 的读取权限、轮转及协议验证。不要把 Docker stdout 的50MiB×5策略当作 bind日志的轮转。该覆盖只复用已有 Nginx 容器和 reload循环，不增加监控服务：

1. 用宿主应用实际主组ID设置 `OPENPBL_EDGE_LOG_GID`；预先创建专用 `.openpbl-data/nginx-edge` 目录。覆盖启动时以容器master用户把**此目录**设为 `nginx:<应用组>`、2750，current文件0640。nginx worker能写、宿主应用通过组只读；不要让应用读取 Docker socket，也不要用0777解决权限。验证实际 UID/GID/文件新建方式，不假定已有named volume宿主可读。
2. 在现有 prod、ip、monitoring host Compose文件之后追加 `-f deploy/monitoring/docker-compose.nginx-edge.yml`；先检查合成配置和 `nginx -t`，再按现发布流程更新这一 Nginx 实例。专用http-context include仅在启用此覆盖时挂载；服务器/端点未改变。actions location另挂一个仅含edge access_log的include，保留原专用日志并避免丢继承或重复edge计数；未启用时glob为空，原行为保留。
3. 在 `openpbl.service` 的 systemd 用户服务 drop-in 中设置 `Environment=OPENPBL_NGINX_EDGE_LOG=%h/OpenPBL/openPBL/.openpbl-data/nginx-edge/current.ndjson`（路径随实际仓库调整），再按完整构建/同步流程daemon-reload及重启。`%h` 适用于此 unit 配置；若通过普通环境文件或 shell 设置，使用展开后的实际绝对路径。应用启动前读取现EOF作为这次计数生命周期起点，不能临时只在终端export后声称服务已配置。可选文件初始化和每次metrics刷新最多等待500毫秒，超时标未知且保留同一个实际I/O；迟到打开的FD在关闭后释放，不重复并发打开。这个计时器也会受到JS调度影响，不是硬实时保证。
4. 维护循环每30秒检查当前文件，达到50MiB后rename/reopen，保留5份旧文件并回收最老文件，同时保留原每6小时nginx reload。文件在检查间隔内可能超过50MiB，这不是文件系统硬配额；`maintenance.json` 超过90秒、reopen失败、采集积压或权限失效另报未知。可通过同一Compose组合 `exec -T nginx /bin/sh /usr/local/bin/openpbl-nginx-edge-maintenance once` 执行一次检查，不手动copytruncate。磁盘容量仍需正常监控。
5. collector每次最多读取256KiB/单行4KiB，重叠采集合并。轮转先读出已知旧文件字节，再从新文件头接续；没有Nginx写者关闭确认协议，因此**轮转后5分钟保守标不完整**，不宣称无损。损坏/丢代、截断、读失败也如此；已读到的慢样本仍保留并能告警，未知不会压掉已知故障。维护/collector健康且没有流量只表示日志可读，延迟仍无样本/未知。计数随应用重启，旧日志不重放为新流量。固定成功SLO路由在首次创建直方图时初始化空计数，不伪造0秒样本；通常以一分钟内至少20个真实计数增量、无重置及两次抓取判定。采集生命周期开始不足60秒时，可按本生命周期的真实绝对bucket/计数识别第一次抓取前已完成的突发；scope缺失、未知、过期及不足20个样本均不启用这条补线。

启用或退出必须同步Nginx覆盖、服务环境及指标来源；撤销时不删除旧日志证据。原Node/handler指标保留，面板须标明来源和边界，不能把本可选日志的“已读样本”当全部终端coverage。规则测试使用 `monitoring/edge-ingress.rules.test.yml`；正式30人门槛仍由相同构建完整验收判断。

不要运行 `docker compose down -v`，因为 `-v` 会删除持久化数据卷。备份与恢复演练说明位于 `deploy/backup/`。

## GitHub Actions

手动触发 [.github/workflows/deploy.yml](../.github/workflows/deploy.yml)，先执行共享验证，再通过 SSH 在服务器的专用 Git checkout 中部署本次 workflow 对应的完整提交 SHA。服务器构建应用，由已安装的 systemd 用户服务运行。

每个 GitHub environment 配置 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_HOST_KEY` secrets，以及绝对路径变量 `DEPLOY_PATH`。服务器需具备 Node.js、pnpm、Python 3.10+、Git、flock、curl，能够从 origin 拉取提交，并已安装指向该路径的用户服务及所需 secrets。不同环境使用独立用户或主机，不能共用同一组生产服务。

首次安装服务时，核对 `deploy/systemd/` 模板中的路径与端口，按[站点地址](#站点地址与现有配置)显式配置本部署入口，再安装到用户 systemd 目录。CI 更新不覆盖这些环境配置。默认健康检查访问 3000 端口；非默认端口通过 GitHub environment 变量 `DEPLOY_PORT` 设置，并与服务配置一致。

部署 checkout 必须干净（凭据和运行数据应保持忽略），并允许切换到 detached HEAD。执行前完成上文要求的备份。脚本以 Git 锁防止同一 checkout 同时更新；构建失败不会重启当前服务。应用服务启动时执行已提交迁移，健康检查失败会明确退出；数据库迁移后不自动回滚旧代码，需根据迁移兼容性恢复。实际入口为 `bash deploy/deploy-systemd.sh <完整提交SHA> <项目绝对路径> [应用端口]`。

HTTP 上游默认保留最多 256 个空闲连接，代理空闲期限为 60 秒，仓库提供的 Next 生产启动入口空闲期限为 65 秒；Nginx、systemd、Docker 和隔离课堂验收使用相同默认值。`KEEP_ALIVE_TIMEOUT` 仍可由部署环境显式覆盖，变更时同时核对代理的空闲期限。模型执行、业务 HTTP 期限和活动请求并发沿用现有配置；空闲连接上限不充当活动任务并发上限。

变更连接策略后分别核验冷进入与复用流量、正常及取消响应、服务重启及原保存回执，并以实际浏览器的原 P95 门槛复验。上游响应中的 `Keep-Alive` 提示只说明该连接的空闲期限，不等同于模型期限或课堂已通过。
