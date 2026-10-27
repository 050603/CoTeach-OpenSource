# 本机完整备份与课堂精简异地备份

三种入口的保护范围不同，按恢复目标选用：

| 入口 | 数据范围 | 用途与限制 |
| --- | --- | --- |
| `local-backup.py` | 全库、文件字节、私有配置与源码快照，配合基础备份和 WAL | 本机完整恢复；同盘副本不能覆盖整机或磁盘丢失 |
| `classroom-research-backup.py` | 指定教学班的研究记录、题目与答案、AI 完整消息及文件引用 | 加密异地研究封存；不包含附件/媒体字节及完整运行环境 |
| `manual-essential-backup.sh` | 指定教学班学生账号和首课问卷 | 兼容的手动精简备份；不能代替课堂研究包或全站恢复点 |

以下命令从仓库根执行。部署依赖、Secret 与存储配置分别见[部署说明](../README.md)和[凭据说明](../secrets.example/README.md)。本文描述工具行为，不表示某台主机的定时器、云传输或恢复演练已完成。

## 单次课堂保护与研究封存

完整数据保存在本机，阿里云保存正式教学班的精简研究包。入口为 `classroom-research-backup.py`，
使用现有 Docker 备份镜像和三份 Restic/S3 密钥，在 Bucket 的独立 `openpbl-classroom-research/` 前缀加密存储。
旧手动精简仓库保持可读。系统凭据、服务商密钥、完整源码、教材向量和附件/媒体字节不进入云包。
学生账号记录包含密码哈希，研究正文可能包含身份信息，因此包不是匿名数据；明文目录使用 `0700` 权限，
不应上传到 Git 或共享报告。

研究包按绑定的教学班 ID 纳入已有和随后创建的课堂，不依赖课程名称匹配，也不按当天时间裁掉前测或既有问卷。
每次导出使用同一 `REPEATABLE READ READ ONLY` 事务，按表保存 JSONL：账号与选课、课程/题目与课堂版本、
学习事件、AI 会话/完整消息/任务/操作事实、阶段提交、项目工作区、前后测分配/草稿/正式答案、反思评价、
讨论干预、小组协作和成果版本。文件仅包含引用、大小与摘要，恢复文件字节仍需本地完整恢复点。
`manifest.json` 保存格式版本、快照时间、数量和 SHA-256；研究键、场次、阶段和操作标识保留在原记录中。
原始事件与消息分别存放，不能把两者的行数相加当作交互轮数。新包的 `diagnostics` 统计研究键和消息引用异常，
重复措辞只标记为疑似重复，不删除原记录，也不自动计零分。

先准备本机恢复服务、`deploy/.deploy.env` 中的 `BACKUP_S3_ENDPOINT`、`BACKUP_S3_BUCKET`、`BACKUP_S3_REGION`，以及 `deploy/secrets/` 中的 S3 与 Restic 密钥。构建备份镜像可用 `docker build -f deploy/backup/Dockerfile -t openpbl-backup:0.1.0 .`；使用其他镜像名时在执行环境设置 `OPENPBL_BACKUP_IMAGE`。

首次启用新仓库时显式初始化；仅在 Restic 明确返回“仓库不存在”时初始化，认证或网络失败直接报错。
普通备份和定时任务从不隐式初始化。

为每次教学安排设置独立标签、正式教学班 UUID、带时区的开始与结束时间。下列四个环境变量由操作者填写；**所有场次命令显式传 `--session`**，避免采用脚本保留的历史默认标签。

```bash
research_session="${CLASSROOM_BACKUP_SESSION:?设置本次唯一标签}"
research_offering="${CLASSROOM_BACKUP_OFFERING:?设置正式教学班UUID}"
research_start="${CLASSROOM_BACKUP_START:?设置带时区的开始时间}"
research_end="${CLASSROOM_BACKUP_END:?设置带时区的结束时间}"
python3 deploy/backup/classroom-research-backup.py init-repository
python3 deploy/backup/local-backup.py backup --force-base
python3 deploy/backup/classroom-research-backup.py arm \
  --session "$research_session" --offering "$research_offering" \
  --start "$research_start" --end "$research_end" \
  --install-timer
python3 deploy/backup/classroom-research-backup.py backup --session "$research_session"
python3 deploy/backup/classroom-research-backup.py status --session "$research_session"
```

