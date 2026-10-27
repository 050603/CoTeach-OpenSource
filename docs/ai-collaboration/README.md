# 文档 AI 协作与验证

本文面向维护文档工作台、请求恢复和教学边界的开发者。学生操作见[使用说明](../user-guide.md#文档工作台)，代码运行器及跨模块关系见[系统架构](../architecture.md#文档与代码协作)。

## 当前入口与任务边界

学生通过侧栏自然语言或选区操作发起请求。文档后台自动段落批注已停用；旧 `proactive-document-comment`、`proactive-document-comments` 和 `resume-proactive-review` 入口返回 `410 DOCUMENT_AUTOMATIC_REVIEW_RETIRED`，不创建或恢复模型任务。历史批注和审计保留，代码工作区的共享队列继续使用。

[意图判断](../../src/lib/ai-collaboration/document-member-intent.ts) 区分讨论、检查、总结、选区编辑和委派工作。例如“看看哪里可以修改”请求检查，“帮我统一标题编号”请求交付，“我想做一个项目”仍是讨论。后续接单根据课程目标、实际用途、已有材料和学习责任判断允许范围；排版、资料整理等操作也不能脱离课程目标成为永久白名单。

| 请求 | 当前行为 |
| --- | --- |
| 概念、方法、已有进展的讨论与检查 | 回答当前问题，保留真实依据和不确定性，不默认为修改授权 |
| 明确要求整理或修改已有材料 | 判断能力与辅助范围，完成可执行交付，在正文预览红删绿增标记，由学生在聊天框确认应用或拒绝 |
| 核心选题、论证、决策或结论代做 | 保留学生责任，提供方法支持；不能在拒绝后附带可直接采用的核心答案 |
| 来源不足或位置不明确 | 澄清缺少的材料或定位；不能编造数据、引文或把定位失败降级成追加正文 |
| 与当前稿无入文关系的讨论或独立模板 | 保留 `documentPlacement: none`；不向稿件写入内容 |

已有文字的纠错、保持原意的局部润色与精简、格式整理均可承担；不得改变学生推理、观点或证据，文字创作本身属于课程核心学习时仍只提供指导。不能完成时说明需要学生完成的具体部分、原因和可执行的下一步，不用空泛承诺代替帮助。

讨论和交付都需要保留数字、单位、样本范围、立场类别、链接及缺失项。“未记录”不能变成“未实施”，“不支持”不能变成“明确反对”；不同来源的时间、地点和对象不得混用。课程目标、原稿 HTML 标题路径和当前请求分别提供要求、材料位置与授权范围，历史请求不能冒充当前授权。

## 审阅、应用与留存

建议和交付绑定文稿版本与定位锚点。接受、拒绝及撤销各自留痕；文稿发生变化后，旧交付不能直接覆盖新稿。标题层级从实际 HTML 读取，不凭纯文本将正文提升为标题。所有修改请求都先进入待审阅流程：局部修改、段落替换、删除和新增在正文中用红删绿增标记预览；学生可在聊天框确认应用、拒绝或退回修改。未确认的预览不进入自动保存或最终提交，确认应用后才写入并保存，仍可撤销。仅讨论或检查不能触发修改。刷新与重试恢复的结果仅供审阅，避免重复写入；文稿或对话变化时不自动应用。定位失败应说明尚未修改，不能声称完成。

服务端读取当前会话持久历史，客户端自带的历史不能替代它。跨会话已交付及采纳记录用于累计学习责任判断；未知采纳状态不能当作已经采用，必需历史读取失败不能当作空历史放行。原始请求、模型输出、复核、建议决策和错误分别保存，导出与去重口径见[研究数据完整性](../database/research-integrity.md)。

接单判断与首稿合并生成，只有材料身份、授权范围和入文位置通过服务端校验的首稿才能进入独立交付复核；保留模型与输出预算。可选记忆、资料检索和累计交付读取按依赖关系并行，当前格式任务不因旧对话触发额外检索。界面及时显示接单状态和已等待时长。

接单、交付、结构及语义复核使用持久检查点和共享的有界修复额度。候选、原始模型响应、策略版本和已使用额度一起保存，同请求恢复不能重置额度。模型生成完成不等于可交付；额度耗尽仍不合格时记录内容失败，不向学生展示不可靠内容，也不误记为教学边界拦截。具体检查点字段和指纹以[请求处理器](../../src/lib/ai-collaboration/document-handlers.ts)及[请求存储](../../src/lib/ai-collaboration/document-request-store.ts)为准。

## 异步请求与故障恢复

正式浏览器通过 [document-collaboration-transport.ts](../../src/lib/browser/document-collaboration-transport.ts) 发送 `Prefer: respond-async`。服务端先持久接单，再返回 `202` 与 `requestId`，通过 Next.js `after()` 执行模型工作；浏览器查询同一持久回执直至完成、失败或取消。连接中断不能解释为模型没有执行。

当前文档请求的服务端执行预算为 300 秒，浏览器总等待窗口为 320 秒，租约为 335 秒；查询与取消的单次等待最多 8 秒。文档的异步预算与代码协作及兼容同步请求不同，常量以[请求预算](../../src/lib/ai-collaboration/request-budget.ts)为准。调整代理超时不能替代持久接单和状态恢复。

| 状态 | 恢复原则 |
| --- | --- |
| `processing` 或传输结果未知 | 查询或取消原请求；不自动新发相同任务 |
| `completed` | 复用保存的结果；后续审计失败不能把完成回执降为失败 |
| 已确认失败且可重试 | 使用原请求身份和完整载荷，只续尚未完成阶段 |
| 不可重试的内容失败 | 保留原稿和失败原因，调整问题后作为新消息发送 |
| 请求编号绑定另一份内容 | 返回冲突，不能覆盖原请求或沿用其结果 |

本机草稿与待确认的保存请求分别保留。刷新后先重放已发送请求，取得回执再保存后续编辑；迟到回执仅清除它对应的请求和草稿快照。未保存、保存中和保存失败不能显示成已保存。

## 外部内容使用提醒

教师开关 `pblConfig.documentPasteMonitoringEnabled` 默认关闭，随课程版本发布，并在创建课堂时显式复制到 `runtimeConfig`。历史课堂缺字段按关闭处理；课堂覆盖不回写课程默认，开关不参与课程内容质量签名。此功能仅覆盖 `make` 阶段文档成果编辑区的真实文本粘贴，不恢复已退役的自动批注。

浏览器以单次 300 个非空白字符或 30 秒累计 600 字作为候选门槛，排除已见的内部搬移和重复内容。服务端核验当前课堂、身份、会话版本和开关，通过已有可访问的 AI 可见正文匹配来源，仅豁免匹配部分。剪贴板声明不提供权限；模板骨架和不确定内容优先放行。模型需要给出连续、可核验的任务原文和粘贴片段，不能根据文风、隐藏字符或概率认定 AI 来源。超过 30,000 字符不截断后强行判断。

`/api/project-practice/content-monitor/checks` 提供幂等提交和回执；`events` 提供本人或任课教师记录读取与说明、核实。独立 `AiTask` 队列使用后台容量，单次模型调用上限 30 秒，技术失败最多重试一次。正常结果与失败任务清理检测正文，触发提醒保留必要片段；提醒及后续说明使用独立 `DomainEvent`，不进入 AI 对话次数和过程评分证据。检测失败、关闭或课堂结束均不阻塞文稿保存与提交。

固定合成样例的真实模型验证入口是 `pnpm exec tsx scripts/verify-content-monitor.ts --real-model --deployment-secrets`；不写课堂记录，输入和逐例结果保存在忽略目录 `.openpbl-runtime/content-monitor`。结构回归、真实模型准确性、真实数据库和浏览器验证须分别报告，提醒不能作为违规认定。

数据库回归入口 `pnpm exec tsx scripts/verify-content-monitor-database.ts` 使用临时 PostgreSQL 容器验证鉴权、幂等、后台租约、关闭取消与记录隔离，默认清理容器；`--keep` 保留合成课堂及私有环境清单，供独立端口的浏览器验收使用。`e2e/document-content-monitor.spec.ts` 验证模拟接口下的真实编辑器操作；`e2e/document-content-monitor-live.spec.ts` 仅在 `OPENPBL_CONTENT_MONITOR_LIVE=true`、独立应用指向该合成数据库且 `OPENPBL_RESOURCE_E2E_BASE_URL` 为非 3000 本机端口时运行，验证真实接口、模型与教师核实读回。独立应用的模型供应商配置需另行提供，不能把空的测试数据库视为已配置模型。

## 确定性回归

按实际改动选择既有测试，不需要每次运行全部模型验收：

```bash
pnpm exec vitest run src/lib/ai-collaboration/document-member-intent.test.ts src/app/api/ai-collaboration/document/route.test.ts
pnpm exec vitest run src/lib/browser/document-collaboration-transport.test.ts src/components/views/student/document-ai-collaboration-recovery.test.tsx
pnpm exec vitest run src/lib/ai-collaboration/delegated-work-policy.test.ts src/components/views/student/document-ai-collaboration-undo.test.tsx
```

这些检查覆盖意图、已停用入口、异步回执、恢复、边界及撤销等实现契约，不证明真实模型的内容质量。

## 真实模型与浏览器验收

[验收入口](../../scripts/run-document-boundary-acceptance.mjs) 复制已完成的生产 standalone，启动一次性 PostgreSQL、Redis 和独立应用实例，只读取得已部署的全局供应商配置。业务写入使用合成身份和课程，实际请求经过真实鉴权、文档接口和模型。运行需要可用的 Docker、生产构建、供应商配置和空闲端口，调用会使用真实模型额度。

```bash
DOCUMENT_BOUNDARY_LABEL=current-matrix \
node scripts/run-document-boundary-acceptance.mjs
```

固定题目与预期标签以[验收夹具](../../scripts/lib/document-boundary-acceptance-fixtures.mjs)为唯一来源，默认 18 题各运行 3 次。第 18 题的前序对话也经过真实接口；第 03 与 17 题用相同文稿及请求、不同课程目标检查允许范围。附加约束题 M01–M03 单列分母。题目标签、结构检查和 HTTP 200 都不能直接当作模型质量通过。

| 参数 | 用途 |
| --- | --- |
| `DOCUMENT_BOUNDARY_RUNTIME_RELEASE` | 选择 `.openpbl-runtime/releases/<BUILD_ID>` 下已就绪的不可变版本，校验标记和资源身份 |
| `DOCUMENT_BOUNDARY_BUILD_DIR` | 无指定发布版本时选择构建目录，默认 `.next-build`；必须等构建完成 |
| `DOCUMENT_BOUNDARY_PORT` | 隔离端口，默认 3296，拒绝使用 3000 |
| `DOCUMENT_BOUNDARY_MODE=browser` | 验证真实页面的修改预览、确认后保存刷新读回、撤销及拒绝/接受；不代替模型矩阵 |
| `DOCUMENT_BOUNDARY_BROWSER=1` | 在矩阵后追加浏览器验收 |
| `DOCUMENT_BOUNDARY_CASES`、`DOCUMENT_BOUNDARY_REPEATS`、`DOCUMENT_BOUNDARY_WORKERS` | 缩小复核范围或控制并发；局部结果不代表完整矩阵 |
| `DOCUMENT_BOUNDARY_RESUME=1` | 继续同名目录，复用已完成场景 |
| `DOCUMENT_BOUNDARY_RETRY_FAILED=1` | 对再次确认可重试的失败请求追加一次显式恢复；首次结果单独保留 |

脚本仍有历史 `concurrency` 模式，会同时请求已经退役的自动批注接口。该部分应得到停用响应，不能再按自动批注成功率验收，也不能将其当作当前整班容量证明；现行容量入口见[负载测试说明](../../tests/load/README.md)。

中止时在本次运行目录创建 `STOP` 文件或向驱动进程发送 `SIGUSR2`，停止新派发并等待在途请求收尾。报告、模型审计和隔离数据库快照保存在 `.openpbl-runtime/document-boundary-acceptance/<版本>/`，不提交到 Git。

复核区分任务边界、材料澄清、技术失败、交付失败和实际可见内容失真。逐条检查最终回复的事实、范围和学习责任，首次失败与后续恢复分别报告；未展示的候选稿保留作诊断，不算作学生收到的错误。相同口径用于对照版本，历史结果不作为本次验收结果。
