# Automaker 项目级 Jira 同步

入口：**Project Settings → Jira 同步**。现有 CLI worker 由 Automaker API 服务
调度，不需要为每个项目编写 systemd 服务。

## 使用

1. 服务端安装并登录 `jira` CLI，Jira 地址必须与该 CLI 配置的 `server` 一致。
   当前版本复用 CLI 登录，不在浏览器接收 Jira token；切换站点先在服务端配置
   `JIRA_CONFIG_FILE`。GitLab 评审人查询沿用服务端 token 文件。
2. 配置 Jira 项目、JQL、自动/手动标签、轮询间隔、Agent/模型、思考强度，
   目标分支和 reviewer 映射。正常同步的拆分规则固定，不由层级导入选项改变。
3. 「测试连接」验证站点、认证和查询；「预览匹配与变更」显示将创建、更新、
   跳过、阻塞和派发的任务。二者可使用尚未保存的草稿，均不修改 Jira 或卡片。
4. 保存配置后「立即同步」，或启用定时同步。关闭自动执行仍会导入卡片。
   「暂停同步」停止后续定时触发，不终止已运行的 Agent。每次最多派发配置容量
   内的任务；已有运行任务占用容量，同分支及未完成依赖阻止派发。
5. 展开运行记录查看结果、变更字段、run ID；任务卡「同步记录」显示更新来源、
   时间和原因。任务映射列表保留旧 jobs 及派发状态。

Jira 评论回写和人工问答分别配置。MR 固定要求 Draft，不自动合并；
本实现不自动修改 Jira workflow 状态。完成评论表示收到交付回执，不表示人工验收。

### Draft MR handoff

Managed Jira imports keep the issue summary in `jiraSummary` and the requirement
body in `description`. The import/execution contract is stored separately in
`jiraExecutionInstructions` and included when starting a fresh agent conversation.
Follow-ups reuse conversation context. The card highlights Jira summary; details
show requirements first, with execution instructions collapsed. Legacy imported
prompts are left intact and their embedded Jira snapshot is used for display.
Sync preserves already-started descriptions/instructions and stages requirement
changes for human review.

Before a Jira task enters Waiting Review, its current execution receipt must identify
every changed repository and its Draft MR. The server reads those MRs from the
configured GitLab host and checks that they are open drafts targeting the configured
branch, use the task's source branch, and contain the current checkout revision.
When Stories share an Epic worktree, a submodule added by a downstream Story can
be accounted for by that Story's current execution receipt. It must belong to the
same Epic, Jira site, branch and worktree, depend directly or transitively on the
Story being checked, and supply an MR that passes the same remote/branch/revision
checks. The earlier Story's receipt and MR list remain unchanged; downstream test
blockers remain on the downstream Story. Unaccounted repositories and a missing
root MR still block review.
This applies to normal execution, resumed pipelines, and manual status updates.
Missing MRs, stale receipts, branch mismatches, or an unavailable GitLab check keep
the task in Needs Attention with a delivery error. Retry the delivery through Reply
after fixing the reported issue. Human-confirmed Complete remains the only merge step.

## 正常同步与高级层级导入

正常同步：匹配的 Jira 父任务对应一张卡，Jira 已有子任务列为这张卡的交付范围。
匹配标签的 Epic 通过 Epic Link / parent 额外扫描其关联 Story；Story 即使没有
kaka/dodo 标签也独立入板，保留自己的 Jira 标签和已有子任务，不自动派发。
Epic 自身只负责直接子任务，不重复包含 Story 的子任务。Story 没有子任务时仍等待
Jira 拆分或明确的人工决定。
已导入 Story 的 Jira `Blocks` 关系会转为卡片依赖；跨 Epic 的阻塞项若不在看板上，
依赖保持未满足，不会被当成已完成。用户明确批准现有 Story 作为独立交付卡后，
同分支一次仅派发一张；前一张经人工 Verify 进入 Done 后，下一张才有资格自动派发。
执行失败或仍在 Waiting Review 时不会越过依赖。
不为这些子任务重复建卡、不授权 Agent 再次拆分。分支沿用现有约定，新的关联任务按
Epic 根任务归并代码空间；一个父任务的子任务始终在同一个 worktree 完成交付。
已有任务的分支和 worktree 保持原位，不因策略升级重命名或迁移。

未拆分的 Epic/Story 会在预览与卡片上显示“等待 Jira 拆分或人工批准 Automaker 拆分”，
不自动派发。人工启动时提示 Agent 先请求决策，不能把没有子任务当成已授权自动拆分。
若存在旧的独立子卡，预览提示冲突并禁止自动派发父卡；不会删除、合并或重跑它们。
不会扫描未命中同步条件的 Epic 的 Story；祖先仅作为 Story 上下文，不授权跨 Story 扩大交付范围。

高级层级导入是显式 CLI 操作。设置页将其折叠展示，保存于 `jiraSync.hierarchyImport`；
不会影响普通预览、立即同步或定时同步。CLI 使用方式：

```sh
python3 scripts/jira-monitor.py --config data/jira-monitor/config.json \
  --project-settings /workspace/project/.automaker/settings.json --plan-jira-tree AIP-123
```