`arm --install-timer` 安装当前用户服务和场次专用有限日期定时器：从课前 15 分钟至课后 1 小时，
每 5 分钟检查一次；云端间隔 15 分钟备份，内容未变且此前回读成功时不新增快照。
定时器仅含本次保护窗口的日期，不是每日重复计划。
更改教学班或时间应使用新的 session，避免复用标签改变证据范围。
既有本地每 5 分钟恢复点及持续 WAL 保持运行；没有新增每日轮转策略。
课前显式执行 `backup --force-base` 会先创建并校验新基础备份，即使上一份尚未满 24 小时；
可避免基础备份恰好在课堂高并发时过期。校验失败不会更新成功恢复点。

课后 15 分钟起，连续两次间隔至少 5 分钟观察到相同研究内容，且服务端 AI 任务及本班待补写/隔离审计队列均收敛后，
先完成云端上传与实际下载验证，再建立新的本地完整恢复点，复核无迟到数据后封存。
本地备份锁忙时延后重试，不能把已有旧恢复点充当最终封存。
课堂不存在、待处理项未收敛、校验失败或上传失败时保留原数据与待传包并记录原因；
到截止时间仍未完成时状态为 `incomplete`，不会声明封存成功；仍尝试上传截止时的最新研究包，
并将最新完整本地恢复点标记为临时长期封存，避免因未收齐数据而在 30 天后丢失恢复副本。
临时封存由 `provisionalSealSession` 标识，`provisionalSnapshotIsFinal=false`；两端失败分别记录错误，
一端失败不会阻止另一端保留。可用原 `tick` 命令重试截止保护，正常最终封存与临时副本保持区别。
浏览器中未发送到服务器的内容无法由服务器备份观察或保存。

```bash
systemctl --user status "openpbl-classroom-backup@$research_session.timer"
journalctl --user -u "openpbl-classroom-backup@$research_session.service"
python3 deploy/backup/classroom-research-backup.py tick --session "$research_session"
python3 deploy/backup/classroom-research-backup.py export --session "$research_session"
python3 deploy/backup/classroom-research-backup.py verify \
  --directory "${CLASSROOM_BACKUP_PACKAGE:?设置已导出或下载的研究包目录}"
```

上传失败不会更新成功回执。成功必须包含实际下载、核对完整文件集合、逐文件摘要、JSONL 解析与数量验证。
回执位于 `.openpbl-data/classroom-backup/status/<session>-cloud.json`，场次状态为 `<session>-session.json`。
待传包保存在 `packages/`；未变化的表文件使用硬链接复用，最终包不自动过期，没有执行云端 `forget/prune` 的日历清理。
研究包支持重新读取研究记录，不提供完整数据库外键恢复、附件字节或整站重建保证。

本地最终快照通过 `local-backup.py seal --session <标签> [--snapshot <已完成快照>]` 固定，
清单位于本地备份根目录 `seals/`，默认不自动过期。同标签重试幂等，不能改绑其他快照。
可用 `local-backup.py drill --session <标签>` 在隔离容器中恢复指定封存。
普通 30 天清理保留封存快照、基础备份和所需的有限 WAL 区间，避免旧封存导致未来 WAL 无限累积；
历史无结束 WAL 的封存保守保留，显式对原标签再次 `seal` 可补齐结束段。
损坏的封存清单会阻止清理，不能静默丢弃依赖。

本地验证、云端验证和课堂最终封存是三个独立状态；课前演练不能证明后续课堂已封存。

## 本机课堂恢复点

`local-backup.py` 在 `.openpbl-data/local-backup/` 保存完整课堂数据，目录权限为 `0700`。**它不调用云端存储或现有手动备份。** 同一磁盘上的副本可处理误删、应用错误和数据库逻辑损坏，不能应对整机或磁盘丢失。

