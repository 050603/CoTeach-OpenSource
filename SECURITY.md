# 安全与隐私

## 报告问题

请勿在公开 issue、PR、讨论或 Actions 日志中披露漏洞利用细节、访问令牌、数据库连接、真实账号或课堂数据。

请通过公开源码仓库的 [Report a vulnerability](https://github.com/050603/CoTeach-OpenSource/security/advisories/new) 向维护者私密报告漏洞，也可从 [Security 页面](https://github.com/050603/CoTeach-OpenSource/security) 进入。报告提交后仅维护者和获邀协作者可见。若入口暂时不可用，仅在 issue 中请求恢复私密报告渠道，不描述漏洞细节或附带真实数据。

报告可包含受影响版本、运行方式、影响范围及基于合成数据的最小复现。不要主动测试他人的部署、读取他人的课堂记录或验证泄露凭据是否仍有效。

目前未建立长期维护版本和响应时限承诺。报告时提供提交 SHA；维护者应评估当前开发分支及实际运行版本，不将问题在本地修复等同于用户实例已更新。

## 部署者需要保护的数据

CoTeach 可能保存账号、教材、学生作品与答卷、AI 交互、课程检查点、Provider 凭据和研究导出。导出和假名化不自动完成正文脱敏。具体留存与访问边界见[研究数据完整性](docs/database/research-integrity.md)、[研究导出](docs/database/research-export.md)及[备份恢复](deploy/backup/README.md)。

- 为每个环境生成独立凭据；填好的环境文件、`deploy/secrets/`、Provider 配置和浏览器认证状态只保留在私有位置。
- 按[部署说明](deploy/README.md)配置 HTTPS、反向代理、运行身份和代码执行隔离；本地开发 Compose 的回环绑定不替代生产部署。
- 把真实课堂、教材和模型数据视为私有内容。共享诊断前检查正文、URL 查询参数、文件元数据、截图及日志。
- 保持依赖与运行镜像更新，执行 `pnpm audit:prod`；告警需要结合版本和实际调用评估，不能通过降低审计级别使检查通过。

## 已提交敏感内容时

先撤销或轮换受影响凭据，保留私有处置记录；不要在公开讨论中复制秘密。删除当前文件或补 `.gitignore` 不能删除旧提交。检查所有分支、标签、PR 引用、附件、Actions 日志与产物，再协调历史清理和其他克隆的更新。

历史改写会改变提交 SHA，远端 PR 引用和缓存还可能需要平台支持处理；不能仅凭主分支扫描通过宣布完成。遵循 [GitHub 敏感数据移除说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)及[公开前检查](docs/open-source.md)。