只有检查计划并显式执行 `--import-jira-tree AIP-123 --apply` 才会写入。
旧的顶层 `executionUnit/worktreeScope` 仅作为兼容值保留，普通同步忽略它们。

## 从旧 monitor 迁移

页面发现 `DATA_DIR/jira-monitor/config.json` 的 `projectPath` 与当前项目一致时，
可点「迁移并接管现有同步」。此功能适用于原有 systemd 安装：

- 停用 `automaker-jira-monitor.timer`，等待当前 oneshot 结束；若还在运行则提示重试。
- 在旧 `monitor.lock` 下备份配置及完整 state，复制所有 jobs、任务 ID、问题评论
  和完成回写标记、missingFeatures 等字段，保留原文件。
- 写入旧目录的 `managed-by-automaker.json`，旧 CLI 即使被手动启动也不会再次轮询。
- 将非敏感配置保存到项目 `.automaker/settings.json` 的 `jiraSync`，
  将凭据路径、worker 配置、state、运行记录保存到服务端
  `DATA_DIR/jira-sync/<project-path-hash>/`（权限 0600）。
- 新 scheduler 启用后按原轮询间隔安排下一轮；迁移动作本身不派发任务。

迁移幂等，重复调用不会丢弃新状态。若迁移中断，保持旧 timer 暂停，从页面重试。
回退需先暂停 Automaker 同步并确认无 worker 持锁，再核对最新状态与备份；
不要直接重新启用旧 timer，旧调度器的状态治理逻辑与新版本不同。

## 重置一个 Work

在 **Work Board** 的 Jira Work 卡片右上角（表格视图的操作栏也可使用），或
「Jira 同步 → 任务映射与派发状态」选择 **重置 Work**，先预览最新 Jira 标题、新分支、旧
Worktree 和未提交修改，再明确确认。操作停止旧预览、归档旧任务、强制移除旧
Worktree，并从最新 Jira 父任务及已有子任务创建独立的新任务、新分支和 Worktree；
新任务在 Backlog，不沿用旧 Agent 会话、验收或派发 claim。旧任务历史保留在归档，
不会改动 Jira、远端分支或 MR。运行中的 Agent、被其他卡使用的分支、Jira 身份变化
和过期的预览快照都会阻止重置；中途失败时检查新任务和目录后再处理，不能盲目重试。

## 状态与幂等边界

- 唯一身份为 Jira 实例 URL、不可变 issue ID、Automaker 项目路径。新卡 ID 不含标签；
  旧卡按 Jira key/site 认领，保持原卡 ID、分支和 worktree；歧义匹配显示阻塞。
- 已删除或已折叠到父任务的旧卡不会被再次创建。旧的 uncertain 派发也不会自动重放。
- 已有卡片只更新 Jira 字段。Agent 执行状态、错误、模型、会话、summary、
  验收结果和人工决定保持不变。已开始任务的需求变化存为 `jiraPendingDescription`，
  卡片显示「需求已更新」，用户通过 Reply 决定如何续做。
- Jira `jiraStatus` 与 Automaker `status` 独立。同步器不运行旧脚本中的状态修复 pass。
- 新执行携带 `executionRunId`，Agent 必须写进 feature-scoped `jira-result.json`。
  同步器只接收与卡片当前运行 ID 相同的回执；迁移前无 run ID 的回执保留但不回写。
- 派发前持久化 claim；进程超时或 API 响应不确定时保留 claim，禁止盲目重发。
- 每项目只运行一个 worker，新旧调度共用文件锁。服务重启将未结束记录标为
  interrupted，claim 保留。重试只重新查询/规划；已经认领的执行不会重复触发。

配置只能来自显式字段白名单，API 不接受命令或凭据文件路径。worker 使用参数数组
执行 CLI，输出为结构化 JSON；可能包含凭据的 CLI stderr 不进入 UI 日志。

## API

以下接口均要求 Automaker 正常认证及合法 `projectPath`：

| POST 路径                | 请求                   | 返回                                          |
| ------------------------ | ---------------------- | --------------------------------------------- |
| `/api/jira-sync/status`  | `projectPath`          | config、runs、jobs、nextRunAt、migration 状态 |
| `/api/jira-sync/save`    | `projectPath, config`  | 已保存状态                                    |
| `/api/jira-sync/migrate` | `projectPath`          | 迁移结果                                      |
| `/api/jira-sync/test`    | `projectPath, config?` | 后台 run                                      |
| `/api/jira-sync/preview` | `projectPath, config?` | 后台 run                                      |
| `/api/jira-sync/sync`    | `projectPath`          | 使用已保存配置的后台 run                      |

run 查询通过 status 轮询；最多保留 50 条运行记录，任务自身保留最近 30 条字段更新记录。
服务器需 Python 3、Git、Jira CLI。`JIRA_CLI_PATH` 可覆盖默认 `/usr/local/bin/jira`。
调度由单个 Automaker API 实例持有；本版本不提供多实例高可用调度和网页 token 登录。
本机 k3s 验证策略的图形配置属于下一阶段，现有截图回填能力保持可用。