- PostgreSQL 每日基础备份，使用当前数据库的同一个本机镜像（含 pgvector），并运行 `pg_verifybackup`。
- `openpbl-local-wal.service` 持续同步接收 WAL；专用复制槽保留 WAL，上限 4 GiB，接收器长期离线时避免无限占用生产磁盘。超限丢失 WAL 后必须重新建立基础备份，状态检查不会继续报告健康。
- 每 5 分钟生成完整逻辑数据库快照（包括账号、所有学习过程、AI 对话、原始答案与实践版本），在同一 MVCC 快照记录每张表的行数和内容摘要。目录格式按表压缩，未变化的表数据复用前一快照的硬链接，避免重复保存大型教材与向量表。
- 同时保存全部 uploads、classrooms、whiteboards、AI 审计待补写队列和运行所需配置/密钥，使用硬链接复用未变化的文件；SQLite 使用在线备份 API。待补写队列在数据库快照之前复制，确保消费中的事件至少存在于队列副本或后续数据库快照。为所有文件生成 SHA-256，并按数据库的 `FileAsset` 引用检查上传内容，任何缺失或摘要不符均不得确认成功。
- 本机配置还保存当前用户实际安装的 `openpbl*.service`、`openpbl*.timer` 和 `openpbl*.service.d/*.conf`，还原时将 `configuration/installed-user-units/` 下的相对路径映射回 `~/.config/systemd/user/`。精确白名单 `~/.config/openpbl/site.env` 与 `~/.config/openpbl/course-read.env` 保存到 `configuration/installed-user-config/` 下的同名文件，恢复时映射回 `~/.config/openpbl/` 并保留原权限；其他用户应用配置不扫描。恢复后的站点地址应与原环境一致，迁往新域名时须显式调整。这些配置只进入私有本地备份，不进入云端研究包；旧部署没有上述可选文件时仍可备份和验证。
- 若 `.openpbl-data/capacity-evidence/` 存在，额外保存容量验收原始证据至 `files/capacity-evidence/`，包含逐运行报告与附件，沿用增量硬链接、完整文件 SHA-256、隔离恢复逐文件校验及 30 天保留策略；没有该目录的旧部署与旧恢复点仍可验证业务数据。uploads/classrooms/whiteboards 仍为必需目录。验收目录和内部符号链接会拒绝备份，避免读取目录外数据。此副本只保留当时原始字节，不重建已丢失报告，也不把进行中或失败的验收结论改为通过。
- `source/` 独立保存当前工作树的应用/工作区包源码、静态资源、脚本、依赖锁文件与补丁、Prisma schema/全部迁移、Next/TypeScript 构建配置及部署工具，包含已跟踪文件的未提交修改和未忽略的新文件。分发与维护输入包括 `licenses/`、`THIRD_PARTY_NOTICES.md`、根 `LICENSE`/`NOTICE`、`CITATION.cff`、README、贡献/安全说明、`.gitleaks.toml`、`.github/` 及单独列入白名单的 `docs/open-source.md`；不会因此收录整个文档目录或过程报告。`source-manifest.json` 记录各文件 SHA-256、字节数和权限，以及整树摘要、Git HEAD 和 dirty 标记；外层 manifest 另外记录源码清单的 SHA-256。Git HEAD 只是基准提交，**不代表备份源码等于该提交或当前运行的 immutable release**。发现复制期间源码变化或必要构建输入缺失时，不确认该恢复点。
- 源码只从明确的源码目录/根配置白名单选择；排除 `.git`、Git/SSH/registry 凭据、`node_modules`、运行数据库文件、测试报告/大产物、生成的 `dist`/`workers`/Next 构建与 runtime 目录，并拒绝源码符号链接。密钥仍只走原有私有 `configuration/` 范围。DOCX worker 的 engine/pool/入口、`build-document-converter-worker.mjs`、锁定依赖与 DOCX 补丁必须齐全；生成 bundle 可以重建，不重复备份依赖目录。所有内容继续在权限 `0700` 的本机备份根目录内，未修改 30 天策略。
- 只清理超过 30 天的备份，保留覆盖最早恢复点所需的前一个基础备份及 WAL；不会删除业务原始数据。配置和凭据只存在私有备份目录，不写入报告。

