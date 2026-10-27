# 公开发布准备

本文是维护者在公开仓库、源码归档或镜像前复用的检查流程，不是某次检查通过的证明。CoTeach 自有代码及文档采用 [Apache License 2.0](../LICENSE)，Copyright 2026 李科骏，作者单位为北京师范大学；第三方内容继续适用各自许可。

本项目通过 [CoTeach-OpenSource](https://github.com/050603/CoTeach-OpenSource) 的 `master` 主分支发布：维护仓库继续保留私有，公开仓库不导入旧提交、标签或 PR 引用。首次发布只从固定且已审阅的源码清单导出，校验归档内容与独立恢复后的文件哈希；独立初始化 Git，不复用旧 `.git`、remote 或私人作者邮箱。后续更新沿公开仓库现有主分支正常提交，不重复导入维护历史。历史修复或恢复 bundle 只用于私有维护，不作为公开发行包。报告渠道见 [SECURITY.md](../SECURITY.md)。

## 许可与内容边界

- 确认自有代码、品牌与素材的权利归属，选定许可证后补根目录 `LICENSE`，同步 README、包元数据和贡献规则。不得用新许可证覆盖第三方已有条件。
- 按 [第三方说明](../THIRD_PARTY_NOTICES.md)核对直接引入、复制、移植、字体和运行时下载的依赖。附加限制、来源不明或采用版本不明的部分应先解决授权，或通过有验证的替换方案移除。
- 交付必要源码、迁移、锁文件、运行素材、配置模板、合成回归样例和现行文档。教材、课堂数据、论文草稿、学生作品、实验答卷、日志、Provider 配置与备份不属于默认源码交付范围。
- 二进制、字体、截图和文档附件需人工核对来源及元数据；文本扫描不能证明这些内容无隐私或版权问题。Docker 镜像和其他分发包也应携带所包含组件的许可与声明。

## 内容与秘密扫描

从仓库根执行：

```bash
git status --short
git ls-files -ci --exclude-standard
python3 scripts/check-public-content.py
git diff --check
```

内容检查读取 Git 跟踪文件和未被忽略的新增候选文件，报告路径和类别，不打印匹配的秘密。它拒绝常见私有数据路径、凭据文件和个人附件引用，但不替代秘密扫描、素材授权和人工审阅。按具体路径暂存后，还需导出索引检查最终候选快照，避免工作区与暂存内容不同。

使用 [Gitleaks](https://github.com/gitleaks/gitleaks) 的固定版本扫描候选源码快照与可达历史，启用完整脱敏输出。报告写入私有的忽略目录，不上传公开 Actions artifact。仅在确认是合成测试值后，以规则和准确值限定例外，不能忽略整个测试目录或全部历史。

```bash
umask 077
mkdir -p artifacts/open-source-audit
# 在已审阅并暂存的索引上导出候选文件，不把本地凭据交给扫描器。
candidate_dir=$(mktemp -d "$PWD/artifacts/open-source-audit/candidate.XXXXXX")
git checkout-index --all --prefix="$candidate_dir/"
gitleaks dir "$candidate_dir" --config .gitleaks.toml --redact=100 --no-banner
gitleaks git . --config .gitleaks.toml --redact=100 --no-banner --log-opts="--all --full-history"
pnpm audit:prod
```

候选目录应每次新建，避免旧导出件混入；Gitleaks 的 Git 扫描只覆盖本地实际取得的引用。依赖审计失败、发现秘密或来源不明的素材时，保留真实结果并处理，不通过减少规则或改成警告掩盖问题。

[Public source content 工作流](../.github/workflows/public-content.yml)在 push/PR 中检查候选路径、完整检出的分支/标签历史与源码，使用 SHA-256 固定的 Gitleaks `8.30.1`。它不获取所有历史 PR 引用、不审查 GitHub 页面或二进制附件；因此绿色结果不代表公开前的完整审计已通过。仓库例外只匹配已核实的示例占位符、快捷键和指定测试里的固定幂等 UUID。

## GitHub 上还需检查的范围

从目标 GitHub remote 获取最新引用；本地开发分支、Gitee 与 GitHub 不是同一个发布范围。先确认仓库 URL、默认分支和当前可见性。

在**隔离副本**核对远端全部 branches、tags 和 `refs/pull/*/head`，检查各自可达历史、路径、提交正文、作者与提交者身份。不要在日常工作树重写历史，也不要使用未经筛选的 `push --mirror`。若要移除历史内容，先保存受限恢复副本，确定准确引用及其旧 SHA，完成清理和重新克隆验证后再安排远端变更。

此外逐项人工检查：

| 范围 | 需要确认 |
| --- | --- |
| Issues、PR 与评论 | 私人讨论、内部地址、日志、学生信息和附件 |
| Actions | 历史日志、上传的测试报告、截图、缓存和部署输出 |
| Releases、Packages、Wiki、Pages | 源码之外的下载件、镜像层、附件及站点内容 |
| 历史身份 | 个人邮箱、自动化账号信息与贡献者公开意愿 |
| 仓库设置 | 私密漏洞报告渠道、分支保护、Actions 权限、环境审批和可用的秘密保护功能 |

普通分支净化不保证旧 PR 引用或平台缓存被删除。[GitHub 文档](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)说明了后续清理要求；仓库改为公开还会公开 [Actions 历史与日志](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)。未检查的范围必须单列，不能写成“无泄露”。

## 发布前验收

在干净的独立环境按 [README](../README.md#本地开发)安装并启动，确认 `--frozen-lockfile`、迁移、首个教师账号和必要服务说明可执行。数据库必须与正式环境隔离。依照[开发工作流](agent-workflow.md)验证变动范围，构建产物通过后再验证实际页面与接口；真实模型调用与外部服务应分别记录。

最后审阅最终文件清单与差异，明确：已修复、已验证、失败、未验证和待权利人决定的事项。许可、隐私历史或关键依赖风险未解决时保留私有状态。公开可见性、历史改写、远端推送和对外发布均应针对最终可审阅结果单独执行，不由本地清理自动触发。
