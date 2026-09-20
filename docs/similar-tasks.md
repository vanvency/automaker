# 相似任务与覆盖清理

入口为 **Work Board → Similar Works**，可通过页面顶部返回 Work Board。
页面只在当前项目的独立父任务／大任务点之间发现重叠，比较原始需求与交付说明。
子任务、父子配对和同一父任务的兄弟卡片不参与比较，手动选择也只列出大任务。
父级未导入或已归档时，具有父级关联的子任务仍被排除，不会上升为独立候选。
识别包括父卡 ID、Jira 父级与 Epic 关联、父卡子任务清单及旧 `-child-N` 命名。
候选分数使用标题关键词和需求词汇重叠（支持中文双字词），排除共用 Agent
指令、交付模板和错误日志。它是候选发现工具，不是语义覆盖证明或实现验收。
没有出现在候选列表的任务也可手动选择。

点击候选的 **Compare Descriptions**，或页首 **Compare Any Two Tasks**，
可任选两个独立父任务，在左右两栏分别滚动阅读完整描述。支持切换为提取的需求正文、
交换左右两侧；比较不要求填写覆盖理由，也不会创建清理计划。核对后可选择保留哪一方，
再进入独立的清理预览流程。

## 操作流程

1. 选择保留任务、被覆盖任务，写明覆盖理由和已核对的验收项。
2. 点击 **生成清理预览**。服务器读取双方任务、MR 和 Jira 当前状态，
   列出可关闭与必须保留的资源。生成预览不修改卡片、GitLab 或 Jira。
3. 勾选要关闭的 MR、是否关闭 Jira；Jira 流转从实际工作流的终态选项中选择。
   MR/Jira 默认不勾选，允许只归档卡片。Jira 已结束时无需再次流转。
4. 输入被覆盖任务的 Jira Key（无 Jira 时输入卡片 ID）确认，再执行清理。
5. 执行顺序：检查并锁定卡片 → 关闭并复核所选 MR → 流转并复核 Jira →
   归档卡片并记录 `supersededBy`。保留任务的状态不会因此变成已完成。

完成后被覆盖卡片进入 `completed` 归档，显示“已由 AIP-xxx 覆盖”，它表示
人工确认不再独立交付，并非证明被覆盖任务已独立实现。同步器和 Agent 执行入口
均排除被覆盖任务；历史会话、验收图、worktree 和分支保留。

## 保护与失败恢复

- 运行中的任务、活跃 herdr 会话、未处理的子卡及依赖关系阻止整合。
- 只关闭被覆盖任务的独占、仍 opened 且 source branch 与卡片一致的 MR。
  其他卡片引用的 MR、共用分支、已合并/关闭或无法查明归属的 MR 都保留。
  不删除 MR，不回滚已合并代码，不自动删分支或 worktree。
- 提交前再次核对卡片快照、MR SHA/分支及 Jira 更新时间；变化时要求重新预览。
- 计划 30 分钟有效。开始后选项锁定，结果持久化在
  `DATA_DIR/task-consolidation/<project-hash>/<plan-id>.json`（0600）。
- 失败显示 `partial`，任务保持清理锁，已成功步骤不重做。继续时先核对外部真实状态，
  可从响应丢失中恢复。也可输入 Key 后取消剩余清理，释放卡片锁；
  已完成的外部关闭操作不会回滚。执行中的 HTTP 请求不可并发取消。

## 认证与范围

GitLab 主机必须匹配项目 Jira 同步配置的 `gitlabHost`，使用服务端
`GITLAB_TOKEN` 或 `GITLAB_TOKEN_FILE`（默认 `/root/gitlab-token`）。
Jira 站点必须匹配项目配置和服务端 Jira CLI 配置。
Jira REST 支持服务端 `JIRA_API_TOKEN`（默认 Bearer；basic 需设置
`JIRA_AUTH_TYPE=basic` 和 `JIRA_USER`），或现有 `.netrc` 对应主机登录。
凭据不发到浏览器。

终态流转存在必填且无默认值字段时，不提供快捷关闭，需在 Jira 手动处理。
没有权限或认证失败时，预览显示原因，仍可选择仅归档卡片。
不会自动发表评论、修改描述/指派人、设置 resolution 或创建 Jira 关联链接；
覆盖关系及理由保存于 Automaker 的任务与整合历史。

API：`POST /api/task-consolidation/list|plan|apply|cancel`，
均使用正常 Automaker 认证与合法 `projectPath`。
`plan` 需要 `keepId, retireId, reason`；`apply` 需要 `planId, confirmation,
selection: {mrUrls, closeJira, transitionId?}`；cancel 需要 `planId, confirmation`。

首次接入后的现有 AIP 示例只做了只读发现/预览，用户在界面确认前不会清理任何资源。