主机需要 Docker、Python 3 和 rsync，无需安装额外 Python 包。默认连接本机 `openpbl-postgres-1` 容器的 PostgreSQL 16、端口 15432、数据库 `openpbl`，使用现有 localhost trust 规则。非此部署需通过 `OPENPBL_BACKUP_POSTGRES_CONTAINER`、`OPENPBL_BACKUP_POSTGRES_PORT`、`OPENPBL_BACKUP_DATABASE` 和 `OPENPBL_BACKUP_DATABASE_USER` 指定目标，并检查数据库访问规则。

首次安装（下列 units 使用 `%h/OpenPBL/openPBL`，由 systemd 展开为服务用户家目录下的仓库；其他仓库位置先替换为实际绝对路径）：

```bash
python3 deploy/backup/local-backup.py setup
install -d -m 0700 ~/.config/systemd/user
install -m 0644 deploy/systemd/openpbl-local-{wal.service,backup.service,backup.timer,backup-health.service,backup-health.timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now openpbl-local-wal.service
systemctl --user start openpbl-local-backup.service
python3 deploy/backup/local-backup.py status
systemctl --user enable --now openpbl-local-backup.timer
systemctl --user enable --now openpbl-local-backup-health.timer
```

`setup` 创建专用复制角色和槽，通过 `ALTER SYSTEM` 将 `max_slot_wal_keep_size` 设置为 `4GB` 并热加载，不重启正式数据库；此设置对该数据库实例的所有复制槽生效。新增其他复制消费者前应重新评估上限。服务故障可从 `journalctl --user -u openpbl-local-backup.service -u openpbl-local-wal.service` 查看；不要删除生产数据卷。

日常检查：

```bash
python3 deploy/backup/local-backup.py status
python3 deploy/backup/local-backup.py drill
python3 -m unittest discover -s tests/deploy -p test_local_backup.py -v
```

`status` 在完整恢复点超过 900 秒、复制槽不可用或接收器离线时返回非零退出码。恢复点时间采用逻辑快照开始时间，不采用备份完成时间，以免高估 RPO。状态位于 `status/last-success.json`，恢复演练证据位于 `status/last-drill.json`。目标 RPO ≤15 分钟、RTO ≤60 分钟，必须以实际演练结果确认，定时器存在本身不代表达标。

`openpbl-local-backup-health.timer` 每分钟独立检查恢复点、WAL 接收器及备份服务/定时器状态，不依赖应用或 Prometheus。异常时 `openpbl-local-backup-health.service` 返回失败，详情写入 `status/health.json`；状态或原因变化才写一条 journal 事件，不发送任何外部通知。可用 `journalctl --user -u openpbl-local-backup-health.service` 查看；恢复后下一轮自动清除告警状态。

`drill` 首先检查所有备份文件与数据库引用的 SHA-256，然后将基础备份复制到唯一的隔离目录，在 **无网络、无宿主机端口、无生产卷挂载** 的容器中回放 WAL 到备份的命名恢复点；再将逻辑快照恢复到隔离容器的新数据库，并逐表对比全部行的内容摘要。报告只含时间、计数和校验结果。结束后删除该次演练容器与临时数据库副本，保留备份和报告。物理恢复点略晚于逻辑快照；精确表对账以逻辑快照为准，文件与逻辑快照是完整配套恢复点。

新恢复点还将 `source/` 和源码清单复制到隔离目录，独立核验准确文件集合、全部内容与权限、锁文件/迁移/依赖补丁和 DOCX worker 构建输入；结果记入 `sourceRecovery`。恢复点自身的 Dockerfile 若通过 `COPY` 引用根 LICENSE/NOTICE、第三方声明、许可目录或工作区 LICENSE，还必须保留相应输入；未引用它们的旧快照沿用原校验，旧恢复点没有源码快照时明确报告缺失。此项**不安装依赖或执行应用构建**，报告固定 `applicationRebuilt: false`；因此不能据此声称从备份重新构建整站已通过或把既有 DB/文件 RTO 当成包含重建的 RTO。实际源码丢失时，需在新的空目录恢复源码与配置，再按 Node 22、pnpm 10.4.1 执行锁文件安装（保留 postinstall）和 `pnpm build`，验证生成 worker 的 SHA、standalone trace 与页面后才切换；安装可能需要可用的依赖缓存或 registry，此前不覆盖正式实例。

