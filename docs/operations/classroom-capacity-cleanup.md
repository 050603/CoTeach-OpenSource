# 验收自建数据清理

清理入口：[cleanup-capacity-run.mjs](../../scripts/cleanup-capacity-run.mjs)。**对应运行未结束、未完成新备份与隔离恢复时，不执行本页命令。** 只处理已确认结束的单个 UUID，保留原报告、对账结果及恢复证据，不批量按前缀删除。

默认是 dry-run，只有 `--execute` 才删除数据库及文件。数据库在 Serializable 事务内先核对归属、发现外键依赖（含复合主键关联表）、拒绝所有跨课程/非测试引用，再按依赖顺序删除。只检查本次运行所属记录：最近 15 分钟内的写入、登录或参与活动，以及仍为 PENDING/QUEUED/RUNNING 的 AI 或生成任务会阻止清理；历史 TEACHING 状态本身不表示进程仍在运行。清理前仍须确认验收进程已经退出。

上传和课堂文件在删除数据库前固定安全路径与 SHA；数据库提交后再次检查保留的模板、生成任务和其他课堂 JSON 没有引用这些文件，再逐文件核验摘要并删除。存储根目录和内部符号链接均拒绝，计划后新增或改变的文件保留并报错。课堂文件路径从严格 runId 和类型构造；不信任报告中的任意路径。

## 主课堂 runner

用户名必须为 `capacity-<完整UUID>-<数字>`，课程与模板标题必须精确为 `并发验收 <runId>`，课堂文件标识只能为 `<runId>-lesson`。

`passed` 报告必须包含 `per-student-database-file-reconciliation=通过`。`failed` 或 `partial` 即使有专项通过，也必须显式使用 `--abort-run=<完整runId>`；该参数只确认终止运行可清理，不修改报告结论。

```bash
set -euo pipefail
capacity_cleanup_run_id='capacity-填写完整UUID'
capacity_cleanup_report=".openpbl-data/capacity-evidence/$capacity_cleanup_run_id/report.json"
# failed / partial：先审阅 dry-run 输出，确认每类数量与该运行匹配。
node scripts/cleanup-capacity-run.mjs "$capacity_cleanup_report" \
  --abort-run="$capacity_cleanup_run_id"
# 已确认 dry-run、最终备份和恢复证据后，才执行同一 UUID。
node scripts/cleanup-capacity-run.mjs "$capacity_cleanup_report" \
  --abort-run="$capacity_cleanup_run_id" --execute
```

已对账通过的 `passed` 运行省略 `--abort-run`；其余步骤相同。不要把 `partial` 改写为 `passed`。

## 投屏混合负载探针

[verify-projection-http-contention.mjs](../../scripts/verify-projection-http-contention.mjs) 的历史报告没有 `kind` 字段。必须显式选择 `--kind=projection-contention`，工具不会猜测或改写历史报告：

```bash
node scripts/cleanup-capacity-run.mjs "$capacity_cleanup_report" \
  --kind=projection-contention --abort-run="$capacity_cleanup_run_id"
# 审阅这一 UUID 的 dry-run 后再执行。
node scripts/cleanup-capacity-run.mjs "$capacity_cleanup_report" \
  --kind=projection-contention --abort-run="$capacity_cleanup_run_id" --execute
```

仅接受已完成的 `measured`、`latency-failed`、`failed` 报告；三种情况均要求完整 `--abort-run`。必须有有效且不早于开始时间的 **`finishedAt`**，不能用 `endedAt` 或当前时刻补造终止信息。

该分支要求 42 个唯一用户 UUID；数据库用户名严格为 `<runId>-projection-0` 至 `-projection-41`，ID 与清单索引对应，前 2 人为教师、后 40 人为学生。课程和模板标题精确为 `投屏混合验收 <runId>`，章节标题为 `独立混合锁验收`，课程、章节、活动、场次、模板、首位教师所有权及模板课堂引用全部相符，课堂文件标识固定为 `<runId>-projection-load`。依赖发现若带入另一个课程、章节、活动、模板、场次或非清单账号，整笔清理拒绝。

只兼容已核对的探针清单形状，包括最早没有 `heartbeats/includeState/modes` 字段且具有精确历史 `workload` 文本的版本。未知形状、错标题、其他 run 的 UUID、角色错位、用户清单重复、活跃报告均拒绝，不通过放宽前缀绕过。

## 原始报告缺失的历史运行

仅当原始报告已经缺失，但保存了具有摘要的只读归属清单时，才使用独立的历史清理模式。该模式不会重建性能、保存回执或业务验收结果；回执始终标记 `businessEvidenceRecovered=false`。

历史 manifest 只提供完整 runId、清理用途、原报告摘要和清单摘要。实际清单固定读取 `.openpbl-data/capacity-evidence/historical-cleanup/preserved-inventory.json`；旧 manifest 中的历史路径仅保留为来源信息，不用于任意文件读取。清单和 manifest 均保留在私有目录，不加入代码仓库。

```bash
capacity_cleanup_manifest=".openpbl-data/capacity-evidence/historical-cleanup/$capacity_cleanup_run_id.json"
node scripts/cleanup-capacity-run.mjs "$capacity_cleanup_manifest" \
  --reconstructed-cleanup-manifest --abort-run="$capacity_cleanup_run_id" \
  --plan=".openpbl-data/capacity-evidence/historical-cleanup/$capacity_cleanup_run_id-plan.json"
# 完成预览、归属核验、新备份及隔离恢复后，执行同一 UUID。
node scripts/cleanup-capacity-run.mjs "$capacity_cleanup_manifest" \
  --reconstructed-cleanup-manifest --abort-run="$capacity_cleanup_run_id" --execute
```

清单要求唯一运行、终止状态、全部根对象和账号的历史归属一致，数据库还会重新检查账号数字索引和角色、模板所有权、课程/章节/活动/场次关系及课堂引用。原始报告仍存在时拒绝替代模式；摘要不符、缺失部分根对象、关联范围变大或跨正式课程引用均拒绝。

## 证据与验证范围

`--execute` 在数据库事务提交前原子保存清理计划，包含 runId、kind、原始输入摘要、逐表稳定主键、上传和课堂文件摘要；提交后再标记数据库删除。普通报告仍使用同目录 `cleanup.json`；历史模式使用每运行独立的 `<runId>-reconstructed-cleanup.json`，避免多份 manifest 共用回执。

数据库回滚后计划保留为未提交状态，可重新核验后重试。进程在数据库提交后中断时，原 UUID 重试会检查计划记录全部存在或全部已删除、没有重新创建根对象，并确认上传没有被重新引用，再继续文件清理；部分记录消失或来源摘要改变均拒绝。不删除 `report.json`、对账报告、备份或运行日志。

工具回归入口为 `node --test scripts/cleanup-capacity-run.test.mjs scripts/lib/capacity-reconstructed-cleanup.test.mjs`。可导入 `cleanupCapacityRun`，显式传入隔离 `db`、文件 `rootDir`、完整 `abortedRun` 和回执路径，演练相同清理流程；返回的 `ownedIds` 配合 `rowKeys` / `rowKeyExpression` 可用于逐表保护摘要对账。`--plan` 仅将完整预览写入指定私有文件，终端输出不包含账号和内容。离线形状校验、数据库 dry-run 与实际清理是不同检查，执行时分别记录结果，不能用历史报告或工具测试替代本次数据库归属核对。