SQLite 在线备份必须在计算文件清单前显式关闭源、目的连接；Python 连接的 `with` 仅提交事务，不代表关闭。否则临时 WAL/SHM 会进入清单并在垃圾回收后消失。非空 WAL-mode 隔离回归同时检查连接回收后的清单稳定性及独立只读恢复内容。

实际恢复时先运行演练验证所选备份，再在维护窗口停止应用写入；将所选逻辑快照恢复到新的数据库实例并还原同一快照下的 `files/`、`configuration/`；需要重建应用时还原 `source/`，验证后切换应用连接。不要直接覆盖仍在运行的生产目录。若只进行物理 PITR，必须另检查命名恢复点与文件之间的新引用差异；持续 WAL 本身不能替代配套文件快照。配置目录含敏感信息，不能上传到代码仓库或附在工单中。

单次课堂容量验收结束后的执行顺序、锁冲突判断、证据位置和 RPO/RTO 核对见 [容量备份与恢复操作单](../../docs/operations/classroom-capacity-restore.md)。该操作单需等待持续负载、最终归档、重启与对账全部结束后再执行，不代表最终恢复已通过。测试自建数据只在新恢复证据确认后清理；投屏探针须显式指定 `--kind=projection-contention`，详见 [清理说明](../../docs/operations/classroom-capacity-cleanup.md)。

## 手动精简备份

旧版精简入口仍可由管理员显式执行，保存下述账号与首课问卷范围。
正式课堂核心研究数据的自动异地备份使用上文的单次课堂入口；本机完整备份和持续 WAL 使用独立的本地流程。

管理员需要备份时，显式运行一次：

```bash
docker compose --env-file deploy/.deploy.env \
  -f docker-compose.prod.yml -f docker-compose.ip.yml \
  --profile manual-backup run --rm --build manual-essential-backup
```

命令执行结束后容器退出，不设定时器、不循环运行。`MANUAL_BACKUP_OFFERING_ID` 必须指向正式课程；脚本会在范围不明确时失败，而不是扩大备份。

### 保存范围

加密 Restic 仓库使用 Bucket 内的 `openpbl-manual-essential/` 前缀，只保存：

- 正式课程选课学生的 `User` 完整记录，包括密码哈希、账号状态和会话版本；
- 正式课程本身、选课关系，以及满足外键恢复所需的最小课程结构；
- 第一章唯一 `FORM` 的定义和全部原始 `ActivitySubmission` 问卷提交；
- 当前数据库 schema、Prisma 迁移记录、校验和及恢复说明。

不会保存教师账号、测试课程、其他活动、课堂运行数据、上传文件、白板、课堂 JSON、媒体、AI 记录、日志或监控数据。

### 检查手动备份

```bash
docker compose --env-file deploy/.deploy.env \
  -f docker-compose.prod.yml -f docker-compose.ip.yml \
  --profile manual-backup run --rm --no-deps \
  --entrypoint sh manual-essential-backup -ec '
    export AWS_ACCESS_KEY_ID="$(tr -d "\r\n" < /run/secrets/s3_access_key)"
    export AWS_SECRET_ACCESS_KEY="$(tr -d "\r\n" < /run/secrets/s3_secret_key)"
    export RESTIC_PASSWORD_FILE=/run/secrets/restic_password
    restic -o s3.bucket-lookup=dns -o "s3.region=$AWS_DEFAULT_REGION" snapshots
  '
```

Restic 密码必须在服务器之外另存一份；密码遗失后云端加密数据无法恢复。恢复时先将快照还原到临时目录，再严格按照快照内 `RESTORE.txt` 操作。该备份不是完整生产环境恢复点。
